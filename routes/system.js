// ============================================================
// routes/system.js — ตั้งค่าระบบ (5.12) — เข้าถึงได้เฉพาะ admin (ตาม Permission Matrix เริ่มต้น)
// ============================================================

import { ok, fail, readJsonBody } from '../lib/response.js';
import { requireAuth, requirePermission } from '../lib/auth-middleware.js';
import { writeAudit } from '../lib/audit.js';

function toCsv(rows) {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => `"${String(row[h] ?? '').replace(/"/g, '""')}"`).join(','));
  }
  return lines.join('\n');
}

// ------------------------------------------------------------
// 5.12.1 Permission Matrix
// ------------------------------------------------------------
async function handleGetPermissionMatrix(env) {
  const rows = await env.DB.prepare(`SELECT * FROM settings_permission ORDER BY id`).all();
  return ok({ data: rows.results });
}

async function handleUpdatePermissionMatrix(request, env, user) {
  const body = await readJsonBody(request); // { module, admin, manager, editor, checker, staff, guest }
  if (!body.module) return fail('กรุณาระบุ module', 400);

  const roles = ['admin', 'manager', 'editor', 'checker', 'staff', 'guest'];
  const setParts = [];
  const values = [];
  for (const r of roles) {
    if (body[r] !== undefined) { setParts.push(`${r} = ?`); values.push(body[r] ? 1 : 0); }
  }
  if (setParts.length === 0) return fail('ไม่มีข้อมูลที่ต้องการแก้ไข', 400);
  setParts.push('updated_at = CURRENT_TIMESTAMP');

  await env.DB.prepare(`UPDATE settings_permission SET ${setParts.join(', ')} WHERE module = ?`).bind(...values, body.module).run();
  await writeAudit(env, { email: user.email, username: user.username, action: 'permission_change', detail: `แก้ไขสิทธิ์ module=${body.module}`, module: 'system' });
  return ok({ message: 'บันทึกสิทธิ์สำเร็จ' });
}

// ------------------------------------------------------------
// 5.12.2 Session settings
// ------------------------------------------------------------
const SESSION_KEYS = ['session_guest_timeout_hours', 'session_inactivity_minutes', 'session_token_age_hours', 'session_max_login_retry'];

async function handleGetSessionSettings(env) {
  const placeholders = SESSION_KEYS.map(() => '?').join(',');
  const rows = (await env.DB.prepare(`SELECT key, value FROM settings_system WHERE key IN (${placeholders})`).bind(...SESSION_KEYS).all()).results;
  const data = {};
  for (const r of rows) data[r.key] = r.value;
  return ok({ data });
}

async function handleUpdateSessionSettings(request, env, user) {
  const body = await readJsonBody(request);
  const statements = SESSION_KEYS.filter((k) => body[k] !== undefined).map((k) =>
    env.DB.prepare(`UPDATE settings_system SET value = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE key = ?`)
      .bind(String(body[k]), user.email, k)
  );
  if (statements.length === 0) return fail('ไม่มีข้อมูลที่ต้องการแก้ไข', 400);
  await env.DB.batch(statements);
  await writeAudit(env, { email: user.email, username: user.username, action: 'settings_change', detail: 'แก้ไขการตั้งค่า Session', module: 'system' });
  return ok({ message: 'บันทึกการตั้งค่า Session สำเร็จ' });
}

// ------------------------------------------------------------
// 5.12.3 Audit Logs
// ------------------------------------------------------------
async function handleAuditLogsList(request, env) {
  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const pageSize = 50;
  const module = url.searchParams.get('module') || '';
  const action = url.searchParams.get('action') || '';
  const search = url.searchParams.get('search') || '';

  let where = '1=1';
  const params = [];
  if (module) { where += ` AND module = ?`; params.push(module); }
  if (action) { where += ` AND action = ?`; params.push(action); }
  if (search) {
    where += ` AND (username LIKE ? OR email LIKE ? OR detail LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  const countRow = await env.DB.prepare(`SELECT COUNT(*) as total FROM audit_logs WHERE ${where}`).bind(...params).first();
  const rows = await env.DB.prepare(
    `SELECT * FROM audit_logs WHERE ${where} ORDER BY time DESC LIMIT ? OFFSET ?`
  ).bind(...params, pageSize, (page - 1) * pageSize).all();

  return ok({ data: rows.results, total: countRow?.total || 0, page, pageSize });
}

async function handleAuditLogsExport(env) {
  const rows = (await env.DB.prepare(`SELECT * FROM audit_logs ORDER BY time DESC`).all()).results;
  return new Response(toCsv(rows), {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="audit_logs.csv"' }
  });
}

// ------------------------------------------------------------
// 5.12.4 Telegram notification
// ------------------------------------------------------------
const TELEGRAM_KEYS = [
  'telegram_enabled', 'telegram_bot_token', 'telegram_chat_id',
  'tg_notify_import', 'tg_notify_receive', 'tg_notify_assign_editor', 'tg_notify_edit', 'tg_notify_return',
  'tg_notify_pass', 'tg_notify_propose', 'tg_notify_approve', 'tg_notify_pay', 'tg_notify_cancel', 'tg_notify_recovery'
];

async function handleGetTelegram(env) {
  const placeholders = TELEGRAM_KEYS.map(() => '?').join(',');
  const rows = (await env.DB.prepare(`SELECT key, value FROM settings_system WHERE key IN (${placeholders})`).bind(...TELEGRAM_KEYS).all()).results;
  const data = {};
  for (const r of rows) data[r.key] = r.value;
  return ok({ data });
}

async function handleUpdateTelegram(request, env, user) {
  const body = await readJsonBody(request);
  const statements = TELEGRAM_KEYS.filter((k) => body[k] !== undefined).map((k) =>
    env.DB.prepare(`UPDATE settings_system SET value = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE key = ?`)
      .bind(String(body[k]), user.email, k)
  );
  if (statements.length === 0) return fail('ไม่มีข้อมูลที่ต้องการแก้ไข', 400);
  await env.DB.batch(statements);
  await writeAudit(env, { email: user.email, username: user.username, action: 'settings_change', detail: 'แก้ไขการตั้งค่า Telegram', module: 'system' });
  return ok({ message: 'บันทึกการตั้งค่า Telegram สำเร็จ' });
}

// ------------------------------------------------------------
// 5.12.5 Data Retention
// ------------------------------------------------------------
const RETENTION_KEYS = ['retention_enabled', 'retention_years'];

async function handleGetRetention(env) {
  const placeholders = RETENTION_KEYS.map(() => '?').join(',');
  const rows = (await env.DB.prepare(`SELECT key, value FROM settings_system WHERE key IN (${placeholders})`).bind(...RETENTION_KEYS).all()).results;
  const data = {};
  for (const r of rows) data[r.key] = r.value;
  return ok({ data });
}

async function handleUpdateRetention(request, env, user) {
  const body = await readJsonBody(request);
  const statements = RETENTION_KEYS.filter((k) => body[k] !== undefined).map((k) =>
    env.DB.prepare(`UPDATE settings_system SET value = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE key = ?`)
      .bind(String(body[k]), user.email, k)
  );
  if (statements.length === 0) return fail('ไม่มีข้อมูลที่ต้องการแก้ไข', 400);
  await env.DB.batch(statements);
  await writeAudit(env, { email: user.email, username: user.username, action: 'settings_change', detail: 'แก้ไขการตั้งค่า Data Retention', module: 'system' });
  return ok({ message: 'บันทึกการตั้งค่า Data Retention สำเร็จ' });
}

// ทำงานแบบ 2 ขั้น: ไม่ส่ง confirm=true -> ดูตัวอย่างก่อน (พร้อมข้อมูล backup) / ส่ง confirm=true -> ลบจริง
async function handleRunRetention(request, env, user) {
  const enabledRow = await env.DB.prepare(`SELECT value FROM settings_system WHERE key = 'retention_enabled'`).first();
  if (enabledRow?.value !== '1') return fail('Data Retention ยังไม่ได้เปิดใช้งาน', 400);

  const yearsRow = await env.DB.prepare(`SELECT value FROM settings_system WHERE key = 'retention_years'`).first();
  const years = parseInt(yearsRow?.value || '5', 10);

  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - years);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  // ลบเฉพาะรายการที่ "จบงานแล้ว" จริง (จ่ายแล้ว/ยกเลิก) และเก่ากว่าระยะเก็บที่กำหนด
  const toDelete = (await env.DB.prepare(
    `SELECT * FROM register WHERE status IN ('PAID', 'CANCELLED') AND created_at < ?`
  ).bind(cutoffStr).all()).results;

  const body = await readJsonBody(request);
  if (!body.confirm) {
    return ok({ preview: true, count: toDelete.length, cutoff_date: cutoffStr, backup: toDelete });
  }

  if (toDelete.length > 0) {
    const uuids = toDelete.map((r) => r.uuid);
    const placeholders = uuids.map(() => '?').join(',');
    await env.DB.prepare(`DELETE FROM register WHERE uuid IN (${placeholders})`).bind(...uuids).run();
  }
  await env.DB.prepare(`DELETE FROM logs WHERE time < ?`).bind(cutoffStr).run();

  await writeAudit(env, {
    email: user.email, username: user.username, action: 'data_retention',
    detail: `ลบข้อมูลเก่าเกิน ${years} ปี: register ${toDelete.length} รายการ + logs เก่ากว่า ${cutoffStr}`,
    module: 'system'
  });

  return ok({ message: 'ดำเนินการ Data Retention สำเร็จ', deleted: toDelete.length });
}

// ------------------------------------------------------------
// Dispatcher ของโมดูล System (ทุก endpoint ต้องผ่าน permission 'system' ซึ่ง default เปิดให้ admin เท่านั้น)
// ------------------------------------------------------------
export async function handleSystemRoutes(request, env, path) {
  const { user, error } = await requireAuth(request, env);
  if (error) return error;
  const permError = await requirePermission(env, user, 'system');
  if (permError) return permError;

  const method = request.method;

  if (path === '/api/system/permission-matrix' && method === 'GET') return handleGetPermissionMatrix(env);
  if (path === '/api/system/permission-matrix' && method === 'PUT') return handleUpdatePermissionMatrix(request, env, user);

  if (path === '/api/system/session-settings' && method === 'GET') return handleGetSessionSettings(env);
  if (path === '/api/system/session-settings' && method === 'PUT') return handleUpdateSessionSettings(request, env, user);

  if (path === '/api/system/audit-logs' && method === 'GET') return handleAuditLogsList(request, env);
  if (path === '/api/system/audit-logs/export' && method === 'GET') return handleAuditLogsExport(env);

  if (path === '/api/system/telegram-settings' && method === 'GET') return handleGetTelegram(env);
  if (path === '/api/system/telegram-settings' && method === 'PUT') return handleUpdateTelegram(request, env, user);

  if (path === '/api/system/retention-settings' && method === 'GET') return handleGetRetention(env);
  if (path === '/api/system/retention-settings' && method === 'PUT') return handleUpdateRetention(request, env, user);
  if (path === '/api/system/retention/run' && method === 'POST') return handleRunRetention(request, env, user);

  return fail('ไม่พบ Endpoint นี้ใน System Module', 404);
}
