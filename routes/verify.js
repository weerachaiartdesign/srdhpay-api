// ============================================================
// routes/verify.js — บันทึกการตรวจสอบ (5.6): แก้ไข / รับคืน / ตรวจผ่าน
// ------------------------------------------------------------
// role editor: เห็น/ทำได้เฉพาะรายการที่ตนเองเป็นผู้ตรวจ (จับคู่ด้วย email)
// role admin/manager: เห็น/ทำได้ทุกรายการ
// ============================================================

import { ok, fail, readJsonBody } from '../lib/response.js';
import { requireAuth, requirePermission } from '../lib/auth-middleware.js';
import { writeAudit, writeLog } from '../lib/audit.js';
import { notifyTelegram } from '../lib/telegram.js';
import { withStatusDisplayList } from '../lib/status.js';
import { attachEditorNames } from '../lib/enrich.js';
import { parseDkNoDisplay } from '../lib/counters.js';
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
// GET /api/verify/list?action=edit|return|pass
// ------------------------------------------------------------
async function handleList(request, env) {
  const { user, error } = await requireAuth(request, env);
  if (error) return error;
  const permError = await requirePermission(env, user, 'verify');
  if (permError) return permError;

  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  const statusFor = { edit: 'CHECKUP', return: 'EDITING', pass: 'CHECKUP' };
  const targetStatus = statusFor[action];
  if (!targetStatus) return fail('action ไม่ถูกต้อง (ต้องเป็น edit, return หรือ pass)', 400);

  let where = `status = ?`;
  const params = [targetStatus];

  if (user.role === 'editor') {
    where += ` AND editor = ?`;
    params.push(user.email);
  }

  const { extra, params: extraParams } = buildSearchFilters(url);
  where += extra;
  params.push(...extraParams);

  const rows = await env.DB.prepare(
    `SELECT * FROM register WHERE ${where} ORDER BY receive_date ASC, receive_no_raw ASC`
  ).bind(...params).all();

  const enriched = await attachEditorNames(env, rows.results);
  return ok({ data: withStatusDisplayList(enriched) });
}

// ตรวจสอบสิทธิ์ความเป็นเจ้าของ + สถานะปัจจุบันถูกต้อง ก่อนดำเนินการ (ใช้ร่วมทุก action)
async function loadAndValidate(env, user, uuids, expectedStatus) {
  const placeholders = uuids.map(() => '?').join(',');
  const rows = (await env.DB.prepare(
    `SELECT * FROM register WHERE uuid IN (${placeholders})`
  ).bind(...uuids).all()).results;

  if (rows.length !== uuids.length) return { error: fail('มีบางรายการที่ไม่พบในระบบ', 404) };

  const wrongStatus = rows.filter((r) => r.status !== expectedStatus);
  if (wrongStatus.length > 0) {
    return { error: fail(`มีรายการที่ไม่อยู่ในสถานะที่ถูกต้อง กรุณาโหลดข้อมูลใหม่`, 409) };
  }

  if (user.role === 'editor') {
    const notOwned = rows.filter((r) => r.editor !== user.email);
    if (notOwned.length > 0) {
      return { error: fail('มีรายการที่ไม่ได้เป็นผู้ตรวจของท่าน', 403) };
    }
  }

  return { rows };
}

// ------------------------------------------------------------
// POST /api/verify/edit   { uuids: [...] }   CHECKUP -> EDITING
// ------------------------------------------------------------
async function handleEdit(request, env) {
  const { user, error } = await requireAuth(request, env);
  if (error) return error;
  const permError = await requirePermission(env, user, 'verify');
  if (permError) return permError;

  const body = await readJsonBody(request);
  const uuids = Array.isArray(body.uuids) ? body.uuids : [];
  if (uuids.length === 0) return fail('กรุณาเลือกรายการที่ต้องการส่งแก้ไข', 400);

  const { rows, error: valError } = await loadAndValidate(env, user, uuids, 'CHECKUP');
  if (valError) return valError;

  const today = todayForDb();
  const statements = uuids.map((uuid) =>
    env.DB.prepare(
      `UPDATE register SET edit_date = ?, status = 'EDITING', updated_at = CURRENT_TIMESTAMP, updated_by = ?
       WHERE uuid = ? AND status = 'CHECKUP'`
    ).bind(today, user.email, uuid)
  );
  await env.DB.batch(statements);

  await writeAudit(env, { email: user.email, username: user.username, action: 'edit', detail: `ส่งแก้ไข ${uuids.length} รายการ`, module: 'verify' });
  await writeLog(env, { request, email: user.email, username: user.username, role: user.role, action: 'edit', page: 'verify' });
  await notifyTelegram(env, 'edit', `✏️ ส่งแก้ไข ${uuids.length} รายการ โดย: ${user.username}`);

  return ok({ message: 'บันทึกส่งแก้ไขสำเร็จ', count: uuids.length });
}

// ------------------------------------------------------------
// POST /api/verify/return   { uuids: [...] }   EDITING -> CHECKUP
// ------------------------------------------------------------
async function handleReturn(request, env) {
  const { user, error } = await requireAuth(request, env);
  if (error) return error;
  const permError = await requirePermission(env, user, 'verify');
  if (permError) return permError;

  const body = await readJsonBody(request);
  const uuids = Array.isArray(body.uuids) ? body.uuids : [];
  if (uuids.length === 0) return fail('กรุณาเลือกรายการที่ต้องการรับคืน', 400);

  const { rows, error: valError } = await loadAndValidate(env, user, uuids, 'EDITING');
  if (valError) return valError;

  const today = todayForDb();
  const statements = uuids.map((uuid) =>
    env.DB.prepare(
      `UPDATE register SET return_date = ?, status = 'CHECKUP', updated_at = CURRENT_TIMESTAMP, updated_by = ?
       WHERE uuid = ? AND status = 'EDITING'`
    ).bind(today, user.email, uuid)
  );
  await env.DB.batch(statements);

  await writeAudit(env, { email: user.email, username: user.username, action: 'return', detail: `รับคืน ${uuids.length} รายการ`, module: 'verify' });
  await writeLog(env, { request, email: user.email, username: user.username, role: user.role, action: 'return', page: 'verify' });
  await notifyTelegram(env, 'return', `↩️ รับคืน ${uuids.length} รายการ โดย: ${user.username}`);

  return ok({ message: 'บันทึกรับคืนสำเร็จ', count: uuids.length });
}

// ------------------------------------------------------------
// POST /api/verify/pass   { items: [{ uuid, dk_no_display }] }   CHECKUP -> PASSED
// dk_no_display บังคับกรอกถ้า dk_no_raw เดิมยังว่าง (ข้อ 5.6.5 / 7.2)
// ------------------------------------------------------------
async function handlePass(request, env) {
  const { user, error } = await requireAuth(request, env);
  if (error) return error;
  const permError = await requirePermission(env, user, 'verify');
  if (permError) return permError;

  const body = await readJsonBody(request);
  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length === 0) return fail('กรุณาเลือกรายการที่ต้องการตรวจผ่าน', 400);

  const uuids = items.map((i) => i.uuid);
  const { rows, error: valError } = await loadAndValidate(env, user, uuids, 'CHECKUP');
  if (valError) return valError;

  const rowMap = new Map(rows.map((r) => [r.uuid, r]));
  const today = todayForDb();
  const statements = [];

  for (const item of items) {
    const existing = rowMap.get(item.uuid);
    let dkNoRaw = existing.dk_no_raw;
    let dkNoDisplay = existing.dk_no_display;

    if (!existing.dk_no_raw) {
      if (!item.dk_no_display) {
        return fail(`กรุณากรอกเลขที่ฎีกาให้ครบทุกแถวที่เลือก (ขาดที่: ${existing.request_no_display || existing.uuid})`, 400);
      }
      try {
        dkNoRaw = parseDkNoDisplay(item.dk_no_display);
        dkNoDisplay = item.dk_no_display;
      } catch {
        return fail(`รูปแบบเลขที่ฎีกาไม่ถูกต้อง (ต้องเป็น เลข/ปีงบ เช่น 1801/69)`, 400);
      }
    } else if (item.dk_no_display) {
      // อนุญาตให้แก้ไขเลขฎีกาตอนนี้ได้ถ้าต้องการ (ยังไม่ผ่านขั้นต่อไป)
      try {
        dkNoRaw = parseDkNoDisplay(item.dk_no_display);
        dkNoDisplay = item.dk_no_display;
      } catch {
        return fail(`รูปแบบเลขที่ฎีกาไม่ถูกต้อง`, 400);
      }
    }

    statements.push(
      env.DB.prepare(
        `UPDATE register SET pass_date = ?, dk_no_raw = ?, dk_no_display = ?, status = 'PASSED',
           updated_at = CURRENT_TIMESTAMP, updated_by = ?
         WHERE uuid = ? AND status = 'CHECKUP'`
      ).bind(today, dkNoRaw, dkNoDisplay, user.email, item.uuid)
    );
  }

  await env.DB.batch(statements);

  await writeAudit(env, { email: user.email, username: user.username, action: 'pass', detail: `ตรวจผ่าน ${items.length} รายการ`, module: 'verify' });
  await writeLog(env, { request, email: user.email, username: user.username, role: user.role, action: 'pass', page: 'verify' });
  await notifyTelegram(env, 'pass', `✅ ตรวจผ่าน ${items.length} รายการ โดย: ${user.username}`);

  return ok({ message: 'บันทึกตรวจผ่านสำเร็จ', count: items.length });
}

// ------------------------------------------------------------
// Dispatcher ของโมดูล Verify
// ------------------------------------------------------------
export async function handleVerifyRoutes(request, env, path) {
  const method = request.method;

  if (path === '/api/verify/list' && method === 'GET') return handleList(request, env);
  if (path === '/api/verify/edit' && method === 'POST') return handleEdit(request, env);
  if (path === '/api/verify/return' && method === 'POST') return handleReturn(request, env);
  if (path === '/api/verify/pass' && method === 'POST') return handlePass(request, env);

  return fail('ไม่พบ Endpoint นี้ใน Verify Module', 404);
}
