import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The libSQL client is cached on first call, so the test database must be
// configured before any api/ or lib/ module is imported.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemyfell-test-'));
const dbPath = path.join(tempDir, 'test.db');
process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
process.env.TURSO_AUTH_TOKEN = 'test-token';

const { ensureAuthSchema, getClient, hashSessionToken } = await import('../lib/auth.js');
const authHandler = (await import('../api/auth.js')).default;
const recordsHandler = (await import('../api/records.js')).default;
const auditHandler = (await import('../api/audit.js')).default;
const phonesHandler = (await import('../api/phones.js')).default;
const rollcallHandler = (await import('../api/rollcall.js')).default;

const TOKENS = {
  secretary: 'a'.repeat(43),
  attendance: 'b'.repeat(43),
  viewer: 'c'.repeat(43)
};

const ADMINS = [
  { phone: '+233200000001', name: 'Test Secretary', role: 'secretary', token: TOKENS.secretary },
  { phone: '+233200000002', name: 'Test Attendance', role: 'attendance', token: TOKENS.attendance },
  { phone: '+233200000003', name: 'Test Viewer', role: 'viewer', token: TOKENS.viewer }
];

let db;

before(async () => {
  db = getClient();
  await ensureAuthSchema(db);

  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  for (const admin of ADMINS) {
    await db.execute({
      sql: `INSERT INTO admins
        (phone, name, role, pin_hash, temp_password_hash, must_set_pin, active, created_at)
        VALUES (?, ?, ?, NULL, NULL, 0, 1, ?)`,
      args: [admin.phone, admin.name, admin.role, createdAt]
    });
    await db.execute({
      sql: `INSERT INTO admin_sessions (token_hash, phone, purpose, expires_at)
        VALUES (?, ?, 'session', ?)`,
      args: [hashSessionToken(admin.token), admin.phone, expiresAt]
    });
  }
});

after(async () => {
  if (db && typeof db.close === 'function') db.close();
  // libSQL can keep the file handle briefly after close() on Windows.
  await new Promise(resolve => setImmediate(resolve));
  await fs.promises.rm(tempDir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100
  });
});

function call(handler, method, body, token, query = {}) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  let settle;
  let settled = false;
  const result = new Promise(resolve => {
    settle = resolve;
  });
  const res = {
    headers: {},
    setHeader(key, value) {
      this.headers[String(key).toLowerCase()] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      if (!settled) {
        settled = true;
        settle({ status: this.statusCode ?? 200, payload, headers: this.headers });
      }
      return this;
    }
  };
  const req = { method, body, headers, query };

  Promise.resolve()
    .then(() => handler(req, res))
    .catch(error => {
      if (!settled) {
        settled = true;
        settle({ status: 500, payload: { success: false, error: error.message }, error });
      }
    });

  return result;
}

function auditRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.rows)) return payload.rows;
  if (payload && Array.isArray(payload.audit)) return payload.audit;
  return [];
}

function rowRecordId(row) {
  return String(row.recordId ?? row.record_id ?? '');
}

function rowRecordType(row) {
  return String(row.recordType ?? row.record_type ?? '');
}

function recordIds(payload) {
  return new Set((Array.isArray(payload) ? payload : []).map(row => String(row.id)));
}

test('auth: valid and invalid bearer tokens', async () => {
  const valid = await call(authHandler, 'GET', undefined, TOKENS.secretary);
  assert.equal(valid.status, 200);
  assert.equal(valid.payload.success, true);
  assert.equal(valid.payload.admin.phone, ADMINS[0].phone);
  assert.equal(valid.payload.admin.role, 'secretary');

  for (const token of [undefined, 'bad-token', 'z'.repeat(43)]) {
    const invalid = await call(authHandler, 'GET', undefined, token);
    assert.equal(invalid.status, 401);
    assert.equal(invalid.payload.success, false);
  }
});

test('phones: read empty, write, read, clear, and enforce roles/validation', async () => {
  const empty = await call(phonesHandler, 'GET', undefined, TOKENS.secretary);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.payload, {});

  const write = await call(
    phonesHandler,
    'POST',
    { name: 'Miss Boahemaa', phone: '+233201234567' },
    TOKENS.secretary
  );
  assert.equal(write.status, 200);
  assert.equal(write.payload.success, true);

  const read = await call(phonesHandler, 'GET', undefined, TOKENS.viewer);
  assert.equal(read.status, 200);
  assert.equal(read.payload['Miss Boahemaa'], '+233201234567');

  const viewerWrite = await call(
    phonesHandler,
    'POST',
    { name: 'Miss Boahemaa', phone: '+233209999999' },
    TOKENS.viewer
  );
  assert.equal(viewerWrite.status, 403);
  const afterBlocked = await call(phonesHandler, 'GET', undefined, TOKENS.secretary);
  assert.equal(afterBlocked.payload['Miss Boahemaa'], '+233201234567');

  const unknownMember = await call(
    phonesHandler,
    'POST',
    { name: 'Not A Committee Member', phone: '+233201234567' },
    TOKENS.secretary
  );
  assert.equal(unknownMember.status, 400);

  const invalidPhone = await call(
    phonesHandler,
    'POST',
    { name: 'Miss Boahemaa', phone: 'not-a-phone' },
    TOKENS.secretary
  );
  assert.equal(invalidPhone.status, 400);

  const cleared = await call(
    phonesHandler,
    'POST',
    { name: 'Miss Boahemaa', phone: '' },
    TOKENS.secretary
  );
  assert.equal(cleared.status, 200);
  const afterClear = await call(phonesHandler, 'GET', undefined, TOKENS.secretary);
  assert.equal(afterClear.payload['Miss Boahemaa'], undefined);
});

const WORKFLOW_ID = 'test-workflow-record-1';
const DUE_DATE = '2026-03-15';

test('records: create, update, workflow fields, version conflict, delete, and audit details', async () => {
  const base = {
    id: WORKFLOW_ID,
    type: 'Meeting Minutes',
    date: '2026-03-01',
    title: 'Workflow Test Record',
    status: 'Open',
    recorder: 'Test Recorder',
    details: 'Initial details'
  };

  const created = await call(recordsHandler, 'POST', base, TOKENS.secretary);
  assert.equal(created.status, 200);
  assert.equal(created.payload.success, true);

  const initial = (await call(recordsHandler, 'GET', undefined, TOKENS.secretary)).payload
    .find(row => String(row.id) === WORKFLOW_ID);
  assert.ok(initial, 'created record should be readable');
  assert.ok(Number.isInteger(initial.version), 'version should be an integer');
  assert.ok(initial.version >= 1, 'version should increment on create');

  const updated = await call(
    recordsHandler,
    'POST',
    {
      ...base,
      version: initial.version,
      assignee: 'Miss Boahemaa',
      dueDate: DUE_DATE,
      stage: 'Hearing'
    },
    TOKENS.secretary
  );
  assert.equal(updated.status, 200);

  const afterUpdate = (await call(recordsHandler, 'GET', undefined, TOKENS.secretary)).payload
    .find(row => String(row.id) === WORKFLOW_ID);
  assert.equal(afterUpdate.assignee, 'Miss Boahemaa');
  // The contract names this field `due_date`; some API builds expose `dueDate`.
  assert.equal(afterUpdate.due_date ?? afterUpdate.dueDate, DUE_DATE);
  assert.equal(afterUpdate.stage, 'Hearing');
  assert.equal(afterUpdate.version, initial.version + 1);

  const conflict = await call(
    recordsHandler,
    'POST',
    { ...base, version: initial.version, stage: 'Closed' },
    TOKENS.secretary
  );
  assert.equal(conflict.status, 409);
  assert.equal(conflict.payload.success, false);
  assert.equal(conflict.payload.code, 'VERSION_CONFLICT');
  assert.equal(conflict.payload.record.id, WORKFLOW_ID);
  assert.equal(conflict.payload.record.version, afterUpdate.version);
  assert.equal(conflict.payload.record.stage, 'Hearing');
  assert.equal(conflict.payload.record.assignee, 'Miss Boahemaa');
  assert.equal(conflict.payload.record.due_date ?? conflict.payload.record.dueDate, DUE_DATE);

  const viewerWrite = await call(
    recordsHandler,
    'POST',
    { ...base, id: 'test-viewer-blocked-record' },
    TOKENS.viewer
  );
  assert.equal(viewerWrite.status, 403);

  const deleted = await call(recordsHandler, 'DELETE', undefined, TOKENS.secretary, { id: WORKFLOW_ID });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.payload.success, true);
  const afterDelete = await call(recordsHandler, 'GET', undefined, TOKENS.secretary);
  assert.equal(recordIds(afterDelete.payload).has(WORKFLOW_ID), false);

  const audit = await call(auditHandler, 'GET', undefined, TOKENS.secretary, { limit: 200 });
  assert.equal(audit.status, 200);
  const rows = auditRows(audit.payload).filter(row => rowRecordId(row) === WORKFLOW_ID);
  const updateRow = rows.find(row => String(row.action).toLowerCase() === 'update');
  assert.ok(updateRow, 'expected an update audit entry');
  const detail = String(updateRow.detail ?? '');
  assert.ok(detail.includes('Hearing'), `audit detail should mention the new stage: ${detail}`);
  assert.ok(detail.includes('Miss Boahemaa'), `audit detail should mention the new assignee: ${detail}`);
  assert.ok(detail.includes(DUE_DATE), `audit detail should mention the new due date: ${detail}`);
  assert.ok(
    rows.some(row => String(row.action).toLowerCase() === 'delete'),
    'expected a delete audit entry'
  );
});

test('audit: GET only and role-based filtering', async () => {
  const post = await call(auditHandler, 'POST', {}, TOKENS.secretary);
  assert.equal(post.status, 405);

  const attendanceId = 'test-audit-attendance-record';
  const created = await call(
    recordsHandler,
    'POST',
    {
      id: attendanceId,
      type: 'Attendance',
      date: '2026-03-02',
      title: 'Attendance Audit Record',
      status: 'Open',
      recorder: 'Test Recorder',
      details: 'Attendance audit fixture'
    },
    TOKENS.secretary
  );
  assert.equal(created.status, 200);

  const secretaryAudit = await call(auditHandler, 'GET', undefined, TOKENS.secretary, { limit: 200 });
  assert.equal(secretaryAudit.status, 200);
  const secretaryRows = auditRows(secretaryAudit.payload);
  assert.ok(
    secretaryRows.some(row => rowRecordType(row) === 'Meeting Minutes'),
    'secretary should see Meeting Minutes audit rows'
  );

  const attendanceAudit = await call(auditHandler, 'GET', undefined, TOKENS.attendance, { limit: 200 });
  assert.equal(attendanceAudit.status, 200);
  const attendanceRows = auditRows(attendanceAudit.payload);
  assert.ok(
    attendanceRows.every(row => rowRecordType(row) === 'Attendance'),
    'attendance role should only see Attendance audit rows'
  );
  assert.ok(
    attendanceRows.some(row => rowRecordId(row) === attendanceId),
    'attendance role should see its own record audits'
  );
});

test('records: GET returns only records readable by the caller role', async () => {
  const incidentId = 'test-read-incident';
  const attendanceId = 'test-read-attendance';
  for (const [id, type] of [
    [incidentId, 'Incident Report'],
    [attendanceId, 'Attendance']
  ]) {
    const created = await call(
      recordsHandler,
      'POST',
      {
        id,
        type,
        date: '2026-03-03',
        title: `Readable ${type}`,
        status: 'Open',
        recorder: 'Test Recorder',
        details: 'Readability fixture'
      },
      TOKENS.secretary
    );
    assert.equal(created.status, 200);
  }

  const secretary = await call(recordsHandler, 'GET', undefined, TOKENS.secretary);
  assert.ok(recordIds(secretary.payload).has(incidentId));
  assert.ok(recordIds(secretary.payload).has(attendanceId));

  const attendance = await call(recordsHandler, 'GET', undefined, TOKENS.attendance);
  assert.ok(recordIds(attendance.payload).has(attendanceId));
  assert.equal(recordIds(attendance.payload).has(incidentId), false);
});

const ROLLCALL_DATE = '2026-04-10';
const ROLLCALL_STATUSES = {
  'Miss Boahemaa': 'Present',
  'Brother Fred': 'Late',
  'Miss Ellen Boatemaa': 'Absent'
};

test('rollcall: empty read, write, read, version conflict, and role permissions', async () => {
  const empty = await call(rollcallHandler, 'GET', undefined, TOKENS.secretary, { date: ROLLCALL_DATE });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.payload.statuses ?? {}, {});
  assert.equal(empty.payload.version ?? 0, 0);

  const written = await call(
    rollcallHandler,
    'POST',
    { date: ROLLCALL_DATE, statuses: ROLLCALL_STATUSES },
    TOKENS.secretary
  );
  assert.equal(written.status, 200);
  assert.equal(written.payload.success, true);

  const read = await call(rollcallHandler, 'GET', undefined, TOKENS.viewer, { date: ROLLCALL_DATE });
  assert.equal(read.status, 200);
  assert.equal(read.payload.date, ROLLCALL_DATE);
  assert.deepEqual(read.payload.statuses, ROLLCALL_STATUSES);
  assert.ok(Number.isInteger(read.payload.version));
  assert.ok(read.payload.updatedAt, 'updatedAt should be populated after a write');
  const currentVersion = read.payload.version;

  const conflict = await call(
    rollcallHandler,
    'POST',
    { date: ROLLCALL_DATE, statuses: { 'Brother Fred': 'Present' }, version: currentVersion - 1 },
    TOKENS.attendance
  );
  assert.equal(conflict.status, 409);
  assert.equal(conflict.payload.code, 'VERSION_CONFLICT');
  const conflictState = conflict.payload.rollCall ?? conflict.payload.record ?? conflict.payload;
  assert.equal(conflictState.version, currentVersion);
  assert.deepEqual(conflictState.statuses, ROLLCALL_STATUSES);

  const viewerWrite = await call(
    rollcallHandler,
    'POST',
    { date: ROLLCALL_DATE, statuses: ROLLCALL_STATUSES, version: currentVersion },
    TOKENS.viewer
  );
  assert.equal(viewerWrite.status, 403);
  const afterViewerWrite = await call(rollcallHandler, 'GET', undefined, TOKENS.secretary, {
    date: ROLLCALL_DATE
  });
  assert.equal(afterViewerWrite.payload.version, currentVersion);

  const attendanceWrite = await call(
    rollcallHandler,
    'POST',
    { date: ROLLCALL_DATE, statuses: ROLLCALL_STATUSES, version: currentVersion },
    TOKENS.attendance
  );
  assert.equal(attendanceWrite.status, 200);
  const afterAttendanceWrite = await call(rollcallHandler, 'GET', undefined, TOKENS.secretary, {
    date: ROLLCALL_DATE
  });
  assert.equal(afterAttendanceWrite.payload.version, currentVersion + 1);
});

test('rollcall: invalid dates and invalid status values are rejected', async () => {
  const badGetDate = await call(rollcallHandler, 'GET', undefined, TOKENS.secretary, {
    date: '10-04-2026'
  });
  assert.equal(badGetDate.status, 400);

  const badPostDate = await call(
    rollcallHandler,
    'POST',
    { date: '2026-02-30', statuses: { 'Miss Boahemaa': 'Present' } },
    TOKENS.secretary
  );
  assert.equal(badPostDate.status, 400);

  const badStatusesShape = await call(
    rollcallHandler,
    'POST',
    { date: '2026-04-11', statuses: ['Present'] },
    TOKENS.secretary
  );
  assert.equal(badStatusesShape.status, 400);

  const badStatusValue = await call(
    rollcallHandler,
    'POST',
    { date: '2026-04-11', statuses: { 'Miss Boahemaa': 'Maybe' } },
    TOKENS.secretary
  );
  assert.equal(badStatusValue.status, 400);

  const untouched = await call(rollcallHandler, 'GET', undefined, TOKENS.secretary, {
    date: '2026-04-11'
  });
  assert.equal(untouched.status, 200);
  assert.deepEqual(untouched.payload.statuses ?? {}, {});
});
