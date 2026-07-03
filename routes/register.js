// ============================================================
// routes/register.js — Import/ลงทะเบียน (5.4), List (5.3), Detail Popup
// ============================================================

import { ok, fail, readJsonBody } from '../lib/response.js';
import { requireAuth, requirePermission } from '../lib/auth-middleware.js';
import { writeAudit, writeLog } from '../lib/audit.js';
import { notifyTelegram } from '../lib/telegram.js';
import { withStatusDisplay, withStatusDisplayList } from '../lib/status.js';
import { attachEditorNames } from '../lib/enrich.js';
import {
  reserveCounterRange, registerCounterKey, buildRegisterNo,
  parseRequestNoDisplay, parseDkNoDisplay
} from '../lib/counters.js';
import { getFiscalYear, todayForDb, nowForDb } from '../lib/datetime.js';

async function getAppSetting(env, key, def) {
  const row = await env.DB.prepare(`SELECT value FROM settings_app WHERE key = ?`).bind(key).first();
  return row?.value ?? def;
}

// ถ้าค่าใหม่ไม่ว่าง ใช้ค่าใหม่ ไม่งั้นคงค่าเดิม (กติกา overwrite เฉพาะช่องที่ไม่ว่าง ข้อ 2.1/6.14)
function pick(newVal, oldVal) {
  if (newVal === undefined || newVal === null || newVal === '') return oldVal;
  return newVal;
}

// ------------------------------------------------------------
// POST /api/register/import   { rows: [...] }
// ------------------------------------------------------------
async function handleImportBatch(request, env) {
  const { user, error } = await requireAuth(request, env);
  if (error) return error;
  const permError = await requirePermission(env, user, 'import');
  if (permError) return permError;

  const body = await readJsonBody(request);
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length === 0) return fail('ไม่มีรายการที่จะลงทะเบียน', 400);

  // ---------- ตรวจ Limit ตาม role ----------
  const limitStaff = parseInt(await getAppSetting(env, 'import_limit_staff', '20'), 10);
  const limitAdmin = parseInt(await getAppSetting(env, 'import_limit_admin', '100'), 10);
  const limit = user.role === 'staff' ? limitStaff : limitAdmin;
  if (rows.length > limit) {
    return fail(`จำนวนรายการเกินกำหนด (สูงสุด ${limit} รายการต่อครั้งสำหรับสิทธิ์ของท่าน)`, 400);
  }

  // ---------- ตรวจช่วงวันที่อนุญาตนำเข้า (เฉพาะ staff) ----------
  if (user.role === 'staff') {
    const allowStart = await getAppSetting(env, 'import_allow_start', null);
    const allowEnd = await getAppSetting(env, 'import_allow_end', null);
    const today = todayForDb();
    if ((allowStart && today < allowStart) || (allowEnd && today > allowEnd)) {
      return fail('อยู่นอกช่วงเวลาที่อนุญาตให้นำเข้าข้อมูล กรุณาติดต่อผู้ดูแลระบบ', 403);
    }
  }

  // ---------- ดึงข้อมูลผู้ใช้ปัจจุบัน (สำหรับ default dept/sender) ----------
  const authRow = await env.DB.prepare(`SELECT username, dept FROM auth WHERE email = ?`).bind(user.email).first();

  // ---------- Validate รายแถว + เตรียมข้อมูล ----------
  const prepared = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rowNo = i + 1;

    if (!r.money_type) return fail(`แถวที่ ${rowNo}: กรุณาเลือกประเภทเงิน`, 400);
    if (!r.vendor) return fail(`แถวที่ ${rowNo}: กรุณาเลือกชื่อเจ้าหนี้/บริษัท`, 400);
    if (!r.amount || Number(r.amount) <= 0) return fail(`แถวที่ ${rowNo}: จำนวนเงินขอเบิกไม่ถูกต้อง`, 400);
    if (!r.description) return fail(`แถวที่ ${rowNo}: กรุณากรอกรายการ`, 400);
    if (!r.request_no_display) return fail(`แถวที่ ${rowNo}: กรุณากรอกเลขที่ใบขอเบิก`, 400);

    let requestNoRaw;
    try {
      requestNoRaw = parseRequestNoDisplay(r.request_no_display);
    } catch {
      return fail(`แถวที่ ${rowNo}: รูปแบบเลขที่ใบขอเบิกไม่ถูกต้อง (ต้องเป็น เลข/ปีงบ เช่น 1/69)`, 400);
    }

    let dkNoRaw = null;
    if (r.dk_no_display) {
      try {
        dkNoRaw = parseDkNoDisplay(r.dk_no_display);
      } catch {
        return fail(`แถวที่ ${rowNo}: รูปแบบเลขที่ฎีกาไม่ถูกต้อง (ต้องเป็น เลข/ปีงบ เช่น 1801/69)`, 400);
      }
    }

    // dept/sender: staff แก้ไม่ได้ ใช้ของตัวเองเสมอ / admin-manager ใช้ค่าที่ส่งมาได้ถ้ามี
    const dept = user.role === 'staff' ? authRow.dept : (r.dept || authRow.dept);
    const sender = user.role === 'staff' ? authRow.username : (r.sender || authRow.username);

    prepared.push({
      money_type: r.money_type,
      dept,
      sender,
      reserve_no: r.reserve_no || null,
      reserve_amount: Number(r.reserve_amount) || 0,
      egp_no: r.egp_no || null,
      invoice: r.invoice || null,
      vendor: r.vendor,
      amount: Number(r.amount),
      description: String(r.description).split('\n')[0], // ใช้เฉพาะบรรทัดแรก (ข้อ 5.4.2.3)
      request_no_raw: requestNoRaw,
      request_no_display: r.request_no_display,
      dk_no_raw: dkNoRaw,
      dk_no_display: r.dk_no_display || null,
      source: r.source === 'IMPORT' ? 'IMPORT' : 'MANUAL'
    });
  }

  // ---------- ตรวจซ้ำ (request_no_raw + money_type) ----------
  const requestNos = [...new Set(prepared.map((p) => p.request_no_raw))];
  const placeholders = requestNos.map(() => '?').join(',');
  const existingRows = requestNos.length
    ? (await env.DB.prepare(
        `SELECT * FROM register WHERE request_no_raw IN (${placeholders})`
      ).bind(...requestNos).all()).results
    : [];

  const existingMap = new Map();
  for (const e of existingRows) {
    existingMap.set(`${e.request_no_raw}::${e.money_type}`, e);
  }

  const toCreate = [];
  const toUpdate = [];
  for (const p of prepared) {
    const key = `${p.request_no_raw}::${p.money_type}`;
    const existing = existingMap.get(key);
    if (existing) {
      toUpdate.push({ ...p, existing });
    } else {
      toCreate.push(p);
    }
  }

  const countInBatch = toCreate.length + toUpdate.length; // COUNT3 (ข้อ 6.7: นับรวม create+update)
  const fiscalYear = getFiscalYear();
  const today = todayForDb();

  // ---------- จองเลขทะเบียน (ใช้กับรายการสร้างใหม่เท่านั้น) ----------
  const seq = await reserveCounterRange(env.DB, registerCounterKey(fiscalYear), fiscalYear, 1);
  const registerNo = buildRegisterNo(fiscalYear, countInBatch, seq);

  // ---------- เตรียม Batch Statement (Atomic) ----------
  const statements = [];

  for (const p of toCreate) {
    const uuid = crypto.randomUUID();
    statements.push(
      env.DB.prepare(
        `INSERT INTO register (
           uuid, money_type, dept, sender, reserve_no, reserve_amount, invoice, vendor, amount,
           description, register_no_raw, register_no_display, register_date,
           request_no_raw, request_no_display, dk_no_raw, dk_no_display, egp_no,
           status, source, created_by, updated_by
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        uuid, p.money_type, p.dept, p.sender, p.reserve_no, p.reserve_amount, p.invoice, p.vendor, p.amount,
        p.description, registerNo.raw, registerNo.display, today,
        p.request_no_raw, p.request_no_display, p.dk_no_raw, p.dk_no_display, p.egp_no,
        'WAITING', p.source, user.email, user.email
      )
    );
  }

  for (const p of toUpdate) {
    const e = p.existing;
    statements.push(
      env.DB.prepare(
        `UPDATE register SET
           dept = ?, sender = ?, reserve_no = ?, reserve_amount = ?, invoice = ?, vendor = ?, amount = ?,
           description = ?, dk_no_raw = ?, dk_no_display = ?, egp_no = ?, source = ?,
           updated_at = CURRENT_TIMESTAMP, updated_by = ?
         WHERE uuid = ?`
      ).bind(
        pick(p.dept, e.dept), pick(p.sender, e.sender), pick(p.reserve_no, e.reserve_no),
        pick(p.reserve_amount, e.reserve_amount), pick(p.invoice, e.invoice), pick(p.vendor, e.vendor),
        pick(p.amount, e.amount), pick(p.description, e.description), pick(p.dk_no_raw, e.dk_no_raw),
        pick(p.dk_no_display, e.dk_no_display), pick(p.egp_no, e.egp_no), p.source,
        user.email, e.uuid
      )
    );
  }

  // ---------- Execute แบบ Atomic ทั้ง Batch (ข้อ 6.13) ----------
  await env.DB.batch(statements);

  // ---------- Audit / Log / Telegram ----------
  await writeAudit(env, {
    email: user.email, username: user.username, action: 'import',
    detail: `ลงทะเบียน ${registerNo.display} จำนวน ${countInBatch} รายการ (สร้างใหม่ ${toCreate.length}, อัปเดต ${toUpdate.length})`,
    module: 'register'
  });
  await writeLog(env, {
    request, email: user.email, username: user.username, role: user.role,
    action: 'import', page: 'import', detail: registerNo.display
  });
  await notifyTelegram(
    env, 'import',
    `📥 นำเข้าข้อมูลสำเร็จ\nเลขที่ลงทะเบียน: ${registerNo.display}\nจำนวน: ${countInBatch} รายการ\nโดย: ${user.username}`
  );

  return ok({
    register_no_raw: registerNo.raw,
    register_no_display: registerNo.display,
    total: countInBatch,
    created: toCreate.length,
    updated: toUpdate.length
  });
}

// ------------------------------------------------------------
// GET /api/register/list  (ทะเบียนเบิกจ่ายเงิน - 5.3)
// ------------------------------------------------------------
async function handleList(request, env) {
  const { user, error } = await requireAuth(request, env);
  if (error) return error;
  const permError = await requirePermission(env, user, 'list');
  if (permError) return permError;

  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const allowedPageSizes = [50, 100, 200, 500];
  let pageSize = parseInt(url.searchParams.get('pageSize') || '50', 10);
  if (!allowedPageSizes.includes(pageSize)) pageSize = 50;
  const sort = url.searchParams.get('sort') === 'oldest' ? 'ASC' : 'DESC'; // default ล่าสุดก่อน
  const search = url.searchParams.get('search') || '';
  const moneyType = url.searchParams.get('money_type') || '';
  const dept = url.searchParams.get('dept') || '';
  const status = url.searchParams.get('status') || '';

  // ไม่แสดงผลสถานะ "รอเอกสาร" และ "ยกเลิก" เสมอ (ข้อ 5.3.1)
  let where = `status NOT IN ('WAITING', 'CANCELLED')`;
  const params = [];

  if (search) {
    where += ` AND (money_type LIKE ? OR dept LIKE ? OR vendor LIKE ? OR description LIKE ?
                OR CAST(amount AS TEXT) LIKE ? OR receive_no_display LIKE ?
                OR request_no_display LIKE ? OR dk_no_display LIKE ?)`;
    const s = `%${search}%`;
    params.push(s, s, s, s, s, s, s, s);
  }
  if (moneyType) { where += ` AND money_type = ?`; params.push(moneyType); }
  if (dept) { where += ` AND dept = ?`; params.push(dept); }
  if (status) { where += ` AND status = ?`; params.push(status); }

  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) as total FROM register WHERE ${where}`
  ).bind(...params).first();
  const total = countRow?.total || 0;

  const offset = (page - 1) * pageSize;
  const rows = await env.DB.prepare(
    `SELECT * FROM register WHERE ${where}
     ORDER BY receive_date ${sort}, receive_no_raw ${sort}
     LIMIT ? OFFSET ?`
  ).bind(...params, pageSize, offset).all();

  const enriched = await attachEditorNames(env, rows.results);
  return ok({
    data: withStatusDisplayList(enriched),
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) }
  });
}

// ------------------------------------------------------------
// GET /api/register/:uuid  (Popup รายละเอียดรายการ)
// ------------------------------------------------------------
async function handleGetOne(request, env, uuid) {
  const { user, error } = await requireAuth(request, env);
  if (error) return error;
  const permError = await requirePermission(env, user, 'list');
  if (permError) return permError;

  const row = await env.DB.prepare(`SELECT * FROM register WHERE uuid = ?`).bind(uuid).first();
  if (!row) return fail('ไม่พบรายการนี้', 404);

  // guest/role ทั่วไปห้ามเห็นรายการที่ถูกยกเลิก (ยกเว้นหน้าตั้งค่าโปรแกรม > แก้ไขข้อมูลรายการ ใน Part 5)
  if (row.status === 'CANCELLED') {
    return fail('รายการนี้ถูกยกเลิกแล้ว', 404);
  }

  const [enrichedRow] = await attachEditorNames(env, [row]);
  return ok({ data: withStatusDisplay(enrichedRow) });
}

// ------------------------------------------------------------
// Dispatcher ของโมดูล Register (Import + List + Detail)
// Receive/Verify/Approve/Payment/Cancel จะอยู่ใน routes อื่นที่เพิ่มใน Part ถัดไป
// ------------------------------------------------------------
export async function handleRegisterRoutes(request, env, path) {
  const method = request.method;

  if (path === '/api/register/import' && method === 'POST') return handleImportBatch(request, env);
  if (path === '/api/register/list' && method === 'GET') return handleList(request, env);

  const detailMatch = path.match(/^\/api\/register\/([0-9a-fA-F-]{36})$/);
  if (detailMatch && method === 'GET') return handleGetOne(request, env, detailMatch[1]);

  return fail('ไม่พบ Endpoint นี้ใน Register Module', 404);
}
