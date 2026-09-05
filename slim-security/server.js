require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuid } = require('uuid');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 4242;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Leads (customers who just want a quote) ----------
app.post('/api/leads', (req, res) => {
  const { firstName, lastName, phone, email, zip, interestedPackage, notes, sessionId } = req.body || {};

  if (!firstName || !lastName || !phone || !zip) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  const id = uuid();
  db.prepare(`
    INSERT INTO leads (id, first_name, last_name, phone, email, zip, interested_package, notes, session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, firstName, lastName, phone, email || '', zip, interestedPackage || null, notes || null, sessionId || null);

  res.json({ leadId: id });
});

app.get('/api/admin/leads', (req, res) => {
  const rows = db.prepare('SELECT * FROM leads ORDER BY created_at DESC').all();
  res.json(rows);
});

// ---------- Visitor tracking (time on page + which sections were viewed) ----------
// The site sends a beacon periodically (every 15s) and again right when the
// visitor leaves, each time with the session's running totals. Each beacon
// just overwrites the same row (INSERT ... ON CONFLICT), so this always
// reflects the latest known state of that visit — including visits that are
// still ongoing.
app.post('/api/track', (req, res) => {
  const {
    sessionId, referrer, landingPath, userAgent,
    screenW, screenH, totalSeconds, sections, clicks, converted,
  } = req.body || {};

  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId.' });

  db.prepare(`
    INSERT INTO visits (session_id, referrer, landing_path, user_agent, screen_w, screen_h, total_seconds, sections_json, clicks_json, converted, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(session_id) DO UPDATE SET
      landing_path = excluded.landing_path,
      total_seconds = excluded.total_seconds,
      sections_json = excluded.sections_json,
      clicks_json = excluded.clicks_json,
      converted = MAX(converted, excluded.converted),
      last_seen_at = datetime('now')
  `).run(
    sessionId,
    referrer || null,
    landingPath || null,
    userAgent || null,
    screenW || null,
    screenH || null,
    Math.max(0, Math.round(totalSeconds || 0)),
    JSON.stringify(sections || {}),
    JSON.stringify(clicks || {}),
    converted ? 1 : 0,
  );

  res.status(204).end();
});

app.get('/api/admin/visits', (req, res) => {
  const rows = db.prepare('SELECT * FROM visits ORDER BY last_seen_at DESC').all();

  // Match each visit back to the lead it submitted (if any), so the
  // dashboard can show who this visitor actually was.
  const leadRows = db.prepare(`
    SELECT session_id, first_name, last_name, phone, zip
    FROM leads
    WHERE session_id IS NOT NULL
    ORDER BY created_at ASC
  `).all();
  const leadBySession = {};
  for (const l of leadRows) leadBySession[l.session_id] = l; // last one wins if resubmitted

  const visits = rows.map((r) => {
    const lead = leadBySession[r.session_id];
    return {
      ...r,
      sections: JSON.parse(r.sections_json || '{}'),
      clicks: JSON.parse(r.clicks_json || '{}'),
      submittedInfo: lead ? `${lead.first_name} ${lead.last_name};${lead.phone};${lead.zip}` : null,
    };
  });

  const totalVisits = visits.length;
  const avgSeconds = totalVisits
    ? Math.round(visits.reduce((sum, v) => sum + v.total_seconds, 0) / totalVisits)
    : 0;
  const converted = visits.filter((v) => v.converted).length;
  const sectionTotals = {};
  const ctaTotals = {};
  for (const v of visits) {
    for (const [section, seconds] of Object.entries(v.sections)) {
      sectionTotals[section] = (sectionTotals[section] || 0) + seconds;
    }
    for (const [cta, count] of Object.entries(v.clicks)) {
      ctaTotals[cta] = (ctaTotals[cta] || 0) + count;
    }
  }

  res.json({
    summary: { totalVisits, avgSeconds, converted, sectionTotals, ctaTotals },
    visits,
  });
});

// Delete one or more visit rows (used by the "select + delete" controls on
// /admin/visits.html to clear out test visits and keep only real traffic).
app.delete('/api/admin/visits', (req, res) => {
  const { sessionIds } = req.body || {};
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
    return res.status(400).json({ error: 'sessionIds must be a non-empty array.' });
  }
  const placeholders = sessionIds.map(() => '?').join(',');
  const result = db.prepare(`DELETE FROM visits WHERE session_id IN (${placeholders})`).run(...sessionIds);
  res.json({ deleted: result.changes });
});

app.listen(PORT, () => {
  console.log(`Slim Security server running on http://localhost:${PORT}`);
});
