# Slim Security — booking + payments backend

Adds appointment booking, Stripe (card + Apple Pay) payments, and Plaid-linked
bank account (ACH) payments to the Slim Security site.

## What's included

- `public/index.html` — the site, now with a booking flow: the quote form
  creates an appointment, then shows a payment step (card/Apple Pay via
  Stripe, or bank account via Plaid).
- `server.js` — Express backend with all the API routes.
- `db.js` — SQLite schema (via Node's built-in `node:sqlite` module — no
  native compilation/build tools required) for `appointments` and
  `payments`. Data is stored in `data.sqlite`, created automatically. You'll
  see an `ExperimentalWarning: SQLite is an experimental feature` line on
  startup — that's expected and harmless, just Node's own labeling of the
  module. Requires Node 22.5+.
- `.env.example` — copy to `.env` and fill in your real keys.

## 1. Install

```bash
npm install
cp .env.example .env
```

## 2. Add your Stripe keys

1. Get test keys from https://dashboard.stripe.com/test/apikeys
2. Put them in `.env`:
   ```
   STRIPE_SECRET_KEY=sk_test_...
   STRIPE_PUBLISHABLE_KEY=pk_test_...
   ```
3. For Apple Pay specifically, Stripe also requires:
   - A **live HTTPS domain** (Apple Pay will not work on `localhost` or
     `http://`).
   - Registering that domain in the Stripe Dashboard: **Settings → Payment
     methods → Apple Pay → Add a new domain**.
   - Downloading the domain-association file Stripe gives you and saving it
     at `public/.well-known/apple-developer-merchantid-domain-association`
     (Express already serves anything in `public/`, so no extra route is
     needed — just drop the file in).
   - Apple Pay will then appear automatically inside the Payment Element on
     Safari/Chrome on supported Apple devices — no separate UI needed.
4. For webhooks (recommended, so payments get marked "paid" even if the
   customer closes the tab mid-payment): create an endpoint in the Stripe
   Dashboard pointing at `https://your-domain.com/api/stripe/webhook`,
   subscribe to `payment_intent.succeeded`, `payment_intent.payment_failed`,
   `charge.succeeded`, and `charge.failed`, then put the signing secret in
   `.env` as `STRIPE_WEBHOOK_SECRET`. Stripe's CLI (`stripe listen --forward-to
   localhost:4242/api/stripe/webhook`) is the easiest way to test this
   locally.

## 3. Add your Plaid keys

1. Sign up / log in at https://dashboard.plaid.com
2. Get your `client_id` and **sandbox** `secret` from
   https://dashboard.plaid.com/team/keys
3. Put them in `.env`:
   ```
   PLAID_CLIENT_ID=...
   PLAID_SECRET=...
   PLAID_ENV=sandbox
   ```
4. In Plaid's sandbox, use their test credentials to link a fake bank
   account (username `user_good`, password `pass_good` at most sandbox
   institutions) — no real bank account needed until you move to
   `development`/`production`.
5. **Important:** the Plaid → Stripe bank-payment flow used here
   (`processorStripeBankAccountTokenCreate`) requires Stripe's legacy
   Sources/Charges API to be enabled on your Stripe account for bank debits.
   If Stripe has migrated your account off Sources, ask Stripe support to
   enable it, or we can switch this to Stripe's newer **Financial
   Connections + PaymentIntent (us_bank_account)** flow instead — that's a
   bigger change I can make if needed.

## 4. Run it

```bash
npm start
```

Visit http://localhost:4242 — the whole site, including booking and
payment, is served from this one process.

## 5. Deploy it

This is a plain Node/Express app with a local SQLite file, so it runs
anywhere that supports Node: Render, Railway, Fly.io, a VPS, etc. A few
things to change for production:

- Swap SQLite for a hosted database if you expect concurrent writers at
  scale (SQLite is fine for a single-server setup with normal traffic).
- Put real authentication in front of `/api/admin/appointments` and
  `/api/admin/payments` — right now they're open on purpose so you can see
  them working, but they should not be public in production.
- Set `STRIPE_SECRET_KEY` / `PLAID_SECRET` to your **live** keys only once
  you've tested everything in test/sandbox mode.
- Make sure the domain you deploy to is HTTPS (required for Apple Pay and
  good practice generally).

## Availability & booking limits

Only one install is bookable per day by default (`DAILY_CAPACITY` in
`server.js` — raise it if you add a second crew). When a customer picks a
package and starts booking:

- The date picker on the site fetches `/api/availability` and greys out any
  date that's already full — no double-booking is even offered.
- Submitting the form puts a **20-minute hold** on that date
  (`HOLD_MINUTES` in `server.js`) while the customer completes payment, so
  two people can't grab the same last slot at once.
- If payment succeeds, the date is booked for good. If payment fails or the
  customer abandons the page, the hold simply expires and the date opens
  back up automatically — no manual cleanup needed.

## "Not sure yet" quote requests

Picking "Not sure yet — just send me a quote" skips the date/payment flow
entirely, but the customer's info is still saved (via `/api/leads`) into a
separate `leads` table, so nothing is lost even though no appointment or
charge is created. Check `/api/admin/leads` to see them, or query
`data.sqlite` directly. There's no email/SMS notification wired up yet when
one comes in — say the word if you want that added (it'd need an email
provider like Resend/SendGrid, or SMTP credentials for your own email).

## Payment methods

The payment step gives the customer three distinct choices rather than
bundling them into one box:

- **Credit / Debit Card** — Stripe's Card Element, dedicated card number/
  expiry/CVC fields.
- **Apple Pay** — a dedicated Apple Pay button (via Stripe's Payment
  Request Button, which also shows Google Pay automatically on
  Android/Chrome). Only renders if the browser/device actually supports it;
  otherwise the tab shows a note pointing to Card or Bank Account instead.
  Requires the Apple Pay domain verification step described above to work
  on a live site.
- **Bank Account (Plaid)** — links a bank account via Plaid Link, then
  charges it via Stripe ACH.

## API reference

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/config` | Publishable key + package prices (safe to expose) |
| GET | `/api/availability?from=&to=` | Which dates in range are fully booked |
| POST | `/api/appointments` | Create an appointment (booking) |
| GET | `/api/appointments/:id` | Look up one appointment |
| POST | `/api/leads` | Save a "not sure yet" quote request (no date/payment) |
| GET | `/api/admin/appointments` | List all appointments |
| GET | `/api/admin/payments` | List all payment records |
| GET | `/api/admin/leads` | List all quote requests |
| POST | `/api/create-payment-intent` | Start a card/Apple Pay payment |
| POST | `/api/plaid/create-link-token` | Start Plaid Link |
| POST | `/api/plaid/pay` | Exchange Plaid token and charge the bank account |
| POST | `/api/stripe/webhook` | Stripe webhook receiver |

## Pricing lives on the server

Package prices are defined in `server.js` (`PACKAGES` object), not trusted
from the browser — the frontend just tells the server which package name
was picked, and the server looks up the amount. Update prices there if they
change on the site.
