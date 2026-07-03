// ============================================================
// routes/payment.js — บันทึกการจ่าย (5.8)
// APPROVED -> PAID
// ============================================================

import { ok, fail, readJsonBody } from '../lib/response.js';
import { requireAuth, requirePermission } from '../lib/auth-middleware.js';
import { writeAudit, writeLog } from '../lib/audit.js';
import { notifyTelegram } from '../lib/telegram.js';
import { withStatusDisplayList } from '../lib/status.js';
import { todayForDb } from '../lib/datetime.js';

// ------------------------------------------------------------
// GET /api/payment/list   (รายการสถานะ "อนุมัติ" - พร้อมจ่าย)
// ------------------------------------------------------------
async function handleList(request, env) {
  const { user, error } = await requireAuth(request, env);
  if (error) return error;
  const permError = await requirePermission(env, user, 'payment');
  if (permError) return permError;

  const url = new URL(request.url);
  const dkNo = url.searchParams.get('dk_no') || '';
  const moneyType = url.searchParams.get('money_type') || '';
  const dept = url.searchParams.get('dept') || '';
  const vendor = url.searchParams.get('vendor') || '';

  let where = `status = 'APPROVED'`;
  const params = [];
  if (dkNo) { where += ` AND (dk_no_display LIKE ? OR dk_no_raw LIKE ?)`; params.push(`%${dkNo}%`, `%${dkNo}%`); }
  if (moneyType) { where += ` AND money_type = ?`; params.push(moneyType); }
  if (dept) { where += ` AND dept = ?`; params.push(dept); }
  if (vendor) { where += ` AND vendor LIKE ?`; params.push(`%${vendor}%`); }

  const rows = await env.DB.prepare(
    `SELECT * FROM register WHERE ${where} ORDER BY approve_date ASC, dk_no_raw ASC`
  ).bind(...params).all();

  return ok({ data: withStatusDisplayList(rows.results) });
}

// ------------------------------------------------------------
// POST /api/payment/pay   { uuids: [...] }   APPROVED -> PAID
// ------------------------------------------------------------
async function handlePay(request, env) {
  const { user, error } = await requireAuth(request, env);
  if (error) return error;
  const permError = await requirePermission(env, user, 'payment');
  if (permError) return permError;

  const body = await readJsonBody(request);
  const uuids = Array.isArray(body.uuids) ? body.uuids : [];
  if (uuids.length === 0) return fail('กรุณาเลือกรายการที่ต้องการจ่ายเช็ค', 400);

  const placeholders = uuids.map(() => '?').join(',');
  const rows = (await env.DB.prepare(
    `SELECT uuid, status FROM register WHERE uuid IN (${placeholders})`
  ).bind(...uuids).all()).results;
  if (rows.length !== uuids.length) return fail('มีบางรายการที่ไม่พบในระบบ', 404);
  const wrong = rows.filter((r) => r.status !== 'APPROVED');
  if (wrong.length > 0) return fail('มีรายการที่ไม่อยู่ในสถานะ "อนุมัติ" กรุณาโหลดข้อมูลใหม่', 409);

  const today = todayForDb();
  const statements = uuids.map((uuid) =>
    env.DB.prepare(
      `UPDATE register SET pay_date = ?, status = 'PAID', updated_at = CURRENT_TIMESTAMP, updated_by = ?
       WHERE uuid = ? AND status = 'APPROVED'`
    ).bind(today, user.email, uuid)
  );
  await env.DB.batch(statements);

  await writeAudit(env, { email: user.email, username: user.username, action: 'pay', detail: `จ่ายเช็ค ${uuids.length} รายการ`, module: 'payment' });
  await writeLog(env, { request, email: user.email, username: user.username, role: user.role, action: 'pay', page: 'payment' });
  await notifyTelegram(env, 'pay', `💰 จ่ายเช็ค ${uuids.length} รายการ โดย: ${user.username}`);

  return ok({ message: 'บันทึกการจ่ายสำเร็จ', count: uuids.length });
}

// ------------------------------------------------------------
// Dispatcher ของโมดูล Payment
// ------------------------------------------------------------
export async function handlePaymentRoutes(request, env, path) {
  const method = request.method;

  if (path === '/api/payment/list' && method === 'GET') return handleList(request, env);
  if (path === '/api/payment/pay' && method === 'POST') return handlePay(request, env);

  return fail('ไม่พบ Endpoint นี้ใน Payment Module', 404);
}
