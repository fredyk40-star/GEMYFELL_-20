import {
  checkLoginRateLimit,
  clearLoginFailures,
  clientIp,
  createSession,
  ensureAuthSchema,
  ensureSuperadmin,
  getAuthContext,
  getClient,
  hashSecret,
  normalizePhone,
  recordLoginFailure,
  sendApiError,
  sendError,
  verifySecret
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

function sessionAdmin(context) {
  return { phone: context.phone, name: context.name, role: context.role };
}

async function login(req, res, db) {
  const body = requestBody(req);
  if (!body) return sendError(res, 400, 'A valid JSON request body is required.');

  const phone = normalizePhone(body.phone);
  const credential = typeof body.credential === 'string' ? body.credential.trim() : '';
  if (!phone || !credential || credential.length > 128) {
    return sendError(res, 400, 'Enter a valid Ghanaian phone number and PIN or temporary password.');
  }

  await ensureSuperadmin(db);
  const ip = clientIp(req);
  await checkLoginRateLimit(db, phone, ip);

  const result = await db.execute({
    sql: `SELECT phone, name, role, pin_hash, temp_password_hash, must_set_pin, active
      FROM admins WHERE phone = ?`,
    args: [phone]
  });
  const admin = result.rows[0];
  let valid = false;
  let needsPinSetup = false;

  if (admin && Number(admin.active) === 1) {
    if (Number(admin.must_set_pin) === 1 && admin.temp_password_hash) {
      valid = await verifySecret(credential, String(admin.temp_password_hash));
      needsPinSetup = valid;
    } else if (admin.pin_hash) {
      valid = await verifySecret(credential, String(admin.pin_hash));
    }
  }

  if (!valid || !admin) {
    await recordLoginFailure(db, phone, ip);
    return sendError(res, 401, 'Phone number or PIN / temporary password is incorrect.');
  }

  await clearLoginFailures(db, phone);
  if (needsPinSetup) {
    const consumed = await db.execute({
      sql: `UPDATE admins SET temp_password_hash = NULL
        WHERE phone = ? AND temp_password_hash = ? AND must_set_pin = 1 AND active = 1`,
      args: [phone, String(admin.temp_password_hash)]
    });
    if (Number(consumed.rowsAffected) !== 1) {
      return sendError(res, 401, 'This temporary password has already been used.');
    }
    const setupSession = await createSession(db, phone, 'pin_setup');
    return res.status(200).json({
      success: true,
      requiresPinSetup: true,
      token: setupSession.token,
      admin: { phone, name: String(admin.name), role: String(admin.role) }
    });
  }

  const session = await createSession(db, phone);
  return res.status(200).json({
    success: true,
    token: session.token,
    expiresAt: session.expiresAt,
    admin: { phone, name: String(admin.name), role: String(admin.role) }
  });
}

async function setPin(req, res, db) {
  const body = requestBody(req);
  if (!body || !/^\d{4}$/.test(String(body.pin || ''))) {
    return sendError(res, 400, 'Choose a four-digit numeric PIN.');
  }
  const context = await getAuthContext(req, db);
  if (!context || context.purpose !== 'pin_setup' || !context.mustSetPin) {
    return sendError(res, 401, 'Your temporary sign-in has expired. Ask the superadmin for a new temporary password.');
  }

  const pinHash = await hashSecret(String(body.pin));
  const updated = await db.execute({
    sql: `UPDATE admins SET pin_hash = ?, must_set_pin = 0
      WHERE phone = ? AND must_set_pin = 1 AND active = 1 AND temp_password_hash IS NULL`,
    args: [pinHash, context.phone]
  });
  if (Number(updated.rowsAffected) !== 1) {
    return sendError(res, 409, 'PIN setup was already completed or this account is inactive.');
  }

  await db.execute({ sql: 'DELETE FROM admin_sessions WHERE token_hash = ?', args: [context.tokenHash] });
  const session = await createSession(db, context.phone);
  return res.status(200).json({
    success: true,
    token: session.token,
    expiresAt: session.expiresAt,
    admin: { phone: context.phone, name: context.name, role: context.role }
  });
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

    if (method === 'POST') {
      const body = requestBody(req);
      if (body?.action === 'set-pin') return await setPin(req, res, db);
      return await login(req, res, db);
    }

    if (method === 'GET') {
      const context = await getAuthContext(req, db);
      if (!context || context.purpose !== 'session' || context.mustSetPin) {
        return sendError(res, 401, 'Please sign in again.');
      }
      return res.status(200).json({ success: true, admin: sessionAdmin(context) });
    }

    const context = await getAuthContext(req, db);
    if (context) {
      await db.execute({ sql: 'DELETE FROM admin_sessions WHERE token_hash = ?', args: [context.tokenHash] });
    }
    return res.status(200).json({ success: true });
  } catch (error) {
    return sendApiError(res, error);
  }
}
