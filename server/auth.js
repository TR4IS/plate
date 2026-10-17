import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { q } from './db.js';
import { isHttps } from './http.js';

const scrypt = promisify(crypto.scrypt);

const COOKIE = 'plate_sid';
const SESSION_MAX_IDLE_MS = 180 * 24 * 3600 * 1000;
const COOKIE_MAX_AGE_S = 400 * 24 * 3600;
const TOUCH_INTERVAL_MS = 3600 * 1000;

export const MIN_PASSWORD = 8;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, saltB64, keyB64] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

/** Display name as typed, plus the key used to look the account up (case and spacing ignored). */
export function normalizeName(raw) {
  const name = typeof raw === 'string' ? raw.normalize('NFKC').replace(/\s+/g, ' ').trim() : '';
  return { name, key: name.toLowerCase() };
}

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  q('INSERT INTO sessions (token_hash, user_id, created_at, last_seen) VALUES (?, ?, ?, ?)').run(
    sha256(token),
    userId,
    now,
    now,
  );
  return token;
}

function readToken(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === COOKIE) return part.slice(eq + 1).trim();
  }
  return null;
}

/** The signed-in user for this request, or null. */
export function userFromRequest(req) {
  const token = readToken(req);
  if (!token) return null;
  const hash = sha256(token);
  const row = q(
    `SELECT u.id, u.name, u.is_admin, s.last_seen
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
  ).get(hash);
  if (!row) return null;
  const now = Date.now();
  if (now - row.last_seen > SESSION_MAX_IDLE_MS) {
    q('DELETE FROM sessions WHERE token_hash = ?').run(hash);
    return null;
  }
  if (now - row.last_seen > TOUCH_INTERVAL_MS) q('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(now, hash);
  return { id: row.id, name: row.name, isAdmin: row.is_admin === 1, sessionHash: hash };
}

export function sessionCookie(req, token) {
  const secure = isHttps(req) ? '; Secure' : '';
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_S}${secure}`;
}

export function clearedCookie(req) {
  const secure = isHttps(req) ? '; Secure' : '';
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export function endSession(sessionHash) {
  q('DELETE FROM sessions WHERE token_hash = ?').run(sessionHash);
}

export function endOtherSessions(userId, keepHash) {
  q('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(userId, keepHash);
}

export function newInviteCode() {
  // Unambiguous characters only, so it can be read out loud or typed from a screenshot.
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (const byte of crypto.randomBytes(8)) code += alphabet[byte % alphabet.length];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

// ---- in-memory rate limiting -------------------------------------------------------------

const windows = new Map();

/** Counts one attempt for `key`. Returns 0 if allowed, otherwise the seconds to wait. */
export function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const recent = (windows.get(key) || []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    windows.set(key, recent);
    return Math.max(1, Math.ceil((windowMs - (now - recent[0])) / 1000));
  }
  recent.push(now);
  windows.set(key, recent);
  return 0;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, times] of windows) {
    if (times.every((t) => now - t > 3600 * 1000)) windows.delete(key);
  }
  q('DELETE FROM sessions WHERE last_seen < ?').run(now - SESSION_MAX_IDLE_MS);
}, 15 * 60 * 1000).unref();
