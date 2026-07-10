// ============================================================
// routes/settings.js — ตั้งค่าโปรแกรม (5.11)
// ============================================================

import { ok, fail, readJsonBody } from '../lib/response.js';
import { requireAuth, requirePermission } from '../lib/auth-middleware.js';
import { writeAudit } from '../lib/audit.js';
import { withStatusDisplayList } from '../lib/status.js';
import { computeStatusFromFields } from '../lib/status.js';
import { attachEditorNames } from '../lib/enrich.js';
import { parseRequestNoDisplay, parseDkNoDisplay } from '../lib/counters.js';

// ------------------------------------------------------------
// 5.11.1 กำหนดปีงบประมาณ
// ------------------------------------------------------------
const FISCAL_KEYS = ['fiscal_year', 'fiscal_year_short', 'fiscal_start_date', 'fiscal_end_date', 'import_allow_start', 'import_allow_end', 'import_limit_staff', 'import_limit_admin'];

async function handleGetFiscalYear(env) {
  const placeholders = FISCAL_KEYS.map(() => '?').join(',');
  const rows = (await env.DB.prepare(`SELECT key, value FROM settings_app WHERE key IN (${placeholders})`).bind(...FISCAL_KEYS).all()).results;
  const data = {};
  for (const r of rows) data[r.key] = r.value;
  return ok({ data });
}

async function handleUpdateFiscalYear(request, env, user) {
  const body = await readJsonBody(request);
  const statements = FISCAL_KEYS.filter((k) => body[k] !== undefined).map((k) =>
    env.DB.prepare(`UPDATE settings_app SET value = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE key = ?`)
      .bind(String(body[k]), user.email, k)
  );
  if (statements.length === 0) return fail('ไม่มีข้อมูลที่ต้องการแก้ไข', 400);
  await env.DB.batch(statements);
  await writeAudit(env, { email: user.email, username: user.username, action: 'settings_change', detail: 'แก้ไขปีงบประมาณ', module: 'settings' });
  return ok({ message: 'บันทึกการตั้งค่าปีงบประมาณสำเร็จ' });
}

// ------------------------------------------------------------
// 5.11.5 กำหนดการแสดงผล
// ------------------------------------------------------------
const DISPLAY_KEYS = ['dashboard_top_money_type', 'dashboard_top_dept', 'dashboard_top_money'];

async function handleGetDisplay(env) {
  const placeholders = DISPLAY_KEYS.map(() => '?').join(',');
  const rows = (await env.DB.prepare(`SELECT key, value FROM settings_app WHERE key IN (${placeholders})`).bind(...DISPLAY_KEYS).all()).results;
  const data = {};
  for (const r of rows) data[r.key] = r.value;
  return ok({ data });
}

async function handleUpdateDisplay(request, env, user) {
  const body = await readJsonBody(request);
  const statements = DISPLAY_KEYS.filter((k) => body[k] !== undefined).map((k) =>
    env.DB.prepare(`UPDATE settings_app SET value = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE key = ?`)
      .bind(String(body[k]), user.email, k)
  );
  if (statements.length === 0) return fail('ไม่มีข้อมูลที่ต้องการแก้ไข', 400);
  await env.DB.batch(statements);
  await writeAudit(env, { email: user.email, username: user.username, action: 'settings_change', detail: 'แก้ไขการตั้งค่าการแสดงผล', module: 'settings' });
  return ok({ message: 'บันทึกการตั้งค่าการแสดงผลสำเร็จ' });
}

// ------------------------------------------------------------
// 5.11.2 / 5.11.3 / (เพิ่ม) หน่วยงาน : ตาราง Lookup ทั่วไป
// ------------------------------------------------------------
const LOOKUP_TABLES = {
  'money-types': { table: 'settings_money_type', fields: ['name', 'color', 'sort_order', 'active'], orderBy: 'sort_order' },
  vendors: { table: 'settings_vendor', fields: ['name', 'active'], orderBy: 'name' },
  depts: { table: 'settings_dept', fields: ['name', 'sort_order', 'active'], orderBy: 'sort_order' }
};

async function handleLookupList(env, key, url) {
  const cfg = LOOKUP_TABLES[key];
  const search = url.searchParams.get('search') || '';
  const all = url.searchParams.get('all') === '1'; // ถ้าส่ง ?all=1 ดึงทั้งหมด (ใช้ใน dropdown)
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const pageSize = 50;

  let where = '1=1';
  const params = [];
  if (search) { where += ` AND name LIKE ?`; params.push(`%${search}%`); }

  const countRow = await env.DB.prepare(`SELECT COUNT(*) as total FROM ${cfg.table} WHERE ${where}`).bind(...params).first();

  let rows;
  if (all) {
    rows = await env.DB.prepare(
      `SELECT * FROM ${cfg.table} WHERE ${where} ORDER BY ${cfg.orderBy}`
    ).bind(...params).all();
  } else {
    rows = await env.DB.prepare(
      `SELECT * FROM ${cfg.table} WHERE ${where} ORDER BY ${cfg.orderBy} LIMIT ? OFFSET ?`
    ).bind(...params, pageSize, (page - 1) * pageSize).all();
  }

  return ok({ data: rows.results, total: countRow?.total || 0, page, pageSize });
}

async function handleLookupCreate(request, env, user, key) {
  const cfg = LOOKUP_TABLES[key];
  const body = await readJsonBody(request);
  if (!body.name) return fail('กรุณากรอกชื่อ', 400);

  const cols = cfg.fields.filter((f) => f !== 'active');
  const values = cols.map((f) => {
    if (body[f] !== undefined) return body[f];
    if (f === 'color') return '#808080';
    if (f === 'sort_order') return 99;
    return null;
  });

  try {
    await env.DB.prepare(`INSERT INTO ${cfg.table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).bind(...values).run();
  } catch {
    return fail('ชื่อนี้มีอยู่แล้วในระบบ', 409);
  }

  await writeAudit(env, { email: user.email, username: user.username, action: 'settings_change', detail: `เพิ่ม ${key}: ${body.name}`, module: 'settings' });
  return ok({ message: 'เพิ่มข้อมูลสำเร็จ' });
}

async function handleLookupUpdate(request, env, user, key, id) {
  const cfg = LOOKUP_TABLES[key];
  const body = await readJsonBody(request);
  const before = await env.DB.prepare(`SELECT * FROM ${cfg.table} WHERE id = ?`).bind(id).first();
  if (!before) return fail('ไม่พบข้อมูล', 404);

  const setParts = [];
  const values = [];
  for (const f of cfg.fields) {
    if (body[f] === undefined) continue;
    setParts.push(`${f} = ?`);
    values.push(f === 'active' ? (body[f] ? 1 : 0) : body[f]);
  }
  if (setParts.length === 0) return fail('ไม่มีข้อมูลที่ต้องการแก้ไข', 400);

  await env.DB.prepare(`UPDATE ${cfg.table} SET ${setParts.join(', ')} WHERE id = ?`).bind(...values, id).run();
  const after = await env.DB.prepare(`SELECT * FROM ${cfg.table} WHERE id = ?`).bind(id).first();
  await writeAudit(env, { email: user.email, username: user.username, action: 'settings_change', before, after, detail: `แก้ไข ${key} id=${id}`, module: 'settings' });
  return ok({ message: 'แก้ไขข้อมูลสำเร็จ' });
}

async function handleLookupDelete(env, user, key, id) {
  const cfg = LOOKUP_TABLES[key];
  const before = await env.DB.prepare(`SELECT * FROM ${cfg.table} WHERE id = ?`).bind(id).first();
  if (!before) return fail('ไม่พบข้อมูล', 404);
  await env.DB.prepare(`DELETE FROM ${cfg.table} WHERE id = ?`).bind(id).run();
  await writeAudit(env, { email: user.email, username: user.username, action: 'settings_change', before, detail: `ลบ ${key} id=${id}`, module: 'settings' });
  return ok({ message: 'ลบข้อมูลสำเร็จ' });
}

// ------------------------------------------------------------
// 5.11.4 รายชื่อผู้ตรวจ (ดึงจาก auth.role = editor)
// ------------------------------------------------------------
async function handleEditorsList(request, env) {
  const url = new URL(request.url);
  const search = url.searchParams.get('search') || '';
  let query = `SELECT id, email, username, active FROM auth WHERE role = 'editor'`;
  const params = [];
  if (search) { query += ` AND username LIKE ?`; params.push(`%${search}%`); }
  query += ` ORDER BY username`;
  const rows = await env.DB.prepare(query).bind(...params).all();
  return ok({ data: rows.results });
}

// ------------------------------------------------------------
// 5.11.6 แก้ไขข้อมูลรายการ — ค้นหาได้ "ทุกสถานะ" รวมยกเลิก (ต่างจาก /api/register/list)
// ------------------------------------------------------------
const SEARCH_FIELD_MAP = {
  status: 'status',
  receive_no: 'receive_no_display',
  request_no: 'request_no_display',
  dk_no: 'dk_no_display',
  money_type: 'money_type',
  dept: 'dept',
  sender: 'sender',
  invoice: 'invoice',
  egp_no: 'egp_no',
  vendor: 'vendor',
  description: 'description',
  amount: 'amount'
};

async function handleRegisterSearch(request, env) {
  const url = new URL(request.url);
  const field = url.searchParams.get('field') || '';
  const keyword = url.searchParams.get('keyword') || '';

  let where = '1=1';
  const params = [];

  if (keyword) {
    if (field && SEARCH_FIELD_MAP[field]) {
      where += ` AND CAST(${SEARCH_FIELD_MAP[field]} AS TEXT) LIKE ?`;
      params.push(`%${keyword}%`);
    } else {
      // ค่าว่าง = หาจากทุกประเภท (ข้อ 5.11.6)
      const cols = Object.values(SEARCH_FIELD_MAP);
      where += ` AND (${cols.map((c) => `CAST(${c} AS TEXT) LIKE ?`).join(' OR ')})`;
      params.push(...cols.map(() => `%${keyword}%`));
    }
  }

  const rows = await env.DB.prepare(
    `SELECT * FROM register WHERE ${where} ORDER BY created_at DESC LIMIT 200`
  ).bind(...params).all();

  const enriched = await attachEditorNames(env, rows.results);
  return ok({ data: withStatusDisplayList(enriched) });
}

// แก้ไขรายการ (ทุกฟิลด์ที่อนุญาต) — REGISTER_NO/RECEIVE_NO แก้ไม่ได้เสมอ (ข้อ 5.11.6)
const EDITABLE_FIELDS = [
  'request_no_display', 'dk_no_display', 'money_type', 'dept', 'sender',
  'reserve_no', 'reserve_amount', 'egp_no', 'invoice', 'vendor', 'amount', 'description',
  'edit_date', 'return_date', 'pass_date', 'propose_date', 'approve_date', 'editor'
];

async function handleRegisterEdit(request, env, user, uuid) {
  const before = await env.DB.prepare(`SELECT * FROM register WHERE uuid = ?`).bind(uuid).first();
  if (!before) return fail('ไม่พบรายการนี้', 404);
  if (before.status === 'PAID' && user.role !== 'admin') {
    return fail('รายการนี้จ่ายเช็คไปแล้ว เฉพาะ Admin เท่านั้นที่แก้ไขได้', 403);
  }

  const body = await readJsonBody(request);
  const setParts = [];
  const values = [];

  for (const f of EDITABLE_FIELDS) {
    if (body[f] === undefined) continue;
    if (f === 'request_no_display') {
      try {
        setParts.push('request_no_display = ?', 'request_no_raw = ?');
        values.push(body[f], parseRequestNoDisplay(body[f]));
      } catch {
        return fail('รูปแบบเลขที่ใบขอเบิกไม่ถูกต้อง', 400);
      }
    } else if (f === 'dk_no_display') {
      try {
        setParts.push('dk_no_display = ?', 'dk_no_raw = ?');
        values.push(body[f] || null, body[f] ? parseDkNoDisplay(body[f]) : null);
      } catch {
        return fail('รูปแบบเลขที่ฎีกาไม่ถูกต้อง', 400);
      }
    } else {
      setParts.push(`${f} = ?`);
      values.push(body[f]);
    }
  }
  if (setParts.length === 0) return fail('ไม่มีข้อมูลที่ต้องการแก้ไข', 400);

  // คำนวณสถานะใหม่จากค่าฟิลด์วันที่หลังแก้ไข (เผื่อ admin แก้/ลบวันที่ย้อนหลัง) แล้วเก็บ status ให้ตรงกันเสมอ
  // ไม่แตะ status ถ้ารายการนี้เป็น CANCELLED อยู่ (ต้องกู้คืนผ่าน /api/register/restore เท่านั้น)
  if (before.status !== 'CANCELLED') {
    const merged = { ...before };
    for (const f of EDITABLE_FIELDS) {
      if (body[f] === undefined) continue;
      if (f === 'request_no_display' || f === 'dk_no_display') continue; // ไม่กระทบการคำนวณสถานะ
      merged[f] = body[f];
    }
    const newStatus = computeStatusFromFields(merged);
    if (newStatus !== before.status) {
      setParts.push('status = ?');
      values.push(newStatus);
    }
  }

  setParts.push('updated_at = CURRENT_TIMESTAMP', 'updated_by = ?');
  values.push(user.email);

  await env.DB.prepare(`UPDATE register SET ${setParts.join(', ')} WHERE uuid = ?`).bind(...values, uuid).run();
  const after = await env.DB.prepare(`SELECT * FROM register WHERE uuid = ?`).bind(uuid).first();

  await writeAudit(env, {
    email: user.email, username: user.username, action: 'update', uuid, before, after,
    detail: before.status === 'PAID' ? 'Admin Override แก้ไขรายการที่จ่ายแล้ว' : 'แก้ไขข้อมูลรายการ',
    module: 'settings'
  });

  return ok({ message: 'บันทึกการแก้ไขสำเร็จ', data: after });
}

// ------------------------------------------------------------
// 5.11.7 Backup & Restore
// ------------------------------------------------------------
function toCsv(rows) {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => `"${String(row[h] ?? '').replace(/"/g, '""')}"`).join(','));
  }
  return lines.join('\n');
}

async function handleBackupExport(request, env, user) {
  const url = new URL(request.url);
  const format = url.searchParams.get('format') || 'json';
  const rows = (await env.DB.prepare(`SELECT * FROM register ORDER BY created_at`).all()).results;

  await writeAudit(env, { email: user.email, username: user.username, action: 'backup', detail: `Export ${format} จำนวน ${rows.length} แถว`, module: 'settings' });

  if (format === 'csv') {
    return new Response(toCsv(rows), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="register_backup.csv"'
      }
    });
  }
  // json: สำหรับ .xlsx ให้ Frontend ใช้ SheetJS แปลง JSON นี้เป็นไฟล์ .xlsx ที่ฝั่ง Browser เอง (ไม่ต้องมี library ฝั่ง Worker)
  return ok({ data: rows });
}

async function handleRestore(request, env, user) {
  if (user.role !== 'admin') return fail('เฉพาะ Admin เท่านั้นที่ Restore ข้อมูลได้', 403);

  const body = await readJsonBody(request);
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length === 0) return fail('ไม่มีข้อมูลสำหรับ Restore', 400);

  const columns = [
    'uuid', 'money_type', 'dept', 'sender', 'reserve_no', 'reserve_amount', 'invoice', 'vendor', 'amount', 'description',
    'register_no_raw', 'register_no_display', 'register_date', 'receive_no_raw', 'receive_no_display', 'receive_date',
    'editor', 'edit_date', 'return_date', 'request_no_raw', 'request_no_display', 'dk_no_raw', 'dk_no_display',
    'pass_date', 'propose_date', 'approve_date', 'pay_date', 'cancel_date', 'cancel_note', 'cancel_status', 'cancel_change',
    'egp_no', 'status', 'source', 'created_by', 'updated_by'
  ];
  const updatableCols = columns.filter((c) => c !== 'uuid');

  const statements = rows.map((r) =>
    env.DB.prepare(
      `INSERT INTO register (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})
       ON CONFLICT(uuid) DO UPDATE SET ${updatableCols.map((c) => `${c} = excluded.${c}`).join(', ')}`
    ).bind(...columns.map((c) => r[c] ?? null))
  );

  await env.DB.batch(statements);
  await writeAudit(env, { email: user.email, username: user.username, action: 'restore', detail: `Restore ${rows.length} แถว`, module: 'settings' });
  return ok({ message: 'Restore ข้อมูลสำเร็จ', count: rows.length });
}

// ------------------------------------------------------------
// Dispatcher ของโมดูล Settings
// ------------------------------------------------------------
export async function handleSettingsRoutes(request, env, path) {
  const { user, error } = await requireAuth(request, env);
  if (error) return error;

  const method = request.method;
  const url = new URL(request.url);

  // ----- อ่านข้อมูล Lookup (ประเภทเงิน/เจ้าหนี้/หน่วยงาน) เปิดให้ทุก role ที่ login แล้ว -----
  // เพราะใช้แสดง dropdown และสีป้ายกำกับในหลายหน้า (import, list, dashboard ฯลฯ)
  // ส่วนการแก้ไข/เพิ่ม/ลบ (POST/PUT/DELETE) ยังคงจำกัดสิทธิ์ไว้ด้านล่าง
  const lookupReadMatch = path.match(/^\/api\/settings\/(money-types|vendors|depts)$/);
  if (lookupReadMatch && method === 'GET') {
    return handleLookupList(env, lookupReadMatch[1], url);
  }

  const permError = await requirePermission(env, user, 'settings');
  if (permError) return permError;

  if (path === '/api/settings/fiscal-year' && method === 'GET') return handleGetFiscalYear(env);
  if (path === '/api/settings/fiscal-year' && method === 'PUT') return handleUpdateFiscalYear(request, env, user);

  if (path === '/api/settings/display' && method === 'GET') return handleGetDisplay(env);
  if (path === '/api/settings/display' && method === 'PUT') return handleUpdateDisplay(request, env, user);

  if (path === '/api/settings/editors' && method === 'GET') return handleEditorsList(request, env);

  if (path === '/api/settings/register-search' && method === 'GET') return handleRegisterSearch(request, env);

  const editMatch = path.match(/^\/api\/settings\/register\/([0-9a-fA-F-]{36})$/);
  if (editMatch && method === 'PUT') return handleRegisterEdit(request, env, user, editMatch[1]);

  if (path === '/api/settings/backup' && method === 'GET') return handleBackupExport(request, env, user);
  if (path === '/api/settings/restore' && method === 'POST') return handleRestore(request, env, user);

  const lookupListMatch = path.match(/^\/api\/settings\/(money-types|vendors|depts)$/);
  if (lookupListMatch && method === 'POST') {
    return handleLookupCreate(request, env, user, lookupListMatch[1]);
  }
  const lookupItemMatch = path.match(/^\/api\/settings\/(money-types|vendors|depts)\/(\d+)$/);
  if (lookupItemMatch) {
    const key = lookupItemMatch[1];
    const id = parseInt(lookupItemMatch[2], 10);
    if (method === 'PUT') return handleLookupUpdate(request, env, user, key, id);
    if (method === 'DELETE') return handleLookupDelete(env, user, key, id);
  }

  return fail('ไม่พบ Endpoint นี้ใน Settings Module', 404);
}
