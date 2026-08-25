require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuid } = require('uuid');
const Stripe = require('stripe');
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 4242;

// ---------- Package catalog (source of truth for pricing lives on the server) ----------
const PACKAGES = {
  Starter: { amount_cents: 39900, label: 'Starter' },
  Essential: { amount_cents: 69900, label: 'Essential' },
  Complete: { amount_cents: 119900, label: 'Complete' },
};

// ---------- Booking capacity ----------
// How many installs the crew can handle on a single day. Raise this if you
// add more install crews.
const DAILY_CAPACITY = 1;
// A booking "holds" its date while payment is in progress, so two people
// can't both grab the last slot on a date at the same time. If payment
// isn't completed within this window, the hold expires and the date opens
// back up automatically (no cleanup job needed — the availability query
// below just stops counting expired holds).
const HOLD_MINUTES = 20;

// ---------- Stripe ----------
if (!process.env.STRIPE_SECRET_KEY) {
  console.warn('[warn] STRIPE_SECRET_KEY is not set — Stripe routes will fail until you add it to .env');
}
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');

// ---------- Plaid ----------
const plaidClient = new PlaidApi(
  new Configuration({
    basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID || '',
        'PLAID-SECRET': process.env.PLAID_SECRET || '',
      },
    },
  })
);

// ---------- Stripe webhook needs the RAW body, so it must be registered before express.json() ----------
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  let event = req.body;

  if (process.env.STRIPE_WEBHOOK_SECRET) {
    const sig = req.headers['stripe-signature'];
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error('[stripe webhook] signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
  } else {
    try {
      event = JSON.parse(req.body);
    } catch (e) {
      return res.status(400).send('Invalid payload');
    }
  }

  try {
    switch (event.type) {
      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        markPaymentByProviderRef(pi.id, 'succeeded');
        break;
      }
      case 'payment_intent.payment_failed': {
        const pi = event.data.object;
        markPaymentByProviderRef(pi.id, 'failed');
        break;
      }
      case 'charge.succeeded': {
        const charge = event.data.object;
        if (charge.payment_intent) markPaymentByProviderRef(charge.payment_intent, 'succeeded');
        else markPaymentByProviderRef(charge.id, 'succeeded');
        break;
      }
      case 'charge.failed': {
        const charge = event.data.object;
        if (charge.payment_intent) markPaymentByProviderRef(charge.payment_intent, 'failed');
        else markPaymentByProviderRef(charge.id, 'failed');
        break;
      }
      default:
        break;
    }
  } catch (err) {
    console.error('[stripe webhook] handler error:', err);
  }

  res.json({ received: true });
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
function markPaymentByProviderRef(providerRef, status) {
  const payment = db.prepare('SELECT * FROM payments WHERE provider_ref = ?').get(providerRef);
  if (!payment) return;
  db.prepare('UPDATE payments SET status = ? WHERE id = ?').run(status, payment.id);
  if (status === 'succeeded') {
    db.prepare("UPDATE appointments SET status = 'paid' WHERE id = ?").run(payment.appointment_id);
  } else if (status === 'failed') {
    // Free up the date immediately rather than waiting for the hold to expire.
    db.prepare("UPDATE appointments SET status = 'canceled' WHERE id = ? AND status = 'pending_payment'")
      .run(payment.appointment_id);
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Counts bookings on `date` that currently occupy a slot: either already
// paid, or pending payment with a hold that hasn't expired yet.
function bookingsOnDate(date) {
  const row = db.prepare(`
    SELECT COUNT(*) AS cnt FROM appointments
    WHERE preferred_date = ?
      AND status != 'canceled'
      AND (status = 'paid' OR (status = 'pending_payment' AND hold_expires_at > datetime('now')))
  `).get(date);
  return row.cnt;
}

function isDateAvailable(date) {
  return bookingsOnDate(date) < DAILY_CAPACITY;
}

// ---------- Public config (safe to expose) ----------
app.get('/api/config', (req, res) => {
  res.json({
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
    packages: PACKAGES,
  });
});

// ---------- Availability ----------
// Returns which dates in [from, to] are fully booked, so the frontend can
// grey them out in the date picker. Dates are inclusive, format YYYY-MM-DD.
app.get('/api/availability', (req, res) => {
  const { from, to } = req.query;
  if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '')) {
    return res.status(400).json({ error: 'from and to must be YYYY-MM-DD.' });
  }

  const rows = db.prepare(`
    SELECT preferred_date, COUNT(*) AS cnt FROM appointments
    WHERE preferred_date BETWEEN ? AND ?
      AND status != 'canceled'
      AND (status = 'paid' OR (status = 'pending_payment' AND hold_expires_at > datetime('now')))
    GROUP BY preferred_date
    HAVING cnt >= ?
  `).all(from, to, DAILY_CAPACITY);

  res.json({ unavailableDates: rows.map((r) => r.preferred_date), dailyCapacity: DAILY_CAPACITY });
});

// ---------- Leads (customers who just want a quote, no date/payment yet) ----------
app.post('/api/leads', (req, res) => {
  const { firstName, lastName, phone, email, zip, interestedPackage, notes } = req.body || {};

  if (!firstName || !lastName || !phone || !email || !zip) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  const id = uuid();
  db.prepare(`
    INSERT INTO leads (id, first_name, last_name, phone, email, zip, interested_package, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, firstName, lastName, phone, email, zip, interestedPackage || null, notes || null);

  res.json({ leadId: id });
});

app.get('/api/admin/leads', (req, res) => {
  const rows = db.prepare('SELECT * FROM leads ORDER BY created_at DESC').all();
  res.json(rows);
});

// ---------- Appointments ----------
app.post('/api/appointments', (req, res) => {
  const { firstName, lastName, phone, email, zip, package: pkg, preferredDate, notes } = req.body || {};

  if (!firstName || !lastName || !phone || !email || !zip || !pkg) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }
  const packageInfo = PACKAGES[pkg];
  if (!packageInfo) {
    return res.status(400).json({ error: 'Unknown package.' });
  }
  if (!DATE_RE.test(preferredDate || '')) {
    return res.status(400).json({ error: 'Please choose an install date.' });
  }
  const today = new Date().toISOString().slice(0, 10);
  if (preferredDate < today) {
    return res.status(400).json({ error: 'That date has already passed — please choose an upcoming date.' });
  }

  // Re-check availability right before inserting to close the race window
  // as tightly as SQLite's single-writer model allows.
  if (!isDateAvailable(preferredDate)) {
    return res.status(409).json({ error: 'That install date just got booked by someone else — please pick another date.' });
  }

  const id = uuid();
  db.prepare(`
    INSERT INTO appointments (id, first_name, last_name, phone, email, zip, package, amount_cents, preferred_date, notes, status, hold_expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_payment', datetime('now', '+${HOLD_MINUTES} minutes'))
  `).run(id, firstName, lastName, phone, email, zip, pkg, packageInfo.amount_cents, preferredDate, notes || null);

  res.json({ appointmentId: id, amountCents: packageInfo.amount_cents, holdMinutes: HOLD_MINUTES });
});

app.get('/api/appointments/:id', (req, res) => {
  const appt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(req.params.id);
  if (!appt) return res.status(404).json({ error: 'Not found' });
  res.json(appt);
});

// Simple admin listing — in production, put real auth in front of this route.
app.get('/api/admin/appointments', (req, res) => {
  const rows = db.prepare('SELECT * FROM appointments ORDER BY created_at DESC').all();
  res.json(rows);
});
app.get('/api/admin/payments', (req, res) => {
  const rows = db.prepare('SELECT * FROM payments ORDER BY created_at DESC').all();
  res.json(rows);
});

// ---------- Stripe: card and Apple Pay ----------
// Both the dedicated Card fields and the Apple Pay button on the frontend
// confirm against this same PaymentIntent — Apple Pay decrypts to a card
// payment method under the hood, so restricting to ['card'] covers both
// while keeping them as two visually distinct choices for the customer
// (rather than Stripe's bundled Payment Element, which mixes them into one
// box).
app.post('/api/create-payment-intent', async (req, res) => {
  try {
    const { appointmentId } = req.body || {};
    const appt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(appointmentId);
    if (!appt) return res.status(404).json({ error: 'Appointment not found' });

    const paymentIntent = await stripe.paymentIntents.create({
      amount: appt.amount_cents,
      currency: 'usd',
      payment_method_types: ['card'],
      metadata: { appointmentId: appt.id, package: appt.package },
      receipt_email: appt.email,
    });

    db.prepare(`
      INSERT INTO payments (id, appointment_id, provider, provider_ref, amount_cents, status)
      VALUES (?, ?, 'stripe_card', ?, ?, ?)
    `).run(uuid(), appt.id, paymentIntent.id, appt.amount_cents, paymentIntent.status);

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error('[create-payment-intent]', err);
    res.status(500).json({ error: err.message });
  }
});

// Apple Pay requires you to host Stripe's domain-association file at this exact path.
// Download it from the Stripe Dashboard (Settings -> Payment methods -> Apple Pay -> Add a new domain)
// and drop it in /public/.well-known/apple-developer-merchantid-domain-association
// Express's static middleware above already serves /public, so no extra route is needed
// once that file exists.

// ---------- Plaid: link a bank account, then charge it via Stripe ACH ----------
app.post('/api/plaid/create-link-token', async (req, res) => {
  try {
    const { appointmentId } = req.body || {};
    const appt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(appointmentId);
    if (!appt) return res.status(404).json({ error: 'Appointment not found' });

    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: appt.id },
      client_name: 'Slim Security',
      products: ['auth'],
      country_codes: ['US'],
      language: 'en',
    });
    res.json({ linkToken: response.data.link_token });
  } catch (err) {
    console.error('[plaid create-link-token]', err.response?.data || err);
    res.status(500).json({ error: 'Could not create Plaid link token' });
  }
});

app.post('/api/plaid/pay', async (req, res) => {
  try {
    const { appointmentId, publicToken, accountId } = req.body || {};
    const appt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(appointmentId);
    if (!appt) return res.status(404).json({ error: 'Appointment not found' });

    // 1. Exchange the Plaid public_token for an access_token
    const exchangeResp = await plaidClient.itemPublicTokenExchange({ public_token: publicToken });
    const accessToken = exchangeResp.data.access_token;

    // 2. Turn the linked bank account into a Stripe bank account token via Plaid's processor endpoint
    const processorResp = await plaidClient.processorStripeBankAccountTokenCreate({
      access_token: accessToken,
      account_id: accountId,
    });
    const bankAccountToken = processorResp.data.stripe_bank_account_token;

    // 3. Attach it to a Stripe customer and charge it (ACH debit — settles in a few business days)
    const customer = await stripe.customers.create({
      email: appt.email,
      name: `${appt.first_name} ${appt.last_name}`,
      source: bankAccountToken,
    });

    const charge = await stripe.charges.create({
      amount: appt.amount_cents,
      currency: 'usd',
      customer: customer.id,
      description: `Slim Security — ${appt.package} package (appointment ${appt.id})`,
      metadata: { appointmentId: appt.id, package: appt.package },
    });

    db.prepare(`
      INSERT INTO payments (id, appointment_id, provider, provider_ref, amount_cents, status)
      VALUES (?, ?, 'stripe_ach_plaid', ?, ?, ?)
    `).run(uuid(), appt.id, charge.id, appt.amount_cents, charge.status === 'succeeded' ? 'succeeded' : 'processing');

    if (charge.status === 'succeeded') {
      db.prepare("UPDATE appointments SET status = 'paid' WHERE id = ?").run(appt.id);
    }

    res.json({ status: charge.status });
  } catch (err) {
    console.error('[plaid/pay]', err.response?.data || err);
    res.status(500).json({ error: err.message || 'Bank payment failed' });
  }
});

app.listen(PORT, () => {
  console.log(`Slim Security server running on http://localhost:${PORT}`);
});
