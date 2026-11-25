import {
  ensureAuthSchema,
  getAuthContext,
  getClient,
  sendApiError,
  sendError
} from '../lib/auth.js';

const STATUSES = new Set(['Present', 'Late', 'Excused', 'Absent']);

function canRead(role) {
  return ['superadmin', 'secretary', 'viewer', 'attendance'].includes(role);
}

function canWrite(role) {
  return ['superadmin', 'secretary', 'attendance'].includes(role);
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

function requestBody(req) {
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) return req.body;
  if (typeof req.body === 'string') {
    try {
      const body = JSON.parse(req.body);
      return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
    } catch {
      return null;
    }
  }
  return null;
}

function statePayload(row, date) {
  if (!row) {
    return { date, statuses: {}, version: 0, updatedAt: '', updatedBy: '' };
  }
  let statuses = {};
  try {
    const parsed = JSON.parse(String(row.statuses || '{}'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) statuses = parsed;
  } catch {
    // Ignore malformed legacy data and return an empty roll call.
  }
  return {
    date: String(row.date),
    statuses,
    version: Number(row.version) || 1,
    updatedAt: String(row.updated_at || ''),
    updatedBy: String(row.updated_by || '')
  };
}

function summarize(statuses) {
  return STATUSES ? [...STATUSES].map(status => {
    const count = Object.values(statuses).filter(value => value === status).length;
    return `${status}: ${count}`;
  }).join(', ') : '';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const method = req.method || 'GET';
  if (!['GET', 'POST'].includes(method)) {
    res.setHeader('Allow', 'GET, POST');
    return sendError(res, 405, 'Method not allowed.');
  }

  try {
    const db = getClient();
    await ensureAuthSchema(db);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS roll_calls (
        date TEXT PRIMARY KEY,
        statuses TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      )
    `);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS record_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        record_id TEXT NOT NULL,
        record_type TEXT NOT NULL,
        action TEXT NOT NULL,
        actor_phone TEXT NOT NULL,
        actor_name TEXT NOT NULL,
        actor_role TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      )
    `);

    const admin = await getAuthContext(req, db);
    if (!admin) return sendError(res, 401, 'Please sign in again.');
    if (admin.purpose !== 'session' || admin.mustSetPin) {
      return sendError(res, 403, 'Complete PIN setup before accessing roll calls.');
    }
    if (!canRead(admin.role)) {
      return sendError(res, 403, 'Your role cannot view roll calls.');
    }

    if (method === 'GET') {
      const date = typeof req.query?.date === 'string' ? req.query.date.trim() : '';
      if (!validDate(date)) return sendError(res, 400, 'Provide a valid date (YYYY-MM-DD).');
      const result = await db.execute({ sql: 'SELECT * FROM roll_calls WHERE date = ?', args: [date] });
      return res.status(200).json(statePayload(result.rows[0], date));
    }

    if (!canWrite(admin.role)) {
      return sendError(res, 403, 'Your role cannot update roll calls.');
    }
    const body = requestBody(req);
    if (!body || !validDate(body.date)) {
      return sendError(res, 400, 'Provide a valid date (YYYY-MM-DD).');
    }
    const statuses = body.statuses;
    if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses)) {
      return sendError(res, 400, 'Attendance statuses must be an object.');
    }
    const entries = Object.entries(statuses);
    if (entries.length > 100 || entries.some(([name, value]) => !name || !STATUSES.has(String(value)))) {
      return sendError(res, 400, 'Each member needs a valid status: Present, Late, Excused or Absent.');
    }

    const date = body.date.trim();
    const result = await db.execute({ sql: 'SELECT * FROM roll_calls WHERE date = ?', args: [date] });
    const current = result.rows[0];
    const incomingVersion = Number(body.version);
    if (
      current &&
      Number.isInteger(incomingVersion) &&
      incomingVersion !== (Number(current.version) || 1)
    ) {
      return res.status(409).json({
        success: false,
        error: 'This roll call changed on another device. Refresh before editing again.',
        code: 'VERSION_CONFLICT',
        rollCall: statePayload(current, date)
      });
    }

    const version = current ? (Number(current.version) || 1) + 1 : 1;
    const updatedAt = new Date().toISOString();
    const cleanStatuses = Object.fromEntries(entries.map(([name, value]) => [String(name).slice(0, 100), String(value)]));
    await db.batch([
      {
        sql: `INSERT OR REPLACE INTO roll_calls
          (date, statuses, version, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)`,
        args: [date, JSON.stringify(cleanStatuses), version, updatedAt, admin.phone]
      },
      {
        sql: `INSERT INTO record_audit
          (record_id, record_type, action, actor_phone, actor_name, actor_role, detail, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          `rollcall-${date}`,
          'Attendance',
          current ? 'update' : 'create',
          admin.phone,
          admin.name,
          admin.role,
          `Roll call ${date} — ${summarize(cleanStatuses)}`,
          updatedAt
        ]
      }
    ], 'write');

    return res.status(200).json({ success: true, version });
  } catch (error) {
    return sendApiError(res, error);
  }
}
