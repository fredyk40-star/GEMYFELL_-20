import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { createClient } from '@libsql/client';

const scrypt = promisify(scryptCallback);
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SETUP_TTL_MS = 10 * 60 * 1000;
const ROLE_NAMES = new Set(['superadmin', 'secretary', 'disciplinary', 'attendance', 'viewer']);
let client;

export class ApiError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function getClient() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new ApiError(503, 'Cloud database is not configured.');
  client ??= createClient({ url, authToken });
  return client;
}

export async function ensureAuthSchema(db) {
  await db.batch([
    `CREATE TABLE IF NOT EXISTS admins (
      phone TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      pin_hash TEXT,
      temp_password_hash TEXT,
      must_set_pin INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS admin_sessions (
      token_hash TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      purpose TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS auth_attempts (
      phone TEXT PRIMARY KEY,
      window_started_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL,
      locked_until INTEGER NOT NULL DEFAULT 0
    )`
  ], 'write');
}

export function normalizePhone(value) {
  if (typeof value !== 'string') return null;
  const compact = value.trim().replace(/[\s()-]/g, '');
  if (/^0\d{9}$/.test(compact)) return `+233${compact.slice(1)}`;
  if (/^\+233\d{9}$/.test(compact)) return compact;
  return null;
}

export function isValidRole(role, { allowSuperadmin = false } = {}) {
  return ROLE_NAMES.has(role) && (allowSuperadmin || role !== 'superadmin');
}

export async function hashSecret(secret) {
  const salt = randomBytes(16);
  const derived = await scrypt(secret, salt, 64);
  return `scrypt$${salt.toString('hex')}$${Buffer.from(derived).toString('hex')}`;
}

export async function verifySecret(secret, encoded) {
  if (typeof encoded !== 'string') return false;
  const [scheme, saltHex, hashHex] = encoded.split('$');
  if (scheme !== 'scrypt' || !/^[a-f0-9]{32}$/i.test(saltHex || '') || !/^[a-f0-9]{128}$/i.test(hashHex || '')) {
    return false;
  }
  const actual = Buffer.from(await scrypt(secret, Buffer.from(saltHex, 'hex'), 64));
  const expected = Buffer.from(hashHex, 'hex');
  return timingSafeEqual(actual, expected);
}

export function hashSessionToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(db, phone, purpose = 'session') {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + (purpose === 'pin_setup' ? SETUP_TTL_MS : SESSION_TTL_MS)).toISOString();
  await db.execute({
    sql: 'INSERT INTO admin_sessions (token_hash, phone, purpose, expires_at) VALUES (?, ?, ?, ?)',
    args: [hashSessionToken(token), phone, purpose, expiresAt]
  });
  return { token, expiresAt };
}

export function bearerToken(req) {
  const authorization = req.headers?.authorization || '';
  const match = /^Bearer\s+([A-Za-z0-9_-]{40,})$/i.exec(authorization);
  return match ? match[1] : null;
}

export async function getAuthContext(req, db = getClient()) {
  const token = bearerToken(req);
  if (!token) return null;
  const result = await db.execute({
    sql: `SELECT s.phone, s.purpose, a.name, a.role, a.active, a.must_set_pin
      FROM admin_sessions s
      JOIN admins a ON a.phone = s.phone
      WHERE s.token_hash = ? AND s.expires_at > ?`,
    args: [hashSessionToken(token), new Date().toISOString()]
  });
  const session = result.rows[0];
  if (!session || Number(session.active) !== 1) return null;
  return {
    phone: String(session.phone),
    name: String(session.name),
    role: String(session.role),
    purpose: String(session.purpose),
    mustSetPin: Number(session.must_set_pin) === 1,
    tokenHash: hashSessionToken(token)
  };
}

export async function ensureSuperadmin(db) {
  const existing = await db.execute({
    sql: 'SELECT phone FROM admins WHERE role = ? LIMIT 1',
    args: ['superadmin']
  });
  if (existing.rows.length) return;

  const phone = normalizePhone(process.env.SUPERADMIN_PHONE || '');
  const pin = process.env.SUPERADMIN_INITIAL_PIN || '';
  if (!phone || !/^\d{4}$/.test(pin)) {
    throw new ApiError(503, 'Superadmin bootstrap is not configured.');
  }

  const pinHash = await hashSecret(pin);
  try {
    await db.execute({
      sql: `INSERT INTO admins
        (phone, name, role, pin_hash, temp_password_hash, must_set_pin, active, created_at)
        VALUES (?, ?, 'superadmin', ?, NULL, 0, 1, ?)`,
      args: [phone, 'Brother Fred', pinHash, new Date().toISOString()]
    });
  } catch (error) {
    const duplicate = await db.execute({
      sql: 'SELECT phone FROM admins WHERE role = ? LIMIT 1',
      args: ['superadmin']
    });
    if (!duplicate.rows.length) throw error;
  }
}

export async function checkLoginRateLimit(db, phone) {
  const result = await db.execute({
    sql: 'SELECT locked_until FROM auth_attempts WHERE phone = ?',
    args: [phone]
  });
  const lockedUntil = Number(result.rows[0]?.locked_until || 0);
  if (lockedUntil > Date.now()) {
    throw new ApiError(429, 'Too many login attempts. Try again later.');
  }
}

export async function recordLoginFailure(db, phone) {
  const now = Date.now();
  const windowStart = now - 15 * 60 * 1000;
  const result = await db.execute({
    sql: 'SELECT window_started_at, attempts, locked_until FROM auth_attempts WHERE phone = ?',
    args: [phone]
  });
  const current = result.rows[0];
  const attempts = current && Number(current.window_started_at) > windowStart
    ? Number(current.attempts) + 1
    : 1;
  const startedAt = attempts === 1 ? now : Number(current.window_started_at);
  const lockedUntil = attempts >= 8 ? now + 15 * 60 * 1000 : 0;
  await db.execute({
    sql: `INSERT INTO auth_attempts (phone, window_started_at, attempts, locked_until)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(phone) DO UPDATE SET
        window_started_at = excluded.window_started_at,
        attempts = excluded.attempts,
        locked_until = excluded.locked_until`,
    args: [phone, startedAt, attempts, lockedUntil]
  });
}

export async function clearLoginFailures(db, phone) {
  await db.execute({ sql: 'DELETE FROM auth_attempts WHERE phone = ?', args: [phone] });
}

export function sendError(res, statusCode, message) {
  return res.status(statusCode).json({ success: false, error: message });
}

export function sendApiError(res, error) {
  if (error instanceof ApiError) {
    return sendError(res, error.statusCode, error.message);
  }
  console.error('GEMYFELL API error:', error);
  return sendError(res, 500, 'The request could not be completed.');
}

export async function requireSuperadmin(req, db) {
  const context = await getAuthContext(req, db);
  if (!context) throw new ApiError(401, 'Please sign in again.');
  if (context.purpose !== 'session' || context.mustSetPin) throw new ApiError(403, 'Complete sign-in before continuing.');
  if (context.role !== 'superadmin') throw new ApiError(403, 'Superadmin access is required.');
  return context;
}

export function createTemporaryPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const maxByte = 256 - (256 % alphabet.length);
  let result = '';
  while (result.length < 6) {
    const bytes = randomBytes(12);
    for (const byte of bytes) {
      if (byte >= maxByte) continue;
      result += alphabet[byte % alphabet.length];
      if (result.length === 6) break;
    }
  }
  return result;
}

export function publicAdmin(row) {
  return {
    phone: String(row.phone),
    name: String(row.name),
    role: String(row.role),
    active: Number(row.active) === 1,
    createdAt: String(row.created_at)
  };
}
