import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  console.error(
    `Plate needs Node.js 22.13 or newer (it uses the built-in SQLite). You are running ${process.version}.\n` +
      'Run it with Docker (see README.md) or install a newer Node.js.',
  );
  process.exit(1);
}

function openDatabase() {
  try {
    fs.mkdirSync(path.join(DATA_DIR, 'photos'), { recursive: true });
    return new DatabaseSync(path.join(DATA_DIR, 'plate.db'));
  } catch (err) {
    console.error(
      `Plate can't write to its data folder (${DATA_DIR}): ${err.message}\n` +
        'If that is a folder on your server mounted into the container, make it writable for the app:\n' +
        '  chown -R 1000:1000 <that folder>',
    );
    process.exit(1);
  }
}

export const db = openDatabase();
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

// Each entry upgrades the schema by one version. Never edit a shipped entry; append a new one.
const MIGRATIONS = [
  `
  CREATE TABLE users (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    name_key   TEXT NOT NULL UNIQUE,
    pass_hash  TEXT NOT NULL,
    is_admin   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  -- Per-person JSON documents: profile (goals, preferences), plan (routines + week), custom (own exercises).
  CREATE TABLE user_docs (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, key)
  );

  -- "day" is the calendar date on the person's phone (YYYY-MM-DD), so totals follow their timezone.
  CREATE TABLE meals (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id         TEXT NOT NULL,
    day        TEXT NOT NULL,
    ts         INTEGER NOT NULL,
    name       TEXT NOT NULL,
    calories   REAL NOT NULL,
    protein    REAL NOT NULL,
    carbs      REAL NOT NULL,
    fat        REAL NOT NULL,
    items      TEXT NOT NULL DEFAULT '[]',
    note       TEXT NOT NULL DEFAULT '',
    source     TEXT NOT NULL DEFAULT 'manual',
    has_photo  INTEGER NOT NULL DEFAULT 0,
    meta       TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  );
  CREATE INDEX meals_day ON meals(user_id, day);

  -- "data" holds the whole workout; weights inside it are kilograms.
  CREATE TABLE workouts (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id          TEXT NOT NULL,
    day         TEXT NOT NULL,
    started_at  INTEGER NOT NULL,
    finished_at INTEGER NOT NULL,
    name        TEXT NOT NULL,
    data        TEXT NOT NULL,
    set_count   INTEGER NOT NULL DEFAULT 0,
    volume      REAL NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  );
  CREATE INDEX workouts_started ON workouts(user_id, started_at);

  -- One row per logged set, derived from workouts.data, so "last time" and records are cheap to look up.
  CREATE TABLE workout_sets (
    user_id    INTEGER NOT NULL,
    workout_id TEXT NOT NULL,
    ex_id      TEXT NOT NULL,
    idx        INTEGER NOT NULL,
    weight     REAL NOT NULL,
    reps       INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    day        TEXT NOT NULL,
    FOREIGN KEY (user_id, workout_id) REFERENCES workouts(user_id, id) ON DELETE CASCADE
  );
  CREATE INDEX sets_exercise ON workout_sets(user_id, ex_id, started_at);
  CREATE INDEX sets_workout ON workout_sets(user_id, workout_id);

  CREATE TABLE weights (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day     TEXT NOT NULL,
    kg      REAL NOT NULL,
    PRIMARY KEY (user_id, day)
  );

  -- Instance-wide settings (AI provider and keys, invite code).
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE ai_usage (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day     TEXT NOT NULL,
    count   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
  );
  `,
];

{
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

const statements = new Map();

/** Prepared statement for `sql`, compiled once and reused. */
export function q(sql) {
  let stmt = statements.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    statements.set(sql, stmt);
  }
  return stmt;
}

/** Run `fn` inside a transaction. Not re-entrant. */
export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function parse(json, fallback) {
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

export function getSetting(key, fallback = null) {
  const row = q('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? parse(row.value, fallback) : fallback;
}

export function setSetting(key, value) {
  q('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    JSON.stringify(value),
  );
}

export function getDoc(userId, key, fallback = null) {
  const row = q('SELECT value FROM user_docs WHERE user_id = ? AND key = ?').get(userId, key);
  return row ? parse(row.value, fallback) : fallback;
}

export function putDoc(userId, key, value) {
  q(
    `INSERT INTO user_docs (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(userId, key, JSON.stringify(value), Date.now());
}

export { parse as parseJson };
