import {
  ApiError,
  ensureAuthSchema,
  getAuthContext,
  getClient,
  sendApiError,
  sendError
} from '../lib/auth.js';

const RECORD_TYPES = new Set(['Incident Report', 'Meeting Minutes', 'Attendance']);

function canReadType(role, type) {
  if (role === 'superadmin' || role === 'secretary' || role === 'viewer') return true;
  if (role === 'disciplinary') return type === 'Incident Report' || type === 'Meeting Minutes';
  return role === 'attendance' && type === 'Attendance';
}

function canWriteType(role, type) {
  if (role === 'superadmin' || role === 'secretary') return true;
  if (role === 'disciplinary') return type === 'Incident Report' || type === 'Meeting Minutes';
  return role === 'attendance' && type === 'Attendance';
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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const method = req.method || 'GET';
  if (!['GET', 'POST', 'DELETE'].includes(method)) {
    res.setHeader('Allow', 'GET, POST, DELETE');
    return sendError(res, 405, 'Method not allowed.');
  }

  try {
    const db = getClient();
    await ensureAuthSchema(db);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY,
        type TEXT,
        date TEXT,
        title TEXT,
        status TEXT,
        recorder TEXT,
        details TEXT,
        created_at TEXT
      )
    `);

    const admin = await getAuthContext(req, db);
    if (!admin) return sendError(res, 401, 'Please sign in again.');
    if (admin.purpose !== 'session' || admin.mustSetPin) {
      return sendError(res, 403, 'Complete PIN setup before accessing records.');
    }

    if (method === 'GET') {
      const result = await db.execute('SELECT * FROM records ORDER BY created_at DESC');
      const rows = result.rows.filter(row => canReadType(admin.role, String(row.type))).map(row => ({
        id: row.id,
        type: row.type,
        date: row.date,
        title: row.title,
        status: row.status,
        recorder: row.recorder,
        details: row.details,
        created_at: row.created_at
      }));
      return res.status(200).json(rows);
    }

    if (method === 'POST') {
      const record = requestBody(req);
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        return sendError(res, 400, 'Request body must be a record object.');
      }
      if (!record.id || typeof record.type !== 'string' || !RECORD_TYPES.has(record.type) || !record.date || !record.title) {
        return sendError(res, 400, 'A valid record type, id, date and title are required.');
      }
      if (!canWriteType(admin.role, String(record.type))) {
        return sendError(res, 403, 'Your role cannot create or update this record type.');
      }

      await db.execute({
        sql: `INSERT OR REPLACE INTO records
          (id, type, date, title, status, recorder, details, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          String(record.id),
          String(record.type),
          String(record.date),
          String(record.title),
          record.status == null ? '' : String(record.status),
          record.recorder == null ? '' : String(record.recorder),
          record.details == null ? '' : String(record.details),
          record.created_at ? String(record.created_at) : new Date().toISOString()
        ]
      });
      return res.status(200).json({ success: true });
    }

    const id = typeof req.query?.id === 'string' ? req.query.id.trim() : '';
    if (!id) return sendError(res, 400, 'A record id query parameter is required.');

    const existing = await db.execute({ sql: 'SELECT type FROM records WHERE id = ?', args: [id] });
    if (existing.rows.length && !canWriteType(admin.role, String(existing.rows[0].type))) {
      throw new ApiError(403, 'Your role cannot delete this record type.');
    }
    await db.execute({ sql: 'DELETE FROM records WHERE id = ?', args: [id] });
    return res.status(200).json({ success: true });
  } catch (error) {
    return sendApiError(res, error);
  }
}
