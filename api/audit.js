import {
  ensureAuthSchema,
  getAuthContext,
  getClient,
  sendApiError,
  sendError
} from '../lib/auth.js';

function canReadType(role, type) {
  if (role === 'superadmin' || role === 'secretary' || role === 'viewer') return true;
  if (role === 'disciplinary') return type === 'Incident Report' || type === 'Meeting Minutes';
  return role === 'attendance' && type === 'Attendance';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if ((req.method || 'GET') !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendError(res, 405, 'Method not allowed.');
  }

  try {
    const db = getClient();
    await ensureAuthSchema(db);
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
      return sendError(res, 403, 'Complete PIN setup before viewing the audit trail.');
    }

    const requested = Number(req.query?.limit);
    const limit = Number.isFinite(requested) ? Math.min(200, Math.max(10, Math.floor(requested))) : 100;
    const result = await db.execute({
      sql: `SELECT id, record_id, record_type, action, actor_name, actor_role, detail, created_at
        FROM record_audit ORDER BY id DESC LIMIT ?`,
      args: [limit]
    });

    const rows = result.rows
      .filter(row => canReadType(admin.role, String(row.record_type)))
      .map(row => ({
        id: row.id,
        recordId: String(row.record_id),
        recordType: String(row.record_type),
        action: String(row.action),
        actorName: String(row.actor_name),
        actorRole: String(row.actor_role),
        detail: String(row.detail || ''),
        createdAt: String(row.created_at)
      }));
    return res.status(200).json(rows);
  } catch (error) {
    return sendApiError(res, error);
  }
}
