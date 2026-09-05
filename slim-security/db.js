// Uses Node's built-in SQLite module (no native compilation required —
// this avoids the Visual Studio / build-tools requirement that
// better-sqlite3 needs on Windows). Available in Node 22.5+.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

// On most cloud hosts (Render, Railway, etc.) everything outside a mounted
// persistent disk is wiped on every redeploy/restart. Set DB_PATH to a file
// inside that mounted disk in production (e.g. /data/data.sqlite) so your
// leads/visits survive deploys. Locally it just defaults to a file right
// next to this script.
const dbPath = process.env.DB_PATH || path.join(__dirname, 'data.sqlite');
const db = new DatabaseSync(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT NOT NULL,
    zip TEXT NOT NULL,
    interested_package TEXT,   -- usually 'Not sure yet', but kept flexible
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'new', -- new | contacted | converted | closed
    session_id TEXT,           -- ties this lead back to its /admin/visits row, when known
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- One row per visitor session (a browser tab's time on the site). Updated
  -- in place (not appended) as the visit continues, via periodic + on-exit
  -- beacons from the page, so total_seconds/sections_json always reflect the
  -- latest known state of that visit even if the visitor never closes the tab.
  CREATE TABLE IF NOT EXISTS visits (
    session_id TEXT PRIMARY KEY,
    referrer TEXT,
    landing_path TEXT,
    user_agent TEXT,
    screen_w INTEGER,
    screen_h INTEGER,
    total_seconds INTEGER NOT NULL DEFAULT 0,
    sections_json TEXT,               -- JSON: { sectionId: secondsVisible }
    clicks_json TEXT,                 -- JSON: { ctaLabel: clickCount }
    converted INTEGER NOT NULL DEFAULT 0, -- 1 once this session submits the form
    first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Lightweight migration: if you're upgrading from a copy of this project that had the
// visits table before clicks_json was added, add the column now.
const existingVisitColumns = db.prepare('PRAGMA table_info(visits)').all().map((c) => c.name);
if (!existingVisitColumns.includes('clicks_json')) {
  db.exec('ALTER TABLE visits ADD COLUMN clicks_json TEXT');
}

// Same idea: if you're upgrading from a copy of this project that had the
// leads table before session_id was added (lets /admin/visits show the
// submitted name/phone/zip right on the matching visit row).
const existingLeadColumns = db.prepare('PRAGMA table_info(leads)').all().map((c) => c.name);
if (!existingLeadColumns.includes('session_id')) {
  db.exec('ALTER TABLE leads ADD COLUMN session_id TEXT');
}

// Thin wrapper that mimics the handful of better-sqlite3 methods server.js
// relies on (`.get()` / `.all()` / `.run()` on a prepared statement), so the
// rest of the codebase doesn't need to change.
module.exports = {
  prepare(sql) {
    const stmt = db.prepare(sql);
    return {
      get: (...args) => stmt.get(...args),
      all: (...args) => stmt.all(...args),
      run: (...args) => stmt.run(...args),
    };
  },
  exec: (sql) => db.exec(sql),
};
