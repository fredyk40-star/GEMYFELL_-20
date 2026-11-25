import {
  ensureAuthSchema,
  getAuthContext,
  getClient,
  sendApiError,
  sendError
} from '../lib/auth.js';

// Keep in sync with TEAM_GROUPS in index.html.
const DIRECTORY_MEMBERS = new Set([
  'Brother Emma',
  'Brother Obrepong Danso',
  'Brother Fred',
  'Miss Boahemaa',
  'Miss Ellen Boatemaa',
  'Mrs. Esther Darkwa',
  'Miss Gina',
  'Elder Mark',
  'Mr. Patrick',
  'Brother Steven',
  'Mrs. Janet Ama',
  'Brother Gideon',
  'Brother Arthur'
]);

const DIRECTORY_WRITE_ROLES = new Set(['superadmin', 'secretary']);

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
  if (!['GET', 'POST'].includes(method)) {
    res.setHeader('Allow', 'GET, POST');
    return sendError(res, 405, 'Method not allowed.');
  }

  try {
    const db = getClient();
    await ensureAuthSchema(db);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS committee_phones (
        member_name TEXT PRIMARY KEY,
        phone TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      )
    `);

    const admin = await getAuthContext(req, db);
    if (!admin) return sendError(res, 401, 'Please sign in again.');
    if (admin.purpose !== 'session' || admin.mustSetPin) {
      return sendError(res, 403, 'Complete PIN setup before editing the directory.');
    }

    if (method === 'GET') {
      const result = await db.execute(`
        SELECT member_name, phone FROM committee_phones ORDER BY member_name ASC
      `);
      const phones = {};
      result.rows.forEach(row => {
        const name = String(row.member_name || '');
        const phone = String(row.phone || '');
        if (DIRECTORY_MEMBERS.has(name) && /^\+?\d{7,15}$/.test(phone)) phones[name] = phone;
      });
      return res.status(200).json(phones);
    }

    if (!DIRECTORY_WRITE_ROLES.has(admin.role)) {
      return sendError(res, 403, 'Your role cannot edit committee phone numbers.');
    }

    const body = requestBody(req);
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!DIRECTORY_MEMBERS.has(name)) {
      return sendError(res, 400, 'Unknown committee member.');
    }

    const phone = body.phone == null || body.phone === '' ? '' : String(body.phone).trim();
    if (phone && !/^\+?\d{7,15}$/.test(phone)) {
      return sendError(res, 400, 'Enter a valid phone number (e.g. +233XXXXXXXXX).');
    }

    if (!phone) {
      await db.execute({
        sql: 'DELETE FROM committee_phones WHERE member_name = ?',
        args: [name]
      });
    } else {
      await db.execute({
        sql: `INSERT INTO committee_phones (member_name, phone, updated_at, updated_by)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(member_name) DO UPDATE SET
            phone = excluded.phone,
            updated_at = excluded.updated_at,
            updated_by = excluded.updated_by`,
        args: [name, phone, new Date().toISOString(), admin.phone]
      });
    }
    return res.status(200).json({ success: true });
  } catch (error) {
    return sendApiError(res, error);
  }
}
