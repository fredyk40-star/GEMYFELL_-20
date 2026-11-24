import {
  ApiError,
  createTemporaryPassword,
  ensureAuthSchema,
  getClient,
  hashSecret,
  isValidRole,
  normalizePhone,
  publicAdmin,
  requireSuperadmin,
  sendApiError,
  sendError
} from '../lib/auth.js';

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

async function invalidateSessions(db, phone) {
  await db.execute({ sql: 'DELETE FROM admin_sessions WHERE phone = ?', args: [phone] });
}

async function generateTemporaryPassword(db, phone) {
  const temporaryPassword = createTemporaryPassword();
  const passwordHash = await hashSecret(temporaryPassword);
  const updated = await db.execute({
    sql: `UPDATE admins SET pin_hash = NULL, temp_password_hash = ?, must_set_pin = 1
      WHERE phone = ? AND role != 'superadmin'`,
    args: [passwordHash, phone]
  });
  if (Number(updated.rowsAffected) !== 1) throw new ApiError(404, 'Administrator account not found.');
  await invalidateSessions(db, phone);
  return temporaryPassword;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const method = req.method || 'GET';
  if (!['GET', 'POST', 'PATCH'].includes(method)) {
    res.setHeader('Allow', 'GET, POST, PATCH');
    return sendError(res, 405, 'Method not allowed.');
  }

  try {
    const db = getClient();
    await ensureAuthSchema(db);
    await requireSuperadmin(req, db);

    if (method === 'GET') {
      const result = await db.execute(
        `SELECT phone, name, role, active, created_at FROM admins ORDER BY created_at ASC`
      );
      return res.status(200).json({ success: true, admins: result.rows.map(publicAdmin) });
    }

    const body = requestBody(req);
    if (!body) return sendError(res, 400, 'A valid JSON request body is required.');

    if (method === 'POST' && body.action === 'create') {
      const phone = normalizePhone(body.phone);
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const role = body.role;
      if (!phone) return sendError(res, 400, 'Enter a Ghanaian phone number in 0XXXXXXXXX or +233XXXXXXXXX format.');
      if (!name || name.length > 100) return sendError(res, 400, 'Enter a name between 1 and 100 characters.');
      if (!isValidRole(role)) return sendError(res, 400, 'Select an allowed administrator role.');

      const temporaryPassword = createTemporaryPassword();
      const tempHash = await hashSecret(temporaryPassword);
      try {
        await db.execute({
          sql: `INSERT INTO admins
            (phone, name, role, pin_hash, temp_password_hash, must_set_pin, active, created_at)
            VALUES (?, ?, ?, NULL, ?, 1, 1, ?)`,
          args: [phone, name, role, tempHash, new Date().toISOString()]
        });
      } catch (error) {
        if (error?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || error?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
          return sendError(res, 409, 'An account already exists for that phone number.');
        }
        throw error;
      }
      return res.status(201).json({
        success: true,
        admin: { phone, name, role },
        temporaryPassword
      });
    }

    if (method === 'POST' && body.action === 'reset-password') {
      const phone = normalizePhone(body.phone);
      if (!phone) return sendError(res, 400, 'Enter a valid Ghanaian phone number.');
      const target = await db.execute({
        sql: 'SELECT role FROM admins WHERE phone = ?',
        args: [phone]
      });
      if (!target.rows.length || target.rows[0].role === 'superadmin') {
        return sendError(res, 404, 'Administrator account not found.');
      }
      const temporaryPassword = await generateTemporaryPassword(db, phone);
      return res.status(200).json({ success: true, temporaryPassword });
    }

    if (method === 'PATCH') {
      const phone = normalizePhone(body.phone);
      if (!phone) return sendError(res, 400, 'Enter a valid Ghanaian phone number.');
      const target = await db.execute({
        sql: 'SELECT role FROM admins WHERE phone = ?',
        args: [phone]
      });
      if (!target.rows.length || target.rows[0].role === 'superadmin') {
        return sendError(res, 404, 'Administrator account not found.');
      }

      const assignments = [];
      const args = [];
      if (body.role !== undefined) {
        if (!isValidRole(body.role)) return sendError(res, 400, 'Select an allowed administrator role.');
        assignments.push('role = ?');
        args.push(body.role);
      }
      if (body.active !== undefined) {
        if (typeof body.active !== 'boolean') return sendError(res, 400, 'Active must be true or false.');
        assignments.push('active = ?');
        args.push(body.active ? 1 : 0);
      }
      if (!assignments.length) return sendError(res, 400, 'Provide a role or active-state change.');

      args.push(phone);
      await db.execute({
        sql: `UPDATE admins SET ${assignments.join(', ')} WHERE phone = ? AND role != 'superadmin'`,
        args
      });
      await invalidateSessions(db, phone);
      return res.status(200).json({ success: true });
    }

    return sendError(res, 400, 'Unknown administrator action.');
  } catch (error) {
    return sendApiError(res, error);
  }
}
