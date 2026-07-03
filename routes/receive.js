// ============================================================
// routes/receive.js — รับเข้าระบบ (5.5)
// ------------------------------------------------------------
// ขั้นตอน: ตรวจสอบการลงทะเบียน (WAITING) -> รับเข้าระบบ (ออกเลขรับ, เปลี่ยนสถานะ RECEIVED)
//          -> ตรวจสอบการรับเข้า (RECEIVED) -> กำหนดผู้ตรวจ (เปลี่ยนสถานะ CHECKUP)
// ============================================================

import { ok, fail, readJsonBody } from '../lib/response.js';
import { requireAuth, requirePermission } from '../lib/auth-middleware.js';
import { writeAudit, writeLog } from '../lib/audit.js';
import { notifyTelegram } from '../lib/telegram.js';
import { withStatusDisplayList } from '../lib/status.js';
import { reserveCounterRange, receiveCounterKey, buildReceiveNo } from '../lib/counters.js';
import { getFiscalYear, todayForDb } from '../lib/datetime.js';

// ------------------------------------------------------------
// GET /api/register/receive/pending  (ตรวจสอบการลงทะเบียน - สถานะ WAITING)
// ------------------------------------------------------------
async function handlePending(request, env) {
  const { user, error } = await requireAuth(request, env);
  if (error) return error;
  const permError = await requirePermission(env, user, 'receive');
  if (permError) return permError;

  const url = new URL(request.url);
  const registerDate = url.searchParams.get('register_date') || '';
  const registerNo = url.searchParams.get('register_no') || '';
  const moneyType = url.searchParams.get('money_type') || '';
  const dept = url.searchParams.get('dept') || '';
  const sender = url.searchParams.get('sender') || '';

  let where = `status = 'WAITING'`;
  const params = [];
  if (registerDate) { where += ` AND register_date = ?`; params.push(registerDate); }
  if (registerNo) { where += ` AND (register_no_display LIKE ? OR register_no_raw LIKE ?)`; params.push(`%${registerNo}%`, `%${registerNo}%`); }
  if (moneyType) { where += ` AND money_type = ?`; params.push(moneyType); }
  if (dept) { where += ` AND dept = ?`; params.push(dept); }
  if (sender) { where += ` AND sender LIKE ?`; params.push(`%${sender}%`); }

  const rows = await env.DB.prepare(
    `SELECT * FROM register WHERE ${where} ORDER BY register_date ASC, register_no_raw ASC`
  ).bind(...params).all();

  return ok({ data: withStatusDisplayList(rows.results) });
}

// ------------------------------------------------------------
// POST /api/register/receive  { uuids: [...] }  (รับเข้าระบบ)
// เลขที่รับออกแบบ "เป็นช่วง" ตามจำนวนรายการที่เลือก เรียงตามลำดับที่ส่งมา
// ------------------------------------------------------------
async function handleReceive(request, env) {
  const { user, error } = await requireAuth(request, env);
  if (error) return error;
  const permError = await requirePermission(env, user, 'receive');
  if (permError) return permError;

  const body = await readJsonBody(request);
  const uuids = Array.isArray(body.uuids) ? body.uuids : [];
  if (uuids.length === 0) return fail('กรุณาเลือกรายการที่ต้องการรับเข้าระบบ', 400);

  const placeholders = uuids.map(() => '?').join(',');
  const existingRows = (await env.DB.prepare(
    `SELECT uuid, status FROM register WHERE uuid IN (${placeholders})`
  ).bind(...uuids).all()).results;

  if (existingRows.length !== uuids.length) {
    return fail('มีบางรายการที่ไม่พบในระบบ กรุณาโหลดข้อมูลใหม่', 404);
  }
  const notWaiting = existingRows.filter((r) => r.status !== 'WAITING');
  if (notWaiting.length > 0) {
    return fail('มีรายการที่ไม่อยู่ในสถานะ "รอเอกสาร" กรุณาโหลดข้อมูลใหม่และเลือกอีกครั้ง', 409);
  }

  const fiscalYear = getFiscalYear();
  const today = todayForDb();
  const startSeq = await reserveCounterRange(env.DB, receiveCounterKey(fiscalYear), fiscalYear, uuids.length);

  const statements = [];
  const resultMap = [];
  uuids.forEach((uuid, idx) => {
    const receiveNo = buildReceiveNo(fiscalYear, startSeq + idx);
    resultMap.push({ uuid, receive_no_raw: receiveNo.raw, receive_no_display: receiveNo.display });
    statements.push(
      env.DB.prepare(
        `UPDATE register SET
           receive_date = ?, receive_no_raw = ?, receive_no_display = ?, status = 'RECEIVED',
           updated_at = CURRENT_TIMESTAMP, updated_by = ?
         WHERE uuid = ? AND status = 'WAITING'`
      ).bind(today, receiveNo.raw, receiveNo.display, user.email, uuid)
    );
  });

  await env.DB.batch(statements);

  await writeAudit(env, {
    email: user.email, username: user.username, action: 'receive',
    detail: `รับเข้าระบบ ${uuids.length} รายการ (${resultMap[0].receive_no_display} - ${resultMap[resultMap.length - 1].receive_no_display})`,
    module: 'register'
  });
  await writeLog(env, { request, email: user.email, username: user.username, role: user.role, action: 'receive', page: 'receive' });
  await notifyTelegram(
    env, 'receive',
    `📋 รับเข้าระบบสำเร็จ จำนวน ${uuids.length} รายการ\nเลขที่รับ: ${resultMap[0].receive_no_display} - ${resultMap[resultMap.length - 1].receive_no_display}\nโดย: ${user.username}`
  );

  return ok({ items: resultMap });
}

// ------------------------------------------------------------
// GET /api/register/receive/received  (ตรวจสอบการรับเข้า - สถานะ RECEIVED)
// ------------------------------------------------------------
async function handleReceived(request, env) {
  const { user, error } = await requireAuth(request, env);
  if (error) return error;
  const permError = await requirePermission(env, user, 'receive');
  if (permError) return permError;

  const url = new URL(request.url);
  const moneyType = url.searchParams.get('money_type') || '';
  const dept = url.searchParams.get('dept') || '';
  const sender = url.searchParams.get('sender') || '';

  let where = `status = 'RECEIVED'`;
  const params = [];
  if (moneyType) { where += ` AND money_type = ?`; params.push(moneyType); }
  if (dept) { where += ` AND dept = ?`; params.push(dept); }
  if (sender) { where += ` AND sender LIKE ?`; params.push(`%${sender}%`); }

  const rows = await env.DB.prepare(
    `SELECT * FROM register WHERE ${where} ORDER BY receive_date ASC, receive_no_raw ASC`
  ).bind(...params).all();

  return ok({ data: withStatusDisplayList(rows.results) });
}

// ------------------------------------------------------------
// POST /api/register/receive/assign-editor  { uuids: [...], editor_email }
// ------------------------------------------------------------
async function handleAssignEditor(request, env) {
  const { user, error } = await requireAuth(request, env);
  if (error) return error;
  const permError = await requirePermission(env, user, 'receive');
  if (permError) return permError;

  const body = await readJsonBody(request);
  const uuids = Array.isArray(body.uuids) ? body.uuids : [];
  const editorEmail = body.editor_email;
  if (uuids.length === 0) return fail('กรุณาเลือกรายการที่ต้องการกำหนดผู้ตรวจ', 400);
  if (!editorEmail) return fail('กรุณาเลือกผู้ตรวจ', 400);

  const editorRow = await env.DB.prepare(
    `SELECT email, username FROM auth WHERE email = ? AND role = 'editor' AND active = 1`
  ).bind(editorEmail).first();
  if (!editorRow) return fail('ไม่พบผู้ตรวจที่เลือก หรือผู้ตรวจถูกปิดใช้งาน', 404);

  const placeholders = uuids.map(() => '?').join(',');
  const existingRows = (await env.DB.prepare(
    `SELECT uuid, status FROM register WHERE uuid IN (${placeholders})`
  ).bind(...uuids).all()).results;

  const notReceived = existingRows.filter((r) => r.status !== 'RECEIVED');
  if (notReceived.length > 0 || existingRows.length !== uuids.length) {
    return fail('มีรายการที่ไม่อยู่ในสถานะ "รับเข้าระบบ" กรุณาโหลดข้อมูลใหม่', 409);
  }

  // เก็บ "email" ของผู้ตรวจในคอลัมน์ editor (ไม่ใช่ชื่อ) เพื่อป้องกันชื่อซ้ำ 100% ตามข้อ 5.6.2/3.3
  // ส่วนชื่อที่ใช้แสดงผลจะ lookup จาก auth table ตอน list (ดู lib/enrich.js)
  const statements = uuids.map((uuid) =>
    env.DB.prepare(
      `UPDATE register SET editor = ?, status = 'CHECKUP', updated_at = CURRENT_TIMESTAMP, updated_by = ?
       WHERE uuid = ? AND status = 'RECEIVED'`
    ).bind(editorRow.email, user.email, uuid)
  );

  await env.DB.batch(statements);

  await writeAudit(env, {
    email: user.email, username: user.username, action: 'assign_editor',
    detail: `กำหนดผู้ตรวจ ${editorRow.username} ให้ ${uuids.length} รายการ`,
    module: 'register'
  });
  await writeLog(env, { request, email: user.email, username: user.username, role: user.role, action: 'assign_editor', page: 'receive' });
  await notifyTelegram(
    env, 'assign_editor',
    `🧑‍💼 กำหนดผู้ตรวจ: ${editorRow.username}\nจำนวน ${uuids.length} รายการ\nโดย: ${user.username}`
  );

  return ok({ message: 'กำหนดผู้ตรวจสำเร็จ', editor: editorRow.username, count: uuids.length });
}

// ------------------------------------------------------------
// Dispatcher ของโมดูล Receive
// ------------------------------------------------------------
export async function handleReceiveRoutes(request, env, path) {
  const method = request.method;

  if (path === '/api/register/receive/pending' && method === 'GET') return handlePending(request, env);
  if (path === '/api/register/receive' && method === 'POST') return handleReceive(request, env);
  if (path === '/api/register/receive/received' && method === 'GET') return handleReceived(request, env);
  if (path === '/api/register/receive/assign-editor' && method === 'POST') return handleAssignEditor(request, env);

  return fail('ไม่พบ Endpoint นี้ใน Receive Module', 404);
}
