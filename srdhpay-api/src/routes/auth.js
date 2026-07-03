// ============================================================
// routes/auth.js — login, guest, logout, profile, จัดการผู้ใช้
// ============================================================

import { ok, fail, readJsonBody } from '../lib/response.js';
import { sha256Hex, generateToken, generateGuestId } from '../lib/crypto.js';
import { requireAuth, requirePermission } from '../lib/auth-middleware.js';
import { writeLog, writeAudit } from '../lib/audit.js';

async function getSetting(env, key, def) {
  const row = await env.DB.prepare(`SELECT value FROM settings_system WHERE key = ?`).bind(key).first();
  return row?.value ?? def;
}

function addHours(date, hours) {
  return new Date(date.getTime() + hours * 3600 * 1000);
}

function toDbDatetime(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

// ------------------------------------------------------------
// POST /api/auth/login
// ------------------------------------------------------------
async function handleLogin(request, env) {
  const body = await readJsonBody(request);
  const email = (body.email || '').trim().toLowerCase();
  const password = body.password || '';

  if (!email || !password) {
    return fail('กรุณากรอกอีเมลและรหัสผ่าน', 400);
  }

  // ป้องกัน Brute-force: นับครั้ง login ผิดพลาดล่าสุดภายใน 15 นาที
  const maxRetry = parseInt(await getSetting(env, 'session_max_login_retry', '5'), 10);
  const recentFails = await env.DB.prepare(
    `SELECT COUNT(*) as cnt FROM logs
     WHERE email = ? AND action = 'login_failed' AND time >= datetime('now', '-15 minutes')`
  ).bind(email).first();
  if ((recentFails?.cnt || 0) >= maxRetry) {
    return fail(`เข้าสู่ระบบผิดพลาดเกิน ${maxRetry} ครั้ง กรุณาลองใหม่ภายหลัง`, 429);
  }

  const userRow = await env.DB.prepare(`SELECT * FROM auth WHERE email = ?`).bind(email).first();
  const passwordHash = await sha256Hex(password);

  if (!userRow || userRow.password !== passwordHash) {
    await writeLog(env, { request, email, action: 'login_failed', page: 'index', detail: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' });
    return fail('อีเมลหรือรหัสผ่านไม่ถูกต้อง', 401);
  }

  if (userRow.active !== 1) {
    await writeLog(env, { request, email, username: userRow.username, action: 'login_failed', page: 'index', detail: 'บัญชีถูกปิดใช้งาน' });
    return fail('บัญชีนี้ถูกปิดใช้งาน กรุณาติดต่อผู้ดูแลระบบ', 403);
  }

  const tokenAgeHours = parseInt(await getSetting(env, 'session_token_age_hours', '12'), 10);
  const token = generateToken();
  const expireAt = addHours(new Date(), tokenAgeHours);

  await env.DB.prepare(
    `INSERT INTO sessions (token, email, role, username, expire_at, guest_flag, active)
     VALUES (?,?,?,?,?,0,1)`
  ).bind(token, userRow.email, userRow.role, userRow.username, toDbDatetime(expireAt)).run();

  await writeLog(env, { request, email: userRow.email, username: userRow.username, role: userRow.role, action: 'login_success', page: 'index' });

  return ok({
    token,
    user: {
      email: userRow.email,
      username: userRow.username,
      role: userRow.role,
      position: userRow.position,
      dept: userRow.dept,
      darkmode: userRow.darkmode === 1,
      force_change_password: userRow.force_change_password === 1
    }
  });
}

// ------------------------------------------------------------
// POST /api/auth/guest
// ------------------------------------------------------------
async function handleGuest(request, env) {
  const guestId = generateGuestId();
  const guestTimeoutHours = parseInt(await getSetting(env, 'session_guest_timeout_hours', '2'), 10);
  const token = generateToken();
  const expireAt = addHours(new Date(), guestTimeoutHours);

  await env.DB.prepare(
    `INSERT INTO sessions (token, email, role, username, expire_at, guest_flag, active)
     VALUES (?, ?, 'guest', 'ผู้เยี่ยมชม', ?, 1, 1)`
  ).bind(token, guestId, toDbDatetime(expireAt)).run();

  await writeLog(env, { request, email: guestId, username: 'ผู้เยี่ยมชม', role: 'guest', action: 'guest_access', page: 'index' });

  return ok({
    token,
    user: { email: guestId, username: 'ผู้เยี่ยมชม', role: 'guest', isGuest: true }
  });
}

// ------------------------------------------------------------
// POST /api/auth/logout
// ------------------------------------------------------------
async function handleLogout(request, env) {
  const { user, error } = await requireAuth(request, env);
  if (error) return error;

  await env.DB.prepare(`UPDATE sessions SET active = 0 WHERE token = ?`).bind(user.token).run();
  await writeLog(env, { request, email: user.email, username: user.username, role: user.role, action: 'logout', page: 'index' });

  return ok({ message: 'ออกจากระบบสำเร็จ' });
}

// ------------------------------------------------------------
// GET /api/auth/profile
// ------------------------------------------------------------
async function handleGetProfile(request, env) {
  const { user, error } = await requireAuth(request, env);
  if (error) return error;
  if (user.isGuest) return fail('ผู้เยี่ยมชมไม่มีข้อมูลส่วนตัว', 403);

  const row = await env.DB.prepare(
    `SELECT email, username, role, position, dept, darkmode, force_change_password FROM auth WHERE email = ?`
  ).bind(user.email).first();
  if (!row) return fail('ไม่พบข้อมูลผู้ใช้', 404);

  return ok({
    data: {
      ...row,
      darkmode: row.darkmode === 1,
      force_change_password: row.force_change_password === 1
    }
  });
}

// ------------------------------------------------------------
// PUT /api/auth/profile  (แก้ชื่อ-สกุล/ตำแหน่ง/darkmode/เปลี่ยนรหัสผ่าน)
// ------------------------------------------------------------
async function handleUpdateProfile(request, env) {
  const { user, error } = await requireAuth(request, env);
  if (error) return error;
  if (user.isGuest) return fail('ผู้เยี่ยมชมไม่สามารถแก้ไขข้อมูลได้', 403);

  const body = await readJsonBody(request);
  const before = await env.DB.prepare(`SELECT * FROM auth WHERE email = ?`).bind(user.email).first();

  const fields = [];
  const values = [];

  if (typeof body.username === 'string' && body.username.trim()) {
    fields.push('username = ?'); values.push(body.username.trim());
  }
  if (typeof body.position === 'string') {
    fields.push('position = ?'); values.push(body.position.trim());
  }
  if (typeof body.darkmode === 'boolean') {
    fields.push('darkmode = ?'); values.push(body.darkmode ? 1 : 0);
  }

  // เปลี่ยนรหัสผ่าน: ต้องส่ง current_password มายืนยันก่อนเสมอ
  if (body.new_password) {
    if (!body.current_password) return fail('กรุณากรอกรหัสผ่านเดิม', 400);
    const currentHash = await sha256Hex(body.current_password);
    if (currentHash !== before.password) return fail('รหัสผ่านเดิมไม่ถูกต้อง', 400);
    const newHash = await sha256Hex(body.new_password);
    fields.push('password = ?'); values.push(newHash);
    fields.push('force_change_password = 0');
  }

  if (fields.length === 0) return fail('ไม่มีข้อมูลที่ต้องการแก้ไข', 400);

  fields.push('updated_at = CURRENT_TIMESTAMP');
  fields.push('updated_by = ?'); values.push(user.email);

  await env.DB.prepare(`UPDATE auth SET ${fields.join(', ')} WHERE email = ?`)
    .bind(...values, user.email).run();

  const after = await env.DB.prepare(`SELECT * FROM auth WHERE email = ?`).bind(user.email).first();
  await writeAudit(env, {
    email: user.email, username: user.username, action: 'update_profile',
    before, after, module: 'auth'
  });

  return ok({ message: 'บันทึกข้อมูลสำเร็จ' });
}

// ------------------------------------------------------------
// GET /api/auth/users?search=...   (admin, manager)
// ------------------------------------------------------------
async function handleListUsers(request, env) {
  const { user, error } = await requireAuth(request, env);
  if (error) return error;
  const permError = await requirePermission(env, user, 'auth_manage');
  if (permError) return permError;

  const url = new URL(request.url);
  const search = url.searchParams.get('search') || '';

  let query = `SELECT id, email, username, position, dept, role, active, force_change_password, created_at FROM auth WHERE 1=1`;
  const params = [];
  if (search) {
    query += ` AND (email LIKE ? OR username LIKE ? OR dept LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  query += ` ORDER BY created_at DESC`;

  const rows = await env.DB.prepare(query).bind(...params).all();

  const countRow = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) as active_count,
       SUM(CASE WHEN active = 0 THEN 1 ELSE 0 END) as inactive_count
     FROM auth`
  ).first();

  return ok({
    data: rows.results,
    active_count: countRow?.active_count || 0,
    inactive_count: countRow?.inactive_count || 0
  });
}

// ------------------------------------------------------------
// POST /api/auth/users   (เพิ่มผู้ใช้ใหม่)
// ------------------------------------------------------------
async function handleCreateUser(request, env) {
  const { user, error } = await requireAuth(request, env);
  if (error) return error;
  const permError = await requirePermission(env, user, 'auth_manage');
  if (permError) return permError;

  const body = await readJsonBody(request);
  const { email, username, position, dept, role, temp_password } = body;

  if (!email || !username || !dept || !role || !temp_password) {
    return fail('กรุณากรอกข้อมูลให้ครบถ้วน', 400);
  }
  if (user.role === 'manager' && role === 'admin') {
    return fail('Manager ไม่มีสิทธิ์สร้างผู้ใช้ระดับ Admin', 403);
  }

  const cleanEmail = email.trim().toLowerCase();
  const existing = await env.DB.prepare(`SELECT id FROM auth WHERE email = ?`).bind(cleanEmail).first();
  if (existing) return fail('อีเมลนี้มีผู้ใช้งานอยู่แล้ว', 409);

  const passwordHash = await sha256Hex(temp_password);
  await env.DB.prepare(
    `INSERT INTO auth (email, password, role, username, position, dept, active, force_change_password, created_by)
     VALUES (?,?,?,?,?,?,1,1,?)`
  ).bind(cleanEmail, passwordHash, role, username.trim(), position || '', dept, user.email).run();

  await writeAudit(env, {
    email: user.email, username: user.username, action: 'create_user',
    detail: `สร้างผู้ใช้ ${cleanEmail} (role: ${role})`, module: 'auth'
  });

  return ok({ message: 'เพิ่มผู้ใช้สำเร็จ' });
}

// ------------------------------------------------------------
// PUT /api/auth/users/:id   (แก้ไขผู้ใช้, reset password, เปลี่ยน active)
// ------------------------------------------------------------
async function handleUpdateUser(request, env, targetId) {
  const { user, error } = await requireAuth(request, env);
  if (error) return error;
  const permError = await requirePermission(env, user, 'auth_manage');
  if (permError) return permError;

  const before = await env.DB.prepare(`SELECT * FROM auth WHERE id = ?`).bind(targetId).first();
  if (!before) return fail('ไม่พบผู้ใช้งาน', 404);

  const body = await readJsonBody(request);

  // ข้อจำกัด: manager แก้ไข/มอบสิทธิ์ระดับ admin ไม่ได้
  if (user.role === 'manager' && before.role === 'admin') {
    return fail('Manager ไม่มีสิทธิ์แก้ไขผู้ใช้ระดับ Admin', 403);
  }
  if (user.role === 'manager' && body.role === 'admin') {
    return fail('Manager ไม่มีสิทธิ์เปลี่ยนสิทธิ์ผู้ใช้เป็น Admin', 403);
  }

  const fields = [];
  const values = [];

  if (typeof body.username === 'string' && body.username.trim()) {
    fields.push('username = ?'); values.push(body.username.trim());
  }
  if (typeof body.dept === 'string' && body.dept) {
    fields.push('dept = ?'); values.push(body.dept);
  }
  if (typeof body.role === 'string' && body.role) {
    fields.push('role = ?'); values.push(body.role);
  }
  if (typeof body.active === 'boolean') {
    fields.push('active = ?'); values.push(body.active ? 1 : 0);
  }
  if (body.reset_password) {
    const newHash = await sha256Hex(body.reset_password);
    fields.push('password = ?'); values.push(newHash);
    fields.push('force_change_password = 1');
  }

  if (fields.length === 0) return fail('ไม่มีข้อมูลที่ต้องการแก้ไข', 400);

  fields.push('updated_at = CURRENT_TIMESTAMP');
  fields.push('updated_by = ?'); values.push(user.email);

  await env.DB.prepare(`UPDATE auth SET ${fields.join(', ')} WHERE id = ?`)
    .bind(...values, targetId).run();

  const after = await env.DB.prepare(`SELECT * FROM auth WHERE id = ?`).bind(targetId).first();
  await writeAudit(env, {
    email: user.email, username: user.username, action: 'update_user',
    rowId: targetId, before, after, module: 'auth'
  });

  return ok({ message: 'แก้ไขข้อมูลผู้ใช้สำเร็จ' });
}

// ------------------------------------------------------------
// DELETE /api/auth/users/:id   (เฉพาะ admin เท่านั้น)
// ------------------------------------------------------------
async function handleDeleteUser(request, env, targetId) {
  const { user, error } = await requireAuth(request, env);
  if (error) return error;
  if (user.role !== 'admin') {
    return fail('เฉพาะ Admin เท่านั้นที่สามารถลบผู้ใช้งานได้', 403);
  }

  const before = await env.DB.prepare(`SELECT * FROM auth WHERE id = ?`).bind(targetId).first();
  if (!before) return fail('ไม่พบผู้ใช้งาน', 404);

  await env.DB.prepare(`DELETE FROM auth WHERE id = ?`).bind(targetId).run();
  await writeAudit(env, {
    email: user.email, username: user.username, action: 'delete_user',
    rowId: targetId, before, module: 'auth'
  });

  return ok({ message: 'ลบผู้ใช้งานสำเร็จ' });
}

// ------------------------------------------------------------
// Dispatcher หลักของโมดูล Auth
// ------------------------------------------------------------
export async function handleAuthRoutes(request, env, path) {
  const method = request.method;

  if (path === '/api/auth/login' && method === 'POST') return handleLogin(request, env);
  if (path === '/api/auth/guest' && method === 'POST') return handleGuest(request, env);
  if (path === '/api/auth/logout' && method === 'POST') return handleLogout(request, env);
  if (path === '/api/auth/profile' && method === 'GET') return handleGetProfile(request, env);
  if (path === '/api/auth/profile' && method === 'PUT') return handleUpdateProfile(request, env);
  if (path === '/api/auth/users' && method === 'GET') return handleListUsers(request, env);
  if (path === '/api/auth/users' && method === 'POST') return handleCreateUser(request, env);

  const userIdMatch = path.match(/^\/api\/auth\/users\/(\d+)$/);
  if (userIdMatch) {
    const targetId = parseInt(userIdMatch[1], 10);
    if (method === 'PUT') return handleUpdateUser(request, env, targetId);
    if (method === 'DELETE') return handleDeleteUser(request, env, targetId);
  }

  return fail('ไม่พบ Endpoint นี้ใน Auth Module', 404);
}
