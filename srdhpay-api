// ============================================================
// SRDH PAY - Backend API Worker
// Cloudflare Workers + D1 | Version 1.0.0
// ============================================================

// ============================================================
// SECTION 1: CONSTANTS
// ============================================================

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

const STATUS_MAP = {
  WAITING:   'รอเอกสาร',
  RECEIVED:  'รับเข้าระบบ',
  CHECKUP:   'ตรวจสอบ',
  EDITING:   'ส่งแก้ไข',
  PASSED:    'ตรวจผ่าน',
  PROPOSED:  'เสนอ',
  APPROVED:  'อนุมัติ',
  PAID:      'จ่ายแล้ว',
  CANCELLED: 'ยกเลิก',
};

const STATUS_ORDER = [
  'WAITING','RECEIVED','CHECKUP','EDITING',
  'PASSED','PROPOSED','APPROVED','PAID','CANCELLED',
];

// ============================================================
// SECTION 2: HELPERS
// ============================================================

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}

function handleOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

function generateUUID() {
  return crypto.randomUUID();
}

function generateToken() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  return 'srdh_' + Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

function generateGuestId() {
  const chars = '0123456789ABCDEF';
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return 'G-' + Array.from(bytes).map(b => chars[b % 16]).join('');
}

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const buf  = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

function getFY2(fiscalYear) {
  return String(fiscalYear).slice(-2);
}

function formatDate(date) {
  if (!date) return null;
  return new Date(date).toISOString().split('T')[0](undefined);
}

function formatDateTime() {
  return new Date().toISOString().replace('T', ' ').split('.')[0](undefined);
}

function parseRequestNo(display) {
  if (!display || !String(display).includes('/')) return display || '';
  const [num, fy] = String(display).split('/');
  return `${fy.trim()}${String(parseInt(num.trim())).padStart(7, '0')}`;
}

function formatRequestNo(raw) {
  if (!raw || String(raw).length < 9) return raw || '';
  const fy  = String(raw).substring(0, 2);
  const num = parseInt(String(raw).substring(2));
  return `${num}/${fy}`;
}

function parseDkNo(display) {
  if (!display || !String(display).includes('/')) return display || '';
  const [num, fy] = String(display).split('/');
  return `${fy.trim()}${String(parseInt(num.trim())).padStart(7, '0')}`;
}

function formatDkNo(raw) {
  if (!raw || String(raw).length < 9) return raw || '';
  const fy  = String(raw).substring(0, 2);
  const num = parseInt(String(raw).substring(2));
  return `${num}/${fy}`;
}

function formatRegisterNo(raw) {
  if (!raw) return '';
  return `RG${raw}`;
}

function formatReceiveNo(raw) {
  if (!raw || String(raw).length < 6) return raw || '';
  const fy  = String(raw).substring(0, 2);
  const seq = String(raw).substring(2);
  return `ID${fy}-${seq.padStart(4, '0')}`;
}

// ============================================================
// SECTION 3: SETTINGS HELPERS
// ============================================================

async function getSetting(env, key, defaultValue = '') {
  try {
    const row = await env.DB.prepare(
      `SELECT value FROM settings_app WHERE key = ?`
    ).bind(key).first();
    return row ? row.value : defaultValue;
  } catch {
    return defaultValue;
  }
}

async function getSystemSetting(env, key, defaultValue = '') {
  try {
    const row = await env.DB.prepare(
      `SELECT value FROM settings_system WHERE key = ?`
    ).bind(key).first();
    return row ? row.value : defaultValue;
  } catch {
    return defaultValue;
  }
}

async function getFiscalYearSetting(env) {
  const fy = await getSetting(env, 'fiscal_year', '2569');
  return parseInt(fy);
}

// ============================================================
// SECTION 4: AUDIT & ACTIVITY LOGGING
// ============================================================

async function auditLog(env, { email, username, action, uuid, before_json, after_json, detail, module: mod }) {
  try {
    await env.DB.prepare(
      `INSERT INTO audit_logs
         (email, username, action, uuid, before_json, after_json, detail, module)
       VALUES (?,?,?,?,?,?,?,?)`
    ).bind(
      email   || 'system',
      username || 'System',
      action,
      uuid    || null,
      before_json ? JSON.stringify(before_json) : null,
      after_json  ? JSON.stringify(after_json)  : null,
      detail  || null,
      mod     || 'general'
    ).run();
  } catch (e) {
    console.error('auditLog error:', e);
  }
}

async function activityLog(env, { email, username, role, action, page, detail, ip, user_agent, token_id }) {
  try {
    await env.DB.prepare(
      `INSERT INTO logs
         (email, username, role, action, page, detail, ip, user_agent, token_id)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).bind(
      email      || null,
      username   || null,
      role       || null,
      action,
      page       || null,
      detail     || null,
      ip         || null,
      user_agent || null,
      token_id   || null
    ).run();
  } catch (e) {
    console.error('activityLog error:', e);
  }
}

// ============================================================
// SECTION 5: SESSION & PERMISSION
// ============================================================

async function validateSession(env, token) {
  if (!token) return null;
  try {
    return await env.DB.prepare(
      `SELECT s.token, s.email, s.role, s.username, s.guest_flag,
              a.dept as user_dept, a.position, a.darkmode, a.force_change_password, a.active as user_active
       FROM sessions s
       JOIN auth a ON s.email = a.email
       WHERE s.token = ? AND s.active = 1 AND s.expire_at > datetime('now')`
    ).bind(token).first();
  } catch {
    return null;
  }
}

async function validateGuestSession(env, token) {
  if (!token) return null;
  try {
    return await env.DB.prepare(
      `SELECT * FROM sessions
       WHERE token = ? AND active = 1 AND guest_flag = 1 AND expire_at > datetime('now')`
    ).bind(token).first();
  } catch {
    return null;
  }
}

async function checkPermission(env, role, mod) {
  try {
    const row = await env.DB.prepare(
      `SELECT ${role} as ok FROM settings_permission WHERE module = ?`
    ).bind(mod).first();
    return row && row.ok === 1;
  } catch {
    return false;
  }
}

async function refreshSession(env, token) {
  await env.DB.prepare(
    `UPDATE sessions SET last_active_at = datetime('now') WHERE token = ?`
  ).bind(token).run();
}

// ============================================================
// SECTION 6: RUNNING NUMBER ENGINE
// ============================================================

async function getNextRegisterSeq(env, fy2) {
  const key = `REGISTER_${fy2}`;
  const result = await env.DB.prepare(
    `UPDATE counters
     SET current_value = current_value + 1, updated_at = datetime('now')
     WHERE key_name = ? AND fiscal_year = ?
     RETURNING current_value`
  ).bind(key, parseInt(`20${fy2}`)).first();

  if (!result) {
    await env.DB.prepare(
      `INSERT INTO counters (key_name, current_value, fiscal_year)
       VALUES (?, 1, ?)`
    ).bind(key, parseInt(`20${fy2}`)).run();
    return 1;
  }
  return result.current_value;
}

async function getNextReceiveSeq(env, fy2) {
  const key = `RECEIVE_${fy2}`;
  const result = await env.DB.prepare(
    `UPDATE counters
     SET current_value = current_value + 1, updated_at = datetime('now')
     WHERE key_name = ? AND fiscal_year = ?
     RETURNING current_value`
  ).bind(key, parseInt(`20${fy2}`)).first();

  if (!result) {
    await env.DB.prepare(
      `INSERT INTO counters (key_name, current_value, fiscal_year)
       VALUES (?, 1, ?)`
    ).bind(key, parseInt(`20${fy2}`)).run();
    return 1;
  }
  return result.current_value;
}

function buildRegisterNo(fy2, count, seq) {
  return {
    raw:     `${fy2}${String(count).padStart(3,'0')}${String(seq).padStart(4,'0')}`,
    display: `RG${fy2}${String(count).padStart(3,'0')}${String(seq).padStart(4,'0')}`,
  };
}

function buildReceiveNo(fy2, seq) {
  return {
    raw:     `${fy2}${String(seq).padStart(4,'0')}`,
    display: `ID${fy2}-${String(seq).padStart(4,'0')}`,
  };
}

// ============================================================
// SECTION 7: AUTH ROUTE HANDLERS
// ============================================================

async function handleLogin(env, body, request) {
  const { email, password } = body || {};
  if (!email || !password)
    return jsonResponse({ error: 'กรุณากรอกอีเมลและรหัสผ่าน' }, 400);

  const hashed = await sha256(password);
  const user   = await env.DB.prepare(
    `SELECT * FROM auth WHERE email = ? AND active = 1`
  ).bind(email.toLowerCase().trim()).first();

  const ip = request.headers.get('CF-Connecting-IP');
  const ua = request.headers.get('User-Agent');

  if (!user || user.password !== hashed) {
    await activityLog(env, {
      email, action: 'login_failed',
      detail: !user ? 'User not found' : 'Wrong password', ip, user_agent: ua,
    });
    return jsonResponse({ error: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' }, 401);
  }

  const token     = generateToken();
  const expireAt  = new Date(Date.now() + 12 * 3600 * 1000).toISOString().replace('T',' ').split('.')[0](undefined);

  await env.DB.prepare(
    `INSERT INTO sessions (token,email,role,username,expire_at,last_active_at,active,guest_flag)
     VALUES (?,?,?,?,?,datetime('now'),1,0)`
  ).bind(token, user.email, user.role, user.username, expireAt).run();

  await activityLog(env, {
    email: user.email, username: user.username, role: user.role,
    action: 'login', detail: 'Login success', ip, user_agent: ua, token_id: token,
  });

  return jsonResponse({
    success: true, token,
    user: {
      email: user.email, username: user.username, role: user.role,
      position: user.position, dept: user.dept,
      darkmode: user.darkmode, force_change_password: user.force_change_password === 1,
    },
  });
}

async function handleGuestLogin(env, request) {
  const guestId  = generateGuestId();
  const token    = generateToken();
  const expireAt = new Date(Date.now() + 2 * 3600 * 1000).toISOString().replace('T',' ').split('.')[0](undefined);

  await env.DB.prepare(
    `INSERT INTO sessions (token,email,role,username,expire_at,last_active_at,active,guest_flag)
     VALUES (?,?,?,?,?,datetime('now'),1,1)`
  ).bind(token, guestId, 'guest', `Guest ${guestId}`, expireAt).run();

  await activityLog(env, {
    email: guestId, role: 'guest', action: 'guest_access',
    detail: 'Guest login', ip: request.headers.get('CF-Connecting-IP'),
    user_agent: request.headers.get('User-Agent'), token_id: token,
  });

  return jsonResponse({
    success: true, token,
    user: { email: guestId, username: `Guest ${guestId}`, role: 'guest',
            position:'', dept:'', darkmode:0, force_change_password:false },
  });
}

async function handleLogout(env, session, request) {
  await env.DB.prepare(`UPDATE sessions SET active = 0 WHERE token = ?`).bind(session.token).run();
  await activityLog(env, {
    email: session.email, username: session.username, role: session.role,
    action: 'logout', detail: 'Logout',
    ip: request.headers.get('CF-Connecting-IP'),
    user_agent: request.headers.get('User-Agent'),
  });
  return jsonResponse({ success: true });
}

async function handleChangePassword(env, session, body) {
  const { current_password, new_password } = body || {};
  if (!current_password || !new_password)
    return jsonResponse({ error: 'กรุณากรอกข้อมูลให้ครบ' }, 400);

  const user = await env.DB.prepare(`SELECT * FROM auth WHERE email = ?`).bind(session.email).first();
  if (user.password !== await sha256(current_password))
    return jsonResponse({ error: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' }, 400);

  await env.DB.prepare(
    `UPDATE auth SET password=?, force_change_password=0, updated_at=datetime('now'), updated_by=? WHERE email=?`
  ).bind(await sha256(new_password), session.email, session.email).run();

  await auditLog(env, { email: session.email, username: session.username,
    action: 'change_password', module: 'auth' });
  return jsonResponse({ success: true, message: 'เปลี่ยนรหัสผ่านเรียบร้อย' });
}

// ============================================================
// SECTION 8: DASHBOARD HANDLERS
// ============================================================

async function handleDashboardSummary(env) {
  const fiscalStart = await getSetting(env, 'fiscal_start_date', '2025-10-01');
  const fiscalEnd   = await getSetting(env, 'fiscal_end_date',   '2026-09-30');
  const fiscalYear  = await getSetting(env, 'fiscal_year', '2569');

  const moneyTypes = await env.DB.prepare(
    `SELECT name, color FROM settings_money_type WHERE active=1 ORDER BY sort_order`
  ).all();

  const cards = [];
  for (const mt of moneyTypes.results) {
    const [all, paid, totalAmt, paidAmt, pendAmt] = await Promise.all([
      env.DB.prepare(`SELECT COUNT(*) c FROM register WHERE money_type=? AND status!='CANCELLED' AND register_date BETWEEN ? AND ?`).bind(mt.name, fiscalStart, fiscalEnd).first(),
      env.DB.prepare(`SELECT COUNT(*) c FROM register WHERE money_type=? AND status IN ('APPROVED','PAID') AND register_date BETWEEN ? AND ?`).bind(mt.name, fiscalStart, fiscalEnd).first(),
      env.DB.prepare(`SELECT COALESCE(SUM(amount),0) s FROM register WHERE money_type=? AND status!='CANCELLED' AND register_date BETWEEN ? AND ?`).bind(mt.name, fiscalStart, fiscalEnd).first(),
      env.DB.prepare(`SELECT COALESCE(SUM(amount),0) s FROM register WHERE money_type=? AND status IN ('APPROVED','PAID') AND register_date BETWEEN ? AND ?`).bind(mt.name, fiscalStart, fiscalEnd).first(),
      env.DB.prepare(`SELECT COALESCE(SUM(amount),0) s FROM register WHERE money_type=? AND status NOT IN ('APPROVED','PAID','CANCELLED') AND register_date BETWEEN ? AND ?`).bind(mt.name, fiscalStart, fiscalEnd).first(),
    ]);
    cards.push({ name: mt.name, color: mt.color,
      totalCount: all.c, paidCount: paid.c,
      totalAmount: totalAmt.s, paidAmount: paidAmt.s, pendingAmount: pendAmt.s });
  }

  const totalAll  = cards.reduce((s,c) => s + c.totalCount, 0);
  const totalPaid = cards.reduce((s,c) => s + c.paidCount,  0);

  const avgRow = await env.DB.prepare(
    `SELECT AVG(JULIANDAY(approve_date)-JULIANDAY(receive_date)) avg
     FROM register WHERE status IN ('APPROVED','PAID')
     AND approve_date IS NOT NULL AND receive_date IS NOT NULL
     AND register_date BETWEEN ? AND ?`
  ).bind(fiscalStart, fiscalEnd).first();

  return jsonResponse({
    fiscalYear: parseInt(fiscalYear),
    summaryCards: cards,
    progressPercent: totalAll > 0 ? Math.round(totalPaid / totalAll * 100) : 0,
    avgDays: avgRow.avg ? Math.floor(avgRow.avg) : 0,
    totalAll, totalPaid,
  });
}

async function handleDashboardCharts(env) {
  const fiscalStart  = await getSetting(env, 'fiscal_start_date', '2025-10-01');
  const fiscalEnd    = await getSetting(env, 'fiscal_end_date',   '2026-09-30');
  const topDept      = parseInt(await getSetting(env, 'dashboard_top_dept',       '5'));
  const topMoney     = parseInt(await getSetting(env, 'dashboard_top_money_type', '4'));

  const prevStart = `${parseInt(fiscalStart.split('-')[0](undefined))-1}-10-01`;
  const prevEnd   = `${parseInt(fiscalEnd.split('-')[0](undefined))-1}-09-30`;

  const [deptStats, moneyStats, monthly] = await Promise.all([
    env.DB.prepare(
      `SELECT dept, COALESCE(SUM(amount),0) total, COUNT(*) cnt
       FROM register WHERE status!='CANCELLED' AND register_date BETWEEN ? AND ?
       GROUP BY dept ORDER BY total DESC`
    ).bind(fiscalStart, fiscalEnd).all(),
    env.DB.prepare(
      `SELECT money_type, COALESCE(SUM(amount),0) total, COUNT(*) cnt
       FROM register WHERE status!='CANCELLED' AND register_date BETWEEN ? AND ?
       GROUP BY money_type ORDER BY total DESC`
    ).bind(fiscalStart, fiscalEnd).all(),
    env.DB.prepare(
      `SELECT strftime('%m',receive_date) mon,
              strftime('%Y',receive_date) yr,
              COUNT(*) cnt
       FROM register WHERE status!='CANCELLED' AND receive_date IS NOT NULL
         AND ((receive_date BETWEEN ? AND ?) OR (receive_date BETWEEN ? AND ?))
       GROUP BY yr, mon ORDER BY yr, mon`
    ).bind(fiscalStart, fiscalEnd, prevStart, prevEnd).all(),
  ]);

  return jsonResponse({
    deptStats: deptStats.results,
    moneyStats: moneyStats.results,
    monthly: monthly.results,
    topDept, topMoney,
    fiscalStart, fiscalEnd, prevStart, prevEnd,
  });
}

// ============================================================
// SECTION 9: REGISTER LIST & DETAIL
// ============================================================

async function handleList(env, session, searchParams) {
  const page   = parseInt(searchParams.get('page')  || '1');
  const limit  = parseInt(searchParams.get('limit') || '50');
  const sort   = searchParams.get('sort')       || 'desc';
  const search = searchParams.get('search')     || '';
  const fMoney = searchParams.get('money_type') || '';
  const fDept  = searchParams.get('dept')       || '';
  const fStat  = searchParams.get('status')     || '';
  const offset = (page - 1) * limit;

  let where  = `WHERE status NOT IN ('WAITING','CANCELLED')`;
  const vals = [];

  if (search) {
    where += ` AND (vendor LIKE ? OR description LIKE ? OR receive_no_display LIKE ?
                    OR request_no_display LIKE ? OR dk_no_display LIKE ?)`;
    const p = `%${search}%`;
    vals.push(p, p, p, p, p);
  }
  if (fMoney) { where += ` AND money_type = ?`; vals.push(fMoney); }
  if (fDept)  { where += ` AND dept = ?`;       vals.push(fDept);  }
  if (fStat)  { where += ` AND status = ?`;     vals.push(fStat);  }

  const order = sort === 'asc'
    ? `ORDER BY receive_date ASC,  receive_no_raw ASC`
    : `ORDER BY receive_date DESC, receive_no_raw DESC`;

  const [cnt, rows] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) c FROM register ${where}`).bind(...vals).first(),
    env.DB.prepare(`SELECT * FROM register ${where} ${order} LIMIT ? OFFSET ?`).bind(...vals, limit, offset).all(),
  ]);

  return jsonResponse({
    data: rows.results.map(r => ({
      ...r,
      status_display:     STATUS_MAP[r.status] || r.status,
      request_no_display: formatRequestNo(r.request_no_raw),
      dk_no_display:      formatDkNo(r.dk_no_raw),
    })),
    total: cnt.c,
    page, limit,
    totalPages: Math.ceil(cnt.c / limit),
  });
}

async function handleDetail(env, uuid) {
  const row = await env.DB.prepare(`SELECT * FROM register WHERE uuid = ?`).bind(uuid).first();
  if (!row) return jsonResponse({ error: 'ไม่พบรายการ' }, 404);
  return jsonResponse({
    ...row,
    status_display:     STATUS_MAP[row.status] || row.status,
    request_no_display: formatRequestNo(row.request_no_raw),
    dk_no_display:      formatDkNo(row.dk_no_raw),
  });
}

// ============================================================
// SECTION 10: IMPORT / REGISTRATION (ATOMIC BATCH)
// ============================================================

async function handleRegisterImport(env, session, body) {
  const { items, source } = body || {};
  if (!items || !Array.isArray(items) || items.length === 0) {
    return jsonResponse({ error: 'ไม่มีรายการที่นำเข้า' }, 400);
  }

  const maxItems = ['admin', 'manager'].includes(session.role) ? 100 : 20;
  if (items.length > maxItems) {
    return jsonResponse({ error: `นำเข้าได้สูงสุด ${maxItems} รายการต่อครั้ง` }, 400);
  }

  const fiscalYear = await getFiscalYearSetting(env);
  const fy2 = getFY2(fiscalYear);
  const registerDate = formatDate(new Date());
  const importSource = source || 'IMPORT';
  const now = formatDateTime();

  // เตรียมข้อมูลก่อนลง DB
  const prepared = [];
  for (const item of items) {
    const requestNoRaw = parseRequestNo(item.request_no_display || item.request_no || '');
    const moneyType = (item.money_type || '').trim();

    if (!requestNoRaw || !moneyType) {
      return jsonResponse({
        error: 'ข้อมูลไม่ครบ: request_no และ money_type ต้องไม่ว่าง'
      }, 400);
    }

    const existing = await env.DB.prepare(
      `SELECT * FROM register WHERE request_no_raw = ? AND money_type = ?`
    ).bind(requestNoRaw, moneyType).first();

    prepared.push({
      item,
      requestNoRaw,
      moneyType,
      existing
    });
  }

  // Reserve เลขลงทะเบียน 1 ครั้งต่อ batch
  const seq = await getNextRegisterSeq(env, fy2);
  const count = prepared.length;
  const regNo = buildRegisterNo(fy2, count, seq);

  const statements = [];
  const auditLogs = [];

  for (const { item, requestNoRaw, moneyType, existing } of prepared) {
    const uuid = existing ? existing.uuid : generateUUID();
    const dkNoRaw = item.dk_no_display ? parseDkNo(item.dk_no_display) : (existing?.dk_no_raw || null);

    const dept = item.dept || existing?.dept || '';
    const sender = item.sender || existing?.sender || '';
    const reserveNo = item.reserve_no || existing?.reserve_no || '';
    const reserveAmount = item.reserve_amount != null ? item.reserve_amount : (existing?.reserve_amount || null);
    const egpNo = item.egp_no || existing?.egp_no || '';
    const invoice = item.invoice || existing?.invoice || '';
    const vendor = item.vendor || existing?.vendor || '';
    const amount = item.amount != null ? parseFloat(item.amount) : (existing?.amount || 0);
    const description = item.description || existing?.description || '';

    if (existing) {
      statements.push(
        env.DB.prepare(
          `UPDATE register SET
             dept = ?, sender = ?, reserve_no = ?, reserve_amount = ?,
             egp_no = ?, invoice = ?, vendor = ?, amount = ?,
             description = ?, dk_no_raw = ?,
             source = ?, updated_at = ?, updated_by = ?
           WHERE uuid = ?`
        ).bind(
          dept, sender, reserveNo, reserveAmount,
          egpNo, invoice, vendor, amount,
          description, dkNoRaw,
          importSource, now, session.email, uuid
        )
      );

      auditLogs.push({
        email: session.email,
        username: session.username,
        action: 'register_update',
        uuid,
        before_json: existing,
        after_json: {
          ...existing,
          dept, sender, reserve_no: reserveNo, reserve_amount: reserveAmount,
          egp_no: egpNo, invoice, vendor, amount, description,
          dk_no_raw: dkNoRaw, source: importSource,
        },
        detail: `UPDATE by import: ${requestNoRaw}/${moneyType}`,
        module: 'register'
      });
    } else {
      statements.push(
        env.DB.prepare(
          `INSERT INTO register (
             uuid, request_no_raw, request_no_display, money_type,
             dept, sender, reserve_no, reserve_amount,
             egp_no, invoice, vendor, amount, description,
             dk_no_raw, register_no_raw, register_no_display,
             status, source, register_date, created_at, created_by, updated_at, updated_by
           ) VALUES (
             ?, ?, ?, ?,
             ?, ?, ?, ?,
             ?, ?, ?, ?, ?,
             ?, ?, ?,
             ?, ?, ?, ?, ?, ?, ?
           )`
        ).bind(
          uuid,
          requestNoRaw, formatRequestNo(requestNoRaw), moneyType,
          dept, sender, reserveNo, reserveAmount,
          egpNo, invoice, vendor, amount, description,
          dkNoRaw, regNo.raw, regNo.display,
          'WAITING', importSource, registerDate, now, session.email, now, session.email
        )
      );

      auditLogs.push({
        email: session.email,
        username: session.username,
        action: 'register_create',
        uuid,
        after_json: {
          uuid, request_no_raw: requestNoRaw, money_type: moneyType,
          dept, sender, reserve_no: reserveNo, reserve_amount: reserveAmount,
          egp_no: egpNo, invoice, vendor, amount, description,
          dk_no_raw: dkNoRaw, register_no_raw: regNo.raw, register_no_display: regNo.display,
          status: 'WAITING', source: importSource,
        },
        detail: `INSERT by import: ${requestNoRaw}/${moneyType}`,
        module: 'register'
      });
    }
  }

  try {
    // D1 Batch execute
    await env.DB.batch(statements);

    // เขียน audit logs หลังจาก batch สำเร็จ
    for (const log of auditLogs) {
      await auditLog(env, log);
    }

    await activityLog(env, {
      email: session.email,
      username: session.username,
      role: session.role,
      action: 'import_register',
      detail: `Imported ${items.length} items`,
      ip: null,
      user_agent: null,
      token_id: session.token,
    });

    return jsonResponse({
      success: true,
      message: 'นำเข้าข้อมูลเรียบร้อย',
      count: items.length,
      register_no_display: regNo.display,
      register_no_raw: regNo.raw,
      fiscalYear,
    });
  } catch (e) {
    return jsonResponse({
      error: 'เกิดข้อผิดพลาดระหว่างนำเข้าข้อมูล',
      detail: e.message
    }, 500);
  }
}

/**
 * GET /api/register/receive-queue
 */
async function handleReceiveQueue(env, session, searchParams) {
  const page = parseInt(searchParams.get('page') || '1');
  const limit = parseInt(searchParams.get('limit') || '50');
  const search = searchParams.get('search') || '';
  const offset = (page - 1) * limit;

  let where = `WHERE status = 'WAITING'`;
  const vals = [];

  if (search) {
    where += ` AND (vendor LIKE ? OR request_no_display LIKE ? OR amount LIKE ?)`;
    const p = `%${search}%`;
    vals.push(p, p, p);
  }

  const [cnt, rows] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) c FROM register ${where}`).bind(...vals).first(),
    env.DB.prepare(`SELECT * FROM register ${where} ORDER BY register_date ASC, created_at ASC LIMIT ? OFFSET ?`).bind(...vals, limit, offset).all(),
  ]);

  return jsonResponse({
    data: rows.results.map(r => ({
      ...r,
      request_no_display: formatRequestNo(r.request_no_raw),
      status_display: STATUS_MAP[r.status] || r.status,
    })),
    total: cnt.c,
    page,
    limit,
    totalPages: Math.ceil(cnt.c / limit),
  });
}

/**
 * POST /api/register/receive
 */
async function handleReceive(env, session, body) {
  const { uuids, editor_email } = body || {};
  if (!uuids || !Array.isArray(uuids) || uuids.length === 0) {
    return jsonResponse({ error: 'กรุณาเลือกรายการ' }, 400);
  }

  const fy2 = getFY2(await getFiscalYearSetting(env));
  const seq = await getNextReceiveSeq(env, fy2);
  const now = formatDateTime();
  const statements = [];
  const receiveNos = [];

  for (let i = 0; i < uuids.length; i++) {
    const uuid = uuids[i];
    const row = await env.DB.prepare(`SELECT * FROM register WHERE uuid = ?`).bind(uuid).first();
    if (!row) {
      return jsonResponse({ error: `ไม่พบรายการ uuid=${uuid}` }, 404);
    }
    if (row.status !== 'WAITING') {
      return jsonResponse({ error: `รายการ ${uuid} ไม่อยู่ในสถานะ WAITING` }, 400);
    }

    const no = buildReceiveNo(fy2, seq + i);
    receiveNos.push(no);

    statements.push(
      env.DB.prepare(
        `UPDATE register SET
           receive_no_raw = ?, receive_no_display = ?,
           status = 'RECEIVED',
           editor = ?,
           receive_date = ?,
           updated_at = ?, updated_by = ?
         WHERE uuid = ?`
      ).bind(
        no.raw, no.display,
        editor_email || session.email,
        now,
        now, session.email,
        uuid
      )
    );
  }

  try {
    await env.DB.batch(statements);

    await activityLog(env, {
      email: session.email,
      username: session.username,
      role: session.role,
      action: 'receive_register',
      detail: `Received ${uuids.length} items`,
      token_id: session.token,
    });

    return jsonResponse({
      success: true,
      count: uuids.length,
      receive_nos: receiveNos
    });
  } catch (e) {
    return jsonResponse({ error: 'รับเข้าระบบไม่สำเร็จ', detail: e.message }, 500);
  }
}

/**
 * POST /api/register/verify
 */
async function handleVerify(env, session, body) {
  const { uuid, action, dk_no_display, note } = body || {};
  if (!uuid || !action) {
    return jsonResponse({ error: 'ข้อมูลไม่ครบ' }, 400);
  }

  const row = await env.DB.prepare(
    `SELECT * FROM register WHERE uuid = ?`
  ).bind(uuid).first();

  if (!row) {
    return jsonResponse({ error: 'ไม่พบรายการ' }, 404);
  }

  if (!['EDITING', 'RETURN', 'PASS'].includes(action)) {
    return jsonResponse({ error: 'action ไม่ถูกต้อง' }, 400);
  }

  const now = formatDateTime();

  if (action === 'EDITING') {
    await env.DB.prepare(
      `UPDATE register SET status = 'EDITING', note = ?, updated_at = ?, updated_by = ? WHERE uuid = ?`
    ).bind(note || null, now, session.email, uuid).run();
  }

  if (action === 'RETURN') {
    await env.DB.prepare(
      `UPDATE register SET status = 'CHECKUP', note = ?, updated_at = ?, updated_by = ? WHERE uuid = ?`
    ).bind(note || null, now, session.email, uuid).run();
  }

  if (action === 'PASS') {
    const dkRaw = parseDkNo(dk_no_display || row.dk_no_display || '');
    if (!dkRaw) {
      return jsonResponse({ error: 'กรุณากรอกเลขฎีกาก่อนตรวจผ่าน' }, 400);
    }

    await env.DB.prepare(
      `UPDATE register SET status = 'PASSED', dk_no_raw = ?, dk_no_display = ?, updated_at = ?, updated_by = ? WHERE uuid = ?`
    ).bind(dkRaw, dk_no_display, now, session.email, uuid).run();
  }

  await auditLog(env, {
    email: session.email,
    username: session.username,
    action: `verify_${action.toLowerCase()}`,
    uuid,
    before_json: row,
    after_json: await env.DB.prepare(`SELECT * FROM register WHERE uuid = ?`).bind(uuid).first(),
    detail: note || '',
    module: 'register',
  });

  return jsonResponse({ success: true });
}

/**
 * POST /api/register/approve
 */
async function handleApprove(env, session, body) {
  const { uuid, action, note } = body || {};
  const row = await env.DB.prepare(`SELECT * FROM register WHERE uuid = ?`).bind(uuid).first();
  if (!row) return jsonResponse({ error: 'ไม่พบรายการ' }, 404);

  if (action === 'PROPOSE') {
    await env.DB.prepare(
      `UPDATE register SET status = 'PROPOSED', note = ?, updated_at = ?, updated_by = ? WHERE uuid = ?`
    ).bind(note || null, formatDateTime(), session.email, uuid).run();
  } else if (action === 'APPROVE') {
    await env.DB.prepare(
      `UPDATE register SET status = 'APPROVED', approve_date = ?, note = ?, updated_at = ?, updated_by = ? WHERE uuid = ?`
    ).bind(formatDateTime(), note || null, formatDateTime(), session.email, uuid).run();
  } else {
    return jsonResponse({ error: 'action ไม่ถูกต้อง' }, 400);
  }

  await auditLog(env, {
    email: session.email, username: session.username, action: `approve_${action.toLowerCase()}`,
    uuid, before_json: row,
    after_json: await env.DB.prepare(`SELECT * FROM register WHERE uuid = ?`).bind(uuid).first(),
    detail: note || '', module: 'register',
  });

  return jsonResponse({ success: true });
}

/**
 * POST /api/register/payment
 */
async function handlePayment(env, session, body) {
  const { uuid, note } = body || {};
  const row = await env.DB.prepare(`SELECT * FROM register WHERE uuid = ?`).bind(uuid).first();
  if (!row) return jsonResponse({ error: 'ไม่พบรายการ' }, 404);

  if (session.role !== 'admin' && session.role !== 'checker' && session.role !== 'manager') {
    return jsonResponse({ error: 'ไม่มีสิทธิ์จ่ายเช็ค' }, 403);
  }

  await env.DB.prepare(
    `UPDATE register SET status = 'PAID', paid_date = ?, note = ?, updated_at = ?, updated_by = ? WHERE uuid = ?`
  ).bind(formatDateTime(), note || null, formatDateTime(), session.email, uuid).run();

  await auditLog(env, {
    email: session.email, username: session.username, action: 'payment_pay',
    uuid, before_json: row,
    after_json: await env.DB.prepare(`SELECT * FROM register WHERE uuid = ?`).bind(uuid).first(),
    detail: note || '', module: 'register',
  });

  return jsonResponse({ success: true });
}

// ============================================================
// SECTION 11: CANCEL / RECOVER
// ============================================================

async function handleCancel(env, session, body) {
  const { uuid, reason, mode } = body || {}; 
  // mode: 'CANCEL' | 'RECOVER' (หรือจะใช้แยก endpoint ก็ได้)

  if (!uuid) return jsonResponse({ error: 'uuid ว่าง' }, 400);

  const row = await env.DB.prepare(`SELECT * FROM register WHERE uuid = ?`).bind(uuid).first();
  if (!row) return jsonResponse({ error: 'ไม่พบรายการ' }, 404);

  // กฎ: ถ้าจ่ายแล้วต้อง admin เท่านั้นในการยกเลิก/กู้คืน
  const canAdminOverride = ['admin', 'manager'].includes(session.role);

  if (row.status === 'PAID' && !canAdminOverride) {
    return jsonResponse({ error: 'ไม่มีสิทธิ์ยกเลิกหลังจ่ายแล้ว' }, 403);
  }

  const now = formatDateTime();

  if (mode === 'CANCEL') {
    // เก็บ cancel_change ไว้เพื่อ recovery
    await env.DB.prepare(
      `UPDATE register SET
         cancel_change = ?, 
         status = 'CANCELLED',
         cancel_reason = ?,
         updated_at = ?, updated_by = ?
       WHERE uuid = ?`
    ).bind(row.status, reason || null, now, session.email, uuid).run();

    await auditLog(env, {
      email: session.email,
      username: session.username,
      action: 'register_cancel',
      uuid,
      before_json: row,
      after_json: null,
      detail: reason || '',
      module: 'register'
    });

    await activityLog(env, {
      email: session.email,
      username: session.username,
      role: session.role,
      action: 'cancel_register',
      detail: `Cancel uuid=${uuid}`,
      token_id: session.token
    });

    return jsonResponse({ success: true });
  }

  if (mode === 'RECOVER') {
    // recovery จะคืน status เป็นค่าเดิมจาก cancel_change ถ้ามี
    const recoverTo = row.cancel_change || 'WAITING';

    await env.DB.prepare(
      `UPDATE register SET
         status = ?,
         cancel_change = NULL,
         cancel_reason = NULL,
         updated_at = ?, updated_by = ?
       WHERE uuid = ?`
    ).bind(recoverTo, now, session.email, uuid).run();

    await auditLog(env, {
      email: session.email,
      username: session.username,
      action: 'register_recover',
      uuid,
      before_json: row,
      after_json: null,
      detail: reason || '',
      module: 'register'
    });

    await activityLog(env, {
      email: session.email,
      username: session.username,
      role: session.role,
      action: 'recover_register',
      detail: `Recover uuid=${uuid} to=${recoverTo}`,
      token_id: session.token
    });

    return jsonResponse({ success: true });
  }

  return jsonResponse({ error: 'mode ไม่ถูกต้อง' }, 400);
}

// ============================================================
// SECTION 12: REPORTS (FILTER + EXPORT)
// ============================================================

async function handleReport(env, session, bodyOrQuery) {
  // bodyOrQuery: อาจส่งเป็น querystring หรือ body
  const q = bodyOrQuery?.query ? bodyOrQuery.query : bodyOrQuery || {};

  const status = q.status || '';
  const from = q.from || '';
  const to = q.to || '';
  const moneyType = q.money_type || '';
  const dept = q.dept || '';
  const search = q.search || '';

  let where = `WHERE 1=1`;
  const vals = [];

  if (status) { where += ` AND r.status = ?`; vals.push(status); }
  if (moneyType) { where += ` AND r.money_type = ?`; vals.push(moneyType); }
  if (dept) { where += ` AND r.dept = ?`; vals.push(dept); }

  if (from) { where += ` AND r.register_date >= ?`; vals.push(from); }
  if (to)   { where += ` AND r.register_date <= ?`; vals.push(to); }

  if (search) {
    where += ` AND (r.vendor LIKE ? OR r.description LIKE ? OR r.receive_no_display LIKE ? OR CAST(r.amount AS TEXT) LIKE ?)`;
    const p = `%${search}%`;
    vals.push(p, p, p, p);
  }

  // Role filter (editor/staff)
  if (session.role === 'editor') {
    where += ` AND r.editor = ?`;
    vals.push(session.email);
  } else if (session.role === 'staff') {
    where += ` AND r.dept = ?`;
    vals.push(session.user_dept || session.dept || '');
  }

  // รายการ
  const rows = await env.DB.prepare(
    `SELECT r.*, 
            CASE r.status 
              WHEN 'WAITING' THEN 'รอเอกสาร'
              WHEN 'RECEIVED' THEN 'รับเข้าระบบ'
              WHEN 'CHECKUP' THEN 'ตรวจสอบ'
              WHEN 'EDITING' THEN 'ส่งแก้ไข'
              WHEN 'PASSED' THEN 'ตรวจผ่าน'
              WHEN 'PROPOSED' THEN 'เสนอ'
              WHEN 'APPROVED' THEN 'อนุมัติ'
              WHEN 'PAID' THEN 'จ่ายแล้ว'
              WHEN 'CANCELLED' THEN 'ยกเลิก'
            END AS status_display
       FROM register r
     ${where}
     ORDER BY r.register_date DESC, r.created_at DESC`
  ).bind(...vals).all();

  // Summary
  const sumRow = await env.DB.prepare(
    `SELECT COALESCE(SUM(amount),0) AS total_amount, COUNT(*) AS total_count
       FROM register r
     ${where}`
  ).bind(...vals).first();

  return jsonResponse({
    success: true,
    data: rows.results.map(r => ({
      ...r,
      request_no_display: r.request_no_raw ? formatRequestNo(r.request_no_raw) : '',
      dk_no_display: r.dk_no_raw ? formatDkNo(r.dk_no_raw) : '',
    })),
    summary: {
      total_amount: sumRow.total_amount,
      total_count: sumRow.total_count
    }
  });
}

// ============================================================
// SECTION 13: SETTINGS ROUTES (APP + MASTER DATA)
// ============================================================

async function handleSettings(env, session, body) {
  const { key, value, module } = body || {};
  // module could be 'app' | 'system' | 'permission' etc.
  // สำหรับ Phase 3 นี้ทำแบบขั้นต่ำ: settings_app และ settings_system

  if (session.role !== 'admin' && session.role !== 'manager') {
    return jsonResponse({ error: 'ไม่มีสิทธิ์' }, 403);
  }

  if (!key) return jsonResponse({ error: 'key ว่าง' }, 400);

  if (!value && value !== '') return jsonResponse({ error: 'value ว่าง' }, 400);

  if (module === 'system') {
    await env.DB.prepare(
      `UPDATE settings_system SET value = ? WHERE key = ?`
    ).bind(String(value), key).run();

    return jsonResponse({ success: true });
  }

  // default app
  await env.DB.prepare(
    `UPDATE settings_app SET value = ? WHERE key = ?`
  ).bind(String(value), key).run();

  return jsonResponse({ success: true });
}

async function handleUpsertMoneyType(env, session, body) {
  const { id, name, color, sort_order, active } = body || {};
  if (session.role !== 'admin') return jsonResponse({ error: 'เฉพาะ admin' }, 403);
  if (!name) return jsonResponse({ error: 'name ว่าง' }, 400);

  // Upsert ด้วย id ถ้ามี ไม่มีก็ insert
  if (id) {
    await env.DB.prepare(
      `UPDATE settings_money_type
       SET name=?, color=?, sort_order=?, active=?
       WHERE id=?`
    ).bind(name, color || '#CCCCCC', sort_order || 0, active ? 1 : 0, id).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO settings_money_type (name, color, sort_order, active)
       VALUES (?,?,?,?)`
    ).bind(name, color || '#CCCCCC', sort_order || 0, active ? 1 : 0).run();
  }
  return jsonResponse({ success: true });
}

// ============================================================
// SECTION 14: SYSTEM ROUTES (PERMISSION, USERS, LOGS)
// ============================================================

async function handleGetPermission(env, session) {
  if (session.role !== 'admin') return jsonResponse({ error: 'เฉพาะ admin' }, 403);
  const rows = await env.DB.prepare(
    `SELECT module, admin, manager, editor, checker, staff, guest
       FROM settings_permission
     ORDER BY module`
  ).all();
  return jsonResponse({ success: true, data: rows.results });
}

// ============================================================
// SECTION 15: MAIN ROUTER
// ============================================================

async function router(request, env, ctx) {
  if (request.method === 'OPTIONS') return handleOptions();

  const url = new URL(request.url);
  const path = url.pathname;

  // ---- Token Extract
  // Support: Authorization: Bearer <token>  or body token
  const authHeader = request.headers.get('Authorization') || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const token = bearer || null;

  let session = await validateSession(env, token);

  // For guest endpoints, session may not exist; handle inside endpoints if needed.

  // Parse body if method has body
  let body = null;
  const methodAllowsBody = request.method !== 'GET' && request.method !== 'HEAD';
  if (methodAllowsBody) {
    try {
      body = await request.json();
    } catch {
      body = {};
    }
  } else {
    body = {};
  }

  // ---- Public routes
  if (path === '/api/auth/login' && request.method === 'POST') {
    return handleLogin(env, body, request);
  }
  if (path === '/api/auth/guest' && request.method === 'POST') {
    return handleGuestLogin(env, request);
  }

  // ---- Auth required from here
  if (!session) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  // refresh last_active
  await refreshSession(env, token);

  // DASHBOARD
  if (path === '/api/dashboard/summary' && request.method === 'GET') {
    return handleDashboardSummary(env);
  }
  if (path === '/api/dashboard/charts' && request.method === 'GET') {
    return handleDashboardCharts(env);
  }

  // REGISTER LIST/DETAIL
  if (path === '/api/register/list' && request.method === 'GET') {
    return handleList(env, session, url.searchParams);
  }
  if (path.startsWith('/api/register/detail/') && request.method === 'GET') {
    const uuid = path.split('/').pop();
    return handleDetail(env, uuid);
  }

  // IMPORT / RECEIVE / VERIFY / APPROVE / PAYMENT
  if (path === '/api/register/import' && request.method === 'POST') {
    const ok = await checkPermission(env, session.role, 'import');
    if (!ok) return jsonResponse({ error: 'No permission' }, 403);
    return handleRegisterImport(env, session, body);
  }

  if (path === '/api/register/receive-queue' && request.method === 'GET') {
    const ok = await checkPermission(env, session.role, 'receive');
    if (!ok) return jsonResponse({ error: 'No permission' }, 403);
    return handleReceiveQueue(env, session, url.searchParams);
  }

  if (path === '/api/register/receive' && request.method === 'POST') {
    const ok = await checkPermission(env, session.role, 'receive');
    if (!ok) return jsonResponse({ error: 'No permission' }, 403);
    return handleReceive(env, session, body);
  }

  if (path === '/api/register/verify' && request.method === 'POST') {
    const ok = await checkPermission(env, session.role, 'verify');
    if (!ok) return jsonResponse({ error: 'No permission' }, 403);
    return handleVerify(env, session, body);
  }

  if (path === '/api/register/approve' && request.method === 'POST') {
    const ok = await checkPermission(env, session.role, 'approve');
    if (!ok) return jsonResponse({ error: 'No permission' }, 403);
    return handleApprove(env, session, body);
  }

  if (path === '/api/register/payment' && request.method === 'POST') {
    const ok = await checkPermission(env, session.role, 'payment');
    if (!ok) return jsonResponse({ error: 'No permission' }, 403);
    return handlePayment(env, session, body);
  }

  // CANCEL / RECOVER
  if (path === '/api/register/cancel' && request.method === 'POST') {
    const ok = await checkPermission(env, session.role, 'settings'); // placeholder; ปรับ module ให้ตรง
    if (!ok && session.role !== 'admin') return jsonResponse({ error: 'No permission' }, 403);
    return handleCancel(env, session, { ...body, mode: 'CANCEL' });
  }

  if (path === '/api/register/recover' && request.method === 'POST') {
    const ok = await checkPermission(env, session.role, 'settings'); // placeholder
    if (!ok && session.role !== 'admin') return jsonResponse({ error: 'No permission' }, 403);
    return handleCancel(env, session, { ...body, mode: 'RECOVER' });
  }

  // REPORT
  if (path === '/api/report' && request.method === 'GET') {
    const ok = await checkPermission(env, session.role, 'report');
    if (!ok) return jsonResponse({ error: 'No permission' }, 403);
    const query = {};
    for (const [k, v] of url.searchParams.entries()) query[k] = v;
    return handleReport(env, session, { query });
  }

  // SETTINGS
  if (path === '/api/settings' && request.method === 'POST') {
    return handleSettings(env, session, body);
  }

  // PERMISSION (ADMIN)
  if (path === '/api/system/permission' && request.method === 'GET') {
    return handleGetPermission(env, session);
  }

  return jsonResponse({ error: 'Not Found' }, 404);
}

// Export for Cloudflare Workers
export default {
  async fetch(request, env, ctx) {
    try {
      return await router(request, env, ctx);
    } catch (err) {
      console.error('Worker error:', err);
      return jsonResponse({ error: 'Internal Server Error', detail: err?.message }, 500);
    }
  }
};

// ============================================================
// SECTION 16: AUTH SESSION & PROFILE
// ============================================================

/**
 * GET /api/auth/session
 * ดึงข้อมูล user ปัจจุบันจาก token
 */
async function handleGetSession(env, session) {
  return jsonResponse({
    success: true,
    user: {
      email:                 session.email,
      username:              session.username,
      role:                  session.role,
      position:              session.position   || '',
      dept:                  session.user_dept  || '',
      darkmode:              session.darkmode   || 0,
      force_change_password: session.force_change_password === 1,
      guest_flag:            session.guest_flag === 1,
    },
  });
}

/**
 * POST /api/auth/update-profile
 * แก้ไขชื่อ, ตำแหน่ง, darkmode
 */
async function handleUpdateProfile(env, session, body) {
  const { username, position, darkmode } = body || {};
  const now = formatDateTime();

  // อัปเดตเฉพาะ field ที่ส่งมา
  const updates = [];
  const vals = [];

  if (username !== undefined) { updates.push(`username = ?`); vals.push(username); }
  if (position !== undefined) { updates.push(`position = ?`); vals.push(position); }
  if (darkmode  !== undefined) { updates.push(`darkmode = ?`);  vals.push(darkmode ? 1 : 0); }

  if (updates.length === 0) {
    return jsonResponse({ error: 'ไม่มีข้อมูลที่ต้องการแก้ไข' }, 400);
  }

  updates.push(`updated_at = ?`); vals.push(now);
  updates.push(`updated_by = ?`); vals.push(session.email);
  vals.push(session.email);

  await env.DB.prepare(
    `UPDATE auth SET ${updates.join(', ')} WHERE email = ?`
  ).bind(...vals).run();

  // ถ้าเปลี่ยน username ต้อง sync sessions ด้วย
  if (username !== undefined) {
    await env.DB.prepare(
      `UPDATE sessions SET username = ? WHERE email = ? AND active = 1`
    ).bind(username, session.email).run();
  }

  await auditLog(env, {
    email: session.email, username: session.username,
    action: 'update_profile', module: 'auth',
    detail: `Updated: ${updates.slice(0, -2).join(', ')}`,
  });

  return jsonResponse({ success: true, message: 'อัปเดตโปรไฟล์เรียบร้อย' });
}

// ============================================================
// SECTION 17: MASTER DATA ROUTES
// ============================================================

/**
 * GET /api/master/money-type
 */
async function handleGetMoneyTypes(env) {
  const rows = await env.DB.prepare(
    `SELECT id, name, color, sort_order, active
       FROM settings_money_type
     ORDER BY sort_order ASC`
  ).all();
  return jsonResponse({ success: true, data: rows.results });
}

/**
 * GET /api/master/vendor
 */
async function handleGetVendors(env) {
  const rows = await env.DB.prepare(
    `SELECT id, name, tax_id, address, contact, active
       FROM settings_vendor
     ORDER BY name ASC`
  ).all();
  return jsonResponse({ success: true, data: rows.results });
}

/**
 * GET /api/master/dept
 */
async function handleGetDepts(env) {
  const rows = await env.DB.prepare(
    `SELECT id, name, sort_order, active
       FROM settings_dept
     ORDER BY sort_order ASC`
  ).all();
  return jsonResponse({ success: true, data: rows.results });
}

/**
 * GET /api/settings/all
 * ดึง settings_app และ settings_system ทั้งหมด
 * (ซ่อน sensitive key เช่น telegram_bot_token ถ้าไม่ใช่ admin)
 */
async function handleGetAllSettings(env, session) {
  const [appRows, sysRows] = await Promise.all([
    env.DB.prepare(`SELECT key, value, description FROM settings_app ORDER BY key`).all(),
    env.DB.prepare(`SELECT key, value, description FROM settings_system ORDER BY key`).all(),
  ]);

  // ซ่อน sensitive keys สำหรับ non-admin
  const sensitiveKeys = ['telegram_bot_token', 'default_password'];
  const isSensitive = (key) => sensitiveKeys.includes(key) && session.role !== 'admin';

  const app = appRows.results.map(r => ({
    key: r.key,
    value: isSensitive(r.key) ? '••••••' : r.value,
    description: r.description,
  }));

  const system = sysRows.results.map(r => ({
    key: r.key,
    value: isSensitive(r.key) ? '••••••' : r.value,
    description: r.description,
  }));

  return jsonResponse({ success: true, app, system });
}

// ============================================================
// SECTION 18: USER MANAGEMENT (ADMIN)
// ============================================================

/**
 * GET /api/users/list
 */
async function handleUserList(env, session) {
  if (!['admin', 'manager'].includes(session.role)) {
    return jsonResponse({ error: 'ไม่มีสิทธิ์' }, 403);
  }

  const rows = await env.DB.prepare(
    `SELECT id, email, username, role, position, dept,
            active, force_change_password, darkmode,
            created_at, updated_at, created_by, updated_by
       FROM auth
     ORDER BY role ASC, username ASC`
  ).all();

  return jsonResponse({ success: true, data: rows.results });
}

/**
 * POST /api/users/create
 */
async function handleUserCreate(env, session, body) {
  if (session.role !== 'admin') {
    return jsonResponse({ error: 'เฉพาะ admin เท่านั้น' }, 403);
  }

  const { email, username, role, position, dept } = body || {};

  if (!email || !username || !role) {
    return jsonResponse({ error: 'email, username, role ต้องไม่ว่าง' }, 400);
  }

  if (!['admin','manager','editor','checker','staff','guest'].includes(role)) {
    return jsonResponse({ error: 'role ไม่ถูกต้อง' }, 400);
  }

  // ตรวจ duplicate
  const existing = await env.DB.prepare(
    `SELECT id FROM auth WHERE email = ?`
  ).bind(email.toLowerCase().trim()).first();

  if (existing) {
    return jsonResponse({ error: 'อีเมลนี้มีอยู่ในระบบแล้ว' }, 409);
  }

  // ดึง default password จาก settings
  const defaultPwd = await getSetting(
    env, 'default_password',
    '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4' // sha256('1234')
  );

  const now = formatDateTime();

  await env.DB.prepare(
    `INSERT INTO auth
       (email, password, username, role, position, dept,
        active, force_change_password, darkmode,
        created_at, created_by, updated_at, updated_by)
     VALUES (?,?,?,?,?,?,1,1,0,?,?,?,?)`
  ).bind(
    email.toLowerCase().trim(),
    defaultPwd,
    username, role,
    position || '',
    dept || '',
    now, session.email,
    now, session.email
  ).run();

  await auditLog(env, {
    email: session.email, username: session.username,
    action: 'user_create', module: 'auth',
    detail: `Created user: ${email} role=${role}`,
  });

  return jsonResponse({
    success: true,
    message: `สร้างผู้ใช้ ${email} เรียบร้อย (รหัสผ่านเริ่มต้น: 1234)`
  });
}

/**
 * POST /api/users/update
 */
async function handleUserUpdate(env, session, body) {
  if (!['admin', 'manager'].includes(session.role)) {
    return jsonResponse({ error: 'ไม่มีสิทธิ์' }, 403);
  }

  const { email, username, role, position, dept, active } = body || {};
  if (!email) return jsonResponse({ error: 'email ว่าง' }, 400);

  // manager ห้ามแก้ admin อื่น
  const target = await env.DB.prepare(
    `SELECT * FROM auth WHERE email = ?`
  ).bind(email).first();

  if (!target) return jsonResponse({ error: 'ไม่พบผู้ใช้' }, 404);

  if (session.role === 'manager' && target.role === 'admin') {
    return jsonResponse({ error: 'manager ไม่สามารถแก้ไข admin ได้' }, 403);
  }

  const updates = [];
  const vals = [];

  if (username !== undefined) { updates.push(`username = ?`);  vals.push(username); }
  if (role     !== undefined) { updates.push(`role = ?`);      vals.push(role); }
  if (position !== undefined) { updates.push(`position = ?`);  vals.push(position); }
  if (dept     !== undefined) { updates.push(`dept = ?`);      vals.push(dept); }
  if (active   !== undefined) { updates.push(`active = ?`);    vals.push(active ? 1 : 0); }

  if (updates.length === 0) {
    return jsonResponse({ error: 'ไม่มีข้อมูลที่ต้องการแก้ไข' }, 400);
  }

  const now = formatDateTime();
  updates.push(`updated_at = ?`); vals.push(now);
  updates.push(`updated_by = ?`); vals.push(session.email);
  vals.push(email);

  await env.DB.prepare(
    `UPDATE auth SET ${updates.join(', ')} WHERE email = ?`
  ).bind(...vals).run();

  await auditLog(env, {
    email: session.email, username: session.username,
    action: 'user_update', module: 'auth',
    before_json: target,
    detail: `Updated user: ${email}`,
  });

  return jsonResponse({ success: true, message: 'แก้ไขผู้ใช้เรียบร้อย' });
}

/**
 * POST /api/users/reset-password
 */
async function handleUserResetPassword(env, session, body) {
  if (!['admin', 'manager'].includes(session.role)) {
    return jsonResponse({ error: 'ไม่มีสิทธิ์' }, 403);
  }

  const { email } = body || {};
  if (!email) return jsonResponse({ error: 'email ว่าง' }, 400);

  const target = await env.DB.prepare(
    `SELECT * FROM auth WHERE email = ?`
  ).bind(email).first();

  if (!target) return jsonResponse({ error: 'ไม่พบผู้ใช้' }, 404);

  if (session.role === 'manager' && target.role === 'admin') {
    return jsonResponse({ error: 'manager ไม่สามารถ reset admin ได้' }, 403);
  }

  const defaultPwd = await getSetting(
    env, 'default_password',
    '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4'
  );

  const now = formatDateTime();
  await env.DB.prepare(
    `UPDATE auth
     SET password = ?, force_change_password = 1,
         updated_at = ?, updated_by = ?
     WHERE email = ?`
  ).bind(defaultPwd, now, session.email, email).run();

  await auditLog(env, {
    email: session.email, username: session.username,
    action: 'user_reset_password', module: 'auth',
    detail: `Reset password for: ${email}`,
  });

  return jsonResponse({
    success: true,
    message: `Reset รหัสผ่านของ ${email} เรียบร้อย (รหัสผ่านใหม่: 1234)`
  });
}

// ============================================================
// SECTION 19: SYSTEM LOGS
// ============================================================

/**
 * GET /api/system/logs
 */
async function handleGetLogs(env, session, searchParams) {
  if (!['admin', 'manager'].includes(session.role)) {
    return jsonResponse({ error: 'ไม่มีสิทธิ์' }, 403);
  }

  const page  = parseInt(searchParams.get('page')  || '1');
  const limit = parseInt(searchParams.get('limit') || '50');
  const type  = searchParams.get('type') || 'audit'; // audit | activity
  const from  = searchParams.get('from') || '';
  const to    = searchParams.get('to')   || '';
  const email = searchParams.get('email') || '';
  const offset = (page - 1) * limit;

  const table = type === 'activity' ? 'logs' : 'audit_logs';

  let where = `WHERE 1=1`;
  const vals = [];

  if (email) { where += ` AND email = ?`; vals.push(email); }
  if (from)  { where += ` AND created_at >= ?`; vals.push(from); }
  if (to)    { where += ` AND created_at <= ?`; vals.push(to); }

  const [cnt, rows] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) c FROM ${table} ${where}`).bind(...vals).first(),
    env.DB.prepare(
      `SELECT * FROM ${table} ${where}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`
    ).bind(...vals, limit, offset).all(),
  ]);

  return jsonResponse({
    success: true,
    data: rows.results,
    total: cnt.c,
    page, limit,
    totalPages: Math.ceil(cnt.c / limit),
  });
}

// ============================================================
// SECTION 20: ASSIGN EDITOR (เพิ่มเติมจาก Receive)
// ============================================================

/**
 * POST /api/register/assign-editor
 * กำหนด/เปลี่ยนผู้ตรวจ (editor) ให้รายการ
 */
async function handleAssignEditor(env, session, body) {
  if (!['admin', 'manager'].includes(session.role)) {
    return jsonResponse({ error: 'ไม่มีสิทธิ์' }, 403);
  }

  const { uuid, editor_email } = body || {};
  if (!uuid || !editor_email) {
    return jsonResponse({ error: 'uuid และ editor_email ต้องไม่ว่าง' }, 400);
  }

  const row = await env.DB.prepare(
    `SELECT * FROM register WHERE uuid = ?`
  ).bind(uuid).first();

  if (!row) return jsonResponse({ error: 'ไม่พบรายการ' }, 404);

  // ตรวจว่า editor_email มีในระบบและเป็น role editor/admin/manager
  const editorUser = await env.DB.prepare(
    `SELECT email, username, role FROM auth WHERE email = ? AND active = 1`
  ).bind(editor_email).first();

  if (!editorUser) {
    return jsonResponse({ error: 'ไม่พบผู้ใช้ที่ระบุ หรือผู้ใช้ถูกระงับ' }, 404);
  }

  if (!['admin','manager','editor'].includes(editorUser.role)) {
    return jsonResponse({ error: 'ผู้ใช้ที่ระบุไม่มีสิทธิ์เป็นผู้ตรวจ' }, 400);
  }

  const now = formatDateTime();
  await env.DB.prepare(
    `UPDATE register
     SET editor = ?, status = 'CHECKUP', updated_at = ?, updated_by = ?
     WHERE uuid = ?`
  ).bind(editor_email, now, session.email, uuid).run();

  await auditLog(env, {
    email: session.email, username: session.username,
    action: 'assign_editor', uuid,
    before_json: { editor: row.editor, status: row.status },
    after_json: { editor: editor_email, status: 'CHECKUP' },
    detail: `Assigned editor: ${editor_email}`,
    module: 'register',
  });

  return jsonResponse({
    success: true,
    message: `กำหนด ${editorUser.username} เป็นผู้ตรวจเรียบร้อย`
  });
}

  // ---- PATCH ROUTES (เพิ่มเติมจาก Section 15) ----

  // Auth
  if (path === '/api/auth/session' && request.method === 'GET') {
    return handleGetSession(env, session);
  }
  if (path === '/api/auth/update-profile' && request.method === 'POST') {
    return handleUpdateProfile(env, session, body);
  }
  if (path === '/api/auth/change-password' && request.method === 'POST') {
    return handleChangePassword(env, session, body);
  }

  // Master Data
  if (path === '/api/master/money-type' && request.method === 'GET') {
    return handleGetMoneyTypes(env);
  }
  if (path === '/api/master/vendor' && request.method === 'GET') {
    return handleGetVendors(env);
  }
  if (path === '/api/master/dept' && request.method === 'GET') {
    return handleGetDepts(env);
  }

  // Settings All
  if (path === '/api/settings/all' && request.method === 'GET') {
    return handleGetAllSettings(env, session);
  }

  // Users
  if (path === '/api/users/list' && request.method === 'GET') {
    return handleUserList(env, session);
  }
  if (path === '/api/users/create' && request.method === 'POST') {
    return handleUserCreate(env, session, body);
  }
  if (path === '/api/users/update' && request.method === 'POST') {
    return handleUserUpdate(env, session, body);
  }
  if (path === '/api/users/reset-password' && request.method === 'POST') {
    return handleUserResetPassword(env, session, body);
  }

  // Logs
  if (path === '/api/system/logs' && request.method === 'GET') {
    return handleGetLogs(env, session, url.searchParams);
  }

  // Assign Editor
  if (path === '/api/register/assign-editor' && request.method === 'POST') {
    return handleAssignEditor(env, session, body);
  }
