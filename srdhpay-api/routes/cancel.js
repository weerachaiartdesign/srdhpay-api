// ============================================================
// routes/cancel.js — ยกเลิก / กู้คืนรายการ (5.11.6)
// admin มีสิทธิ์ Override ยกเลิกรายการสถานะ "จ่ายแล้ว" ได้ (ข้อ 7.3 เอกสารเพิ่มเติม)
// role อื่นที่มีสิทธิ์ settings (manager) ยกเลิกรายการที่ "จ่ายแล้ว" ไม่ได้
// ============================================================

import { ok, fail, readJsonBody } from '../lib/response.js';
import { requireAuth, requirePermission } from '../lib/auth-middleware.js';
import { writeAudit, writeLog } from '../lib/audit.js';
import { notifyTelegram } from '../lib/telegram.js';
import { todayForDb } from '../lib/datetime.js';

// ------------------------------------------------------------
// POST /api/register/cancel   { uuid, cancel_note }
// ------------------------------------------------------------
async function handleCancel(request, env) {
  const { user, error } = await requireAuth(request, env);
  if (error) return error;
  const permError = await requirePermission(env, user, 'settings');
  if (permError) return permError;

  const body = await readJsonBody(request);
  const { uuid, cancel_note } = body;
  if (!uuid) return fail('ไม่พบรายการที่ต้องการยกเลิก', 400);
  if (!cancel_note || !cancel_note.trim()) return fail('กรุณากรอกหมายเหตุการยกเลิก', 400);

  const row = await env.DB.prepare(`SELECT * FROM register WHERE uuid = ?`).bind(uuid).first();
  if (!row) return fail('ไม่พบรายการนี้', 404);
  if (row.status === 'CANCELLED') return fail('รายการนี้ถูกยกเลิกไปแล้ว', 409);

  const isOverride = row.status === 'PAID';
  if (isOverride && user.role !== 'admin') {
    return fail('รายการนี้จ่ายเช็คไปแล้ว เฉพาะ Admin เท่านั้นที่ยกเลิกได้', 403);
  }

  const today = todayForDb();
  // cancel_change บันทึกสถานะปัจจุบัน (ก่อนยกเลิก) ไว้ใช้ตอนกู้คืน
  await env.DB.prepare(
    `UPDATE register SET
       cancel_date = ?, cancel_note = ?, cancel_status = 1, cancel_change = ?, status = 'CANCELLED',
       updated_at = CURRENT_TIMESTAMP, updated_by = ?
     WHERE uuid = ?`
  ).bind(today, cancel_note.trim(), row.status, user.email, uuid).run();

  await writeAudit(env, {
    email: user.email, username: user.username, action: 'cancel', uuid,
    before: row, detail: `ยกเลิกรายการ${isOverride ? ' (Override สถานะจ่ายแล้ว โดย Admin)' : ''} เหตุผล: ${cancel_note.trim()}`,
    module: 'settings'
  });
  await writeLog(env, { request, email: user.email, username: user.username, role: user.role, action: 'cancel', page: 'settings' });
  await notifyTelegram(
    env, 'cancel',
    `🚫 ยกเลิกรายการ${isOverride ? ' (Admin Override)' : ''}\nเหตุผล: ${cancel_note.trim()}\nโดย: ${user.username}`
  );

  return ok({ message: 'ยกเลิกรายการสำเร็จ' });
}

// ------------------------------------------------------------
// POST /api/register/restore   { uuid }
// ------------------------------------------------------------
async function handleRestore(request, env) {
  const { user, error } = await requireAuth(request, env);
  if (error) return error;
  const permError = await requirePermission(env, user, 'settings');
  if (permError) return permError;

  const body = await readJsonBody(request);
  const { uuid } = body;
  if (!uuid) return fail('ไม่พบรายการที่ต้องการกู้คืน', 400);

  const row = await env.DB.prepare(`SELECT * FROM register WHERE uuid = ?`).bind(uuid).first();
  if (!row) return fail('ไม่พบรายการนี้', 404);
  if (row.status !== 'CANCELLED') return fail('รายการนี้ไม่ได้อยู่ในสถานะยกเลิก', 409);

  const previousStatus = row.cancel_change || 'WAITING';

  await env.DB.prepare(
    `UPDATE register SET
       cancel_date = NULL, cancel_note = NULL, cancel_status = 0, status = ?,
       updated_at = CURRENT_TIMESTAMP, updated_by = ?
     WHERE uuid = ?`
  ).bind(previousStatus, user.email, uuid).run();
  // หมายเหตุ: คงค่า cancel_change ไว้เป็นประวัติ (ไม่ลบ) เพื่อการตรวจสอบย้อนหลังใน audit

  await writeAudit(env, {
    email: user.email, username: user.username, action: 'recovery', uuid,
    before: row, detail: `กู้คืนรายการ กลับเป็นสถานะ: ${previousStatus}`, module: 'settings'
  });
  await writeLog(env, { request, email: user.email, username: user.username, role: user.role, action: 'recovery', page: 'settings' });
  await notifyTelegram(env, 'recovery', `♻️ กู้คืนรายการ กลับเป็นสถานะ: ${previousStatus}\nโดย: ${user.username}`);

  return ok({ message: 'กู้คืนรายการสำเร็จ', restored_status: previousStatus });
}

// ------------------------------------------------------------
// Dispatcher ของโมดูล Cancel/Restore
// ------------------------------------------------------------
export async function handleCancelRoutes(request, env, path) {
  const method = request.method;

  if (path === '/api/register/cancel' && method === 'POST') return handleCancel(request, env);
  if (path === '/api/register/restore' && method === 'POST') return handleRestore(request, env);

  return fail('ไม่พบ Endpoint นี้ใน Cancel/Restore Module', 404);
}
