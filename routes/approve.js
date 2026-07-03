// ============================================================
// routes/approve.js — บันทึกการเสนอและอนุมัติ (5.7)
// PASSED -> PROPOSED -> APPROVED
// ============================================================

import { ok, fail, readJsonBody } from '../lib/response.js';
import { requireAuth, requirePermission } from '../lib/auth-middleware.js';
import { writeAudit, writeLog } from '../lib/audit.js';
import { notifyTelegram } from '../lib/telegram.js';
import { withStatusDisplayList } from '../lib/status.js';
import { todayForDb } from '../lib/datetime.js';

function buildSearchFilters(url) {
  const moneyType = url.searchParams.get('money_type') || '';
  const dept = url.searchParams.get('dept') || '';
  const sender = url.searchParams.get('sender') || '';
  const vendor = url.searchParams.get('vendor') || '';
  let extra = '';
  const params = [];
  if (moneyType) { extra += ` AND money_type = ?`; params.push(moneyType); }
  if (dept) { extra += ` AND dept = ?`; params.push(dept); }
  if (sender) { extra += ` AND sender LIKE ?`; params.push(`%${sender}%`); }
  if (vendor) { extra += ` AND vendor LIKE ?`; params.push(`%${vendor}%`); }
  return { extra, params };
}

// ------------------------------------------------------------
// GET /api/approve/list?action=propose|approve
// ------------------------------------------------------------
async function handleList(request, env) {
  const { user, error } = await requireAuth(request, env);
  if (error) return error;
  const permError = await requirePermission(env, user, 'approve');
  if (permError) return permError;

  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  const statusFor = { propose: 'PASSED', approve: 'PROPOSED' };
  const targetStatus = statusFor[action];
  if (!targetStatus) return fail('action ไม่ถูกต้อง (ต้องเป็น propose หรือ approve)', 400);

  let where = `status = ?`;
  const params = [targetStatus];
  const { extra, params: extraParams } = buildSearchFilters(url);
  where += extra;
  params.push(...extraParams);

  const rows = await env.DB.prepare(
    `SELECT * FROM register WHERE ${where} ORDER BY pass_date ASC, dk_no_raw ASC`
  ).bind(...params).all();

  return ok({ data: withStatusDisplayList(rows.results) });
}

async function validateUuids(env, uuids, expectedStatus) {
  const placeholders = uuids.map(() => '?').join(',');
  const rows = (await env.DB.prepare(
    `SELECT uuid, status FROM register WHERE uuid IN (${placeholders})`
  ).bind(...uuids).all()).results;
  if (rows.length !== uuids.length) return fail('มีบางรายการที่ไม่พบในระบบ', 404);
  const wrong = rows.filter((r) => r.status !== expectedStatus);
  if (wrong.length > 0) return fail('มีรายการที่ไม่อยู่ในสถานะที่ถูกต้อง กรุณาโหลดข้อมูลใหม่', 409);
  return null;
}

// ------------------------------------------------------------
// POST /api/approve/propose   { uuids: [...] }   PASSED -> PROPOSED
// ------------------------------------------------------------
async function handlePropose(request, env) {
  const { user, error } = await requireAuth(request, env);
  if (error) return error;
  const permError = await requirePermission(env, user, 'approve');
  if (permError) return permError;

  const body = await readJsonBody(request);
  const uuids = Array.isArray(body.uuids) ? body.uuids : [];
  if (uuids.length === 0) return fail('กรุณาเลือกรายการที่ต้องการส่งเสนอ', 400);

  const valError = await validateUuids(env, uuids, 'PASSED');
  if (valError) return valError;

  const today = todayForDb();
  const statements = uuids.map((uuid) =>
    env.DB.prepare(
      `UPDATE register SET propose_date = ?, status = 'PROPOSED', updated_at = CURRENT_TIMESTAMP, updated_by = ?
       WHERE uuid = ? AND status = 'PASSED'`
    ).bind(today, user.email, uuid)
  );
  await env.DB.batch(statements);

  await writeAudit(env, { email: user.email, username: user.username, action: 'propose', detail: `ส่งเสนอ ${uuids.length} รายการ`, module: 'approve' });
  await writeLog(env, { request, email: user.email, username: user.username, role: user.role, action: 'propose', page: 'approve' });
  await notifyTelegram(env, 'propose', `📤 ส่งเสนอ ${uuids.length} รายการ โดย: ${user.username}`);

  return ok({ message: 'บันทึกส่งเสนอสำเร็จ', count: uuids.length });
}

// ------------------------------------------------------------
// POST /api/approve/approve   { uuids: [...] }   PROPOSED -> APPROVED
// ------------------------------------------------------------
async function handleApprove(request, env) {
  const { user, error } = await requireAuth(request, env);
  if (error) return error;
  const permError = await requirePermission(env, user, 'approve');
  if (permError) return permError;

  const body = await readJsonBody(request);
  const uuids = Array.isArray(body.uuids) ? body.uuids : [];
  if (uuids.length === 0) return fail('กรุณาเลือกรายการที่ต้องการอนุมัติ', 400);

  const valError = await validateUuids(env, uuids, 'PROPOSED');
  if (valError) return valError;

  const today = todayForDb();
  const statements = uuids.map((uuid) =>
    env.DB.prepare(
      `UPDATE register SET approve_date = ?, status = 'APPROVED', updated_at = CURRENT_TIMESTAMP, updated_by = ?
       WHERE uuid = ? AND status = 'PROPOSED'`
    ).bind(today, user.email, uuid)
  );
  await env.DB.batch(statements);

  await writeAudit(env, { email: user.email, username: user.username, action: 'approve', detail: `อนุมัติ ${uuids.length} รายการ`, module: 'approve' });
  await writeLog(env, { request, email: user.email, username: user.username, role: user.role, action: 'approve', page: 'approve' });
  await notifyTelegram(env, 'approve', `🟢 อนุมัติ ${uuids.length} รายการ โดย: ${user.username}`);

  return ok({ message: 'บันทึกอนุมัติสำเร็จ', count: uuids.length });
}

// ------------------------------------------------------------
// Dispatcher ของโมดูล Approve
// ------------------------------------------------------------
export async function handleApproveRoutes(request, env, path) {
  const method = request.method;

  if (path === '/api/approve/list' && method === 'GET') return handleList(request, env);
  if (path === '/api/approve/propose' && method === 'POST') return handlePropose(request, env);
  if (path === '/api/approve/approve' && method === 'POST') return handleApprove(request, env);

  return fail('ไม่พบ Endpoint นี้ใน Approve Module', 404);
}
