// ============================================================
// auth-middleware.js — ตรวจ Session Token และ Permission Matrix
// ทุก API ที่ต้องป้องกัน (protected) ต้องเรียกใช้ requireAuth() ก่อนเสมอ
// ตามข้อกำหนด 7.17: Backend เป็นผู้ตัดสินสิทธิ์จริง ไม่ใช่ Frontend
// ============================================================

import { fail } from './response.js';

// อ่านค่า settings_system แบบรายตัว (cache เล็กๆ ระดับ request เดียวพอ ไม่ overengineer)
async function getSystemSetting(env, key, defaultValue) {
  const row = await env.DB.prepare(
    `SELECT value FROM settings_system WHERE key = ?`
  ).bind(key).first();
  return row?.value ?? defaultValue;
}

// ตรวจ token จาก Header Authorization: Bearer <token>
// คืนค่า user object ถ้า valid, คืนค่า null ถ้าไม่ valid/หมดอายุ
export async function getSessionUser(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  if (!token) return null;

  const session = await env.DB.prepare(
    `SELECT * FROM sessions WHERE token = ? AND active = 1`
  ).bind(token).first();
  if (!session) return null;

  const now = new Date();

  // ตรวจอายุ Token (Token Age / Guest Timeout)
  if (session.expire_at && new Date(session.expire_at) < now) {
    await env.DB.prepare(`UPDATE sessions SET active = 0 WHERE token = ?`).bind(token).run();
    return null;
  }

  // ตรวจ Inactivity Timeout (ไม่มีการใช้งานนานเกินกำหนด)
  const inactivityMinutes = parseInt(
    await getSystemSetting(env, 'session_inactivity_minutes', '30'), 10
  );
  const diffMinutes = (now - new Date(session.last_active_at)) / 60000;
  if (diffMinutes > inactivityMinutes) {
    await env.DB.prepare(`UPDATE sessions SET active = 0 WHERE token = ?`).bind(token).run();
    return null;
  }

  // Sliding window: ขยับเวลา last_active_at ทุกครั้งที่มีการเรียก API สำเร็จ
  await env.DB.prepare(
    `UPDATE sessions SET last_active_at = CURRENT_TIMESTAMP WHERE token = ?`
  ).bind(token).run();

  return {
    token: session.token,
    email: session.email,
    role: session.role,
    username: session.username,
    isGuest: session.guest_flag === 1
  };
}

// ใช้ต้น route handler: const { user, error } = await requireAuth(request, env); if (error) return error;
export async function requireAuth(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) {
    return { error: fail('กรุณาเข้าสู่ระบบ หรือ Session หมดอายุ', 401) };
  }
  return { user };
}

// ตรวจสิทธิ์เข้าถึง module ตาม Permission Matrix (settings_permission)
// module เช่น 'import', 'receive', 'verify', 'approve', 'payment', 'settings', 'system' ฯลฯ
export async function hasPermission(env, role, moduleName) {
  const row = await env.DB.prepare(
    `SELECT * FROM settings_permission WHERE module = ?`
  ).bind(moduleName).first();
  if (!row) return false;
  return row[role] === 1;
}

// ใช้ต้น route handler หลัง requireAuth แล้ว:
// const permError = await requirePermission(env, user, 'import'); if (permError) return permError;
export async function requirePermission(env, user, moduleName) {
  const allowed = await hasPermission(env, user.role, moduleName);
  if (!allowed) {
    return fail('คุณไม่มีสิทธิ์เข้าถึงส่วนนี้', 403);
  }
  return null;
}
