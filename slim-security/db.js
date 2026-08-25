// Uses Node's built-in SQLite module (no native compilation required —
// this avoids the Visual Studio / build-tools requirement that
// better-sqlite3 needs on Windows). Available in Node 22.5+.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'data.sqlite'));

db.exec(`
  CREATE TABLE IF NOT EXISTS appointments (
    id TEXT PRIMARY KEY,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT NOT NULL,
    zip TEXT NOT NULL,
    package TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    preferred_date TEXT,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'pending_payment', -- pending_payment | scheduled | paid | canceled
    hold_expires_at TEXT, -- while pending_payment, the install date is reserved until this timestamp
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_appointments_preferred_date ON appointments(preferred_date);

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
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    appointment_id TEXT NOT NULL,
    provider TEXT NOT NULL,           -- 'stripe_card' | 'stripe_ach_plaid'
    provider_ref TEXT,                -- Stripe PaymentIntent id
    amount_cents INTEGER NOT NULL,
    status TEXT NOT NULL,             -- requires_payment_method | processing | succeeded | failed
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (appointment_id) REFERENCES appointments(id)
  );
`);

// Lightweight migration: if you're upgrading from an older copy of this
// project whose data.sqlite predates the hold_expires_at column, add it.
const existingColumns = db.prepare('PRAGMA table_info(appointments)').all().map((c) => c.name);
if (!existingColumns.includes('hold_expires_at')) {
  db.exec('ALTER TABLE appointments ADD COLUMN hold_expires_at TEXT');
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
