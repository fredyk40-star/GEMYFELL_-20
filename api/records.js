import {
  ApiError,
  ensureAuthSchema,
  getAuthContext,
  getClient,
  sendApiError,
  sendError
} from '../lib/auth.js';

const RECORD_TYPES = new Set(['Incident Report', 'Meeting Minutes', 'Attendance']);
const CASE_STAGES = new Set(['Open', 'Hearing', 'Ruling', 'Closed']);

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

async function ensureRecordColumns(db) {
  const info = await db.execute('PRAGMA table_info(records)');
  const columns = new Set(info.rows.map(row => String(row.name)));
  if (!columns.has('version')) {
    await db.execute('ALTER TABLE records ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
  }
  if (!columns.has('assignee')) {
    await db.execute("ALTER TABLE records ADD COLUMN assignee TEXT NOT NULL DEFAULT ''");
  }
  if (!columns.has('due_date')) {
    await db.execute("ALTER TABLE records ADD COLUMN due_date TEXT NOT NULL DEFAULT ''");
  }
  if (!columns.has('stage')) {
    await db.execute("ALTER TABLE records ADD COLUMN stage TEXT NOT NULL DEFAULT ''");
  }
  if (!columns.has('photo_data')) {
    try {
      await db.execute('ALTER TABLE records ADD COLUMN photo_data TEXT');
    } catch (error) {
      if (!/duplicate column/i.test(String(error?.message || ''))) throw error;
    }
  }
  if (!columns.has('audio_data')) {
    try {
      await db.execute('ALTER TABLE records ADD COLUMN audio_data TEXT');
    } catch (error) {
      if (!/duplicate column/i.test(String(error?.message || ''))) throw error;
    }
  }
}

function cleanDataUrl(value, kind) {
  const text = value == null ? '' : String(value);
  if (!text) return '';
  const maxChars = kind === 'photo' ? 400000 : 600000;
  if (text.length > maxChars) {
    throw new ApiError(413, kind === 'photo'
      ? 'Photo evidence is too large. Attach a smaller image.'
      : 'Voice note is too long or too large.');
  }
  const pattern = kind === 'photo'
    ? /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=\r\n]+$/
    : /^data:audio\/(webm|ogg|mp4|mpeg|x-m4a|mp3)(;[^,]*)?;base64,[A-Za-z0-9+/=\r\n]+$/;
  if (!pattern.test(text)) {
    throw new ApiError(400, kind === 'photo'
      ? 'Photo evidence must be a compressed JPEG, PNG or WebP data URL.'
      : 'Voice note must be a supported audio data URL.');
  }
  return text;
}

function recordPayload(row) {
  return {
    id: String(row.id),
    type: String(row.type || ''),
    date: String(row.date || ''),
    title: String(row.title || ''),
    status: String(row.status || ''),
    recorder: String(row.recorder || ''),
    details: String(row.details || ''),
    created_at: String(row.created_at || ''),
    version: Number(row.version) || 1,
    assignee: String(row.assignee || ''),
    dueDate: String(row.due_date || ''),
    due_date: String(row.due_date || ''),
    stage: String(row.stage || ''),
    photo_data: String(row.photo_data || ''),
    audio_data: String(row.audio_data || '')
  };
}

function short(value) {
  const text = String(value ?? '').trim() || '—';
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function describeChange(before, after) {
  const changes = [];
  const compare = (label, oldValue, newValue) => {
    if (String(oldValue ?? '') !== String(newValue ?? '')) {
      changes.push(`${label}: ${short(oldValue)} → ${short(newValue)}`);
    }
  };
  compare('status', before.status, after.status);
  compare('stage', before.stage, after.stage);
  compare('assignee', before.assignee, after.assignee);
  compare('due date', before.dueDate, after.dueDate);
  compare('date', before.date, after.date);
  if (Boolean(before.photo_data) !== Boolean(after.photo_data)) changes.push('photo evidence updated');
  if (Boolean(before.audio_data) !== Boolean(after.audio_data)) changes.push('voice note updated');
  if (String(before.details ?? '') !== String(after.details ?? '')) changes.push('details updated');
  const suffix = changes.length ? ` — ${changes.join('; ')}` : '';
  return `Updated ${short(after.title)}${suffix}`.slice(0, 500);
}

function auditStatement(entry) {
  return {
    sql: `INSERT INTO record_audit
      (record_id, record_type, action, actor_phone, actor_name, actor_role, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      entry.id,
      entry.type,
      entry.action,
      entry.admin.phone,
      entry.admin.name,
      entry.admin.role,
      entry.detail || '',
      new Date().toISOString()
    ]
  };
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
        created_at TEXT,
        photo_data TEXT,
        audio_data TEXT
      )
    `);
    await ensureRecordColumns(db);
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
      return sendError(res, 403, 'Complete PIN setup before accessing records.');
    }

    if (method === 'GET') {
      const result = await db.execute('SELECT * FROM records ORDER BY created_at DESC');
      const rows = result.rows
        .filter(row => canReadType(admin.role, String(row.type)))
        .map(recordPayload);
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

      const stage = record.stage == null ? '' : String(record.stage);
      if (stage && !CASE_STAGES.has(stage)) {
        return sendError(res, 400, 'Select a valid case stage.');
      }

      const id = String(record.id);
      const type = String(record.type);
      const existingResult = await db.execute({
        sql: 'SELECT * FROM records WHERE id = ?',
        args: [id]
      });
      const existingRow = existingResult.rows[0];
      const incomingVersion = Number(record.version);
      if (
        existingRow &&
        Number.isInteger(incomingVersion) &&
        incomingVersion !== (Number(existingRow.version) || 1)
      ) {
        return res.status(409).json({
          success: false,
          error: 'This record changed on another device. Refresh before editing again.',
          code: 'VERSION_CONFLICT',
          record: recordPayload(existingRow)
        });
      }

      const photoData = cleanDataUrl(record.photo_data ?? record.photoData, 'photo');
      const audioData = cleanDataUrl(record.audio_data ?? record.audioData, 'audio');

      const before = existingRow ? recordPayload(existingRow) : null;
      const version = existingRow ? (Number(existingRow.version) || 1) + 1 : 1;
      const next = {
        id,
        type,
        date: String(record.date),
        title: String(record.title),
        status: record.status == null ? '' : String(record.status),
        recorder: record.recorder == null ? '' : String(record.recorder),
        details: record.details == null ? '' : String(record.details),
        created_at: record.created_at ? String(record.created_at) : new Date().toISOString(),
        version,
        assignee: record.assignee == null ? '' : String(record.assignee),
        dueDate: record.dueDate == null ? '' : String(record.dueDate),
        stage,
        photo_data: photoData,
        audio_data: audioData
      };
      const action = before ? 'update' : 'create';
      const detail = before
        ? describeChange(before, next)
        : `Created ${short(next.title)}`;

      await db.batch([
        {
          sql: `INSERT OR REPLACE INTO records
            (id, type, date, title, status, recorder, details, created_at, version, assignee, due_date, stage, photo_data, audio_data)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            next.id,
            next.type,
            next.date,
            next.title,
            next.status,
            next.recorder,
            next.details,
            next.created_at,
            next.version,
            next.assignee,
            next.dueDate,
            next.stage,
            next.photo_data,
            next.audio_data
          ]
        },
        auditStatement({ id, type, action, admin, detail })
      ], 'write');

      return res.status(200).json({ success: true, version });
    }

    const id = typeof req.query?.id === 'string' ? req.query.id.trim() : '';
    if (!id) return sendError(res, 400, 'A record id query parameter is required.');

    const existing = await db.execute({
      sql: 'SELECT type, title, version FROM records WHERE id = ?',
      args: [id]
    });
    if (existing.rows.length && !canWriteType(admin.role, String(existing.rows[0].type))) {
      throw new ApiError(403, 'Your role cannot delete this record type.');
    }
    const row = existing.rows[0];
    await db.batch([
      { sql: 'DELETE FROM records WHERE id = ?', args: [id] },
      auditStatement({
        id,
        type: row ? String(row.type) : 'Unknown',
        action: 'delete',
        admin,
        detail: row ? `Deleted ${short(row.title)} (v${Number(row.version) || 1})` : 'Deleted a record that was already removed'
      })
    ], 'write');
    return res.status(200).json({ success: true });
  } catch (error) {
    return sendApiError(res, error);
  }
}
