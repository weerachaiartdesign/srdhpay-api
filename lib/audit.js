// ============================================================
// audit.js — เขียน logs (กิจกรรมทั่วไป) และ audit_logs (เหตุการณ์กระทบข้อมูล)
// ============================================================

// logs: login, logout, guest access, page access, session timeout, login failed
export async function writeLog(env, { request, email, username, role, action, page, detail }) {
  const ip = request?.headers.get('CF-Connecting-IP') || '';
  const userAgent = request?.headers.get('User-Agent') || '';
  await env.DB.prepare(
    `INSERT INTO logs (email, username, role, action, page, detail, ip, user_agent)
     VALUES (?,?,?,?,?,?,?,?)`
  ).bind(email || null, username || null, role || null, action, page || null, detail || null, ip, userAgent).run();
}

// audit_logs: create, update, status change, import, receive, assign editor,
// verify, pass, propose, approve, payment, cancel, recovery, restore, settings/permission change
export async function writeAudit(env, { email, username, action, uuid, rowId, before, after, detail, module }) {
  await env.DB.prepare(
    `INSERT INTO audit_logs (email, username, action, uuid, row_id, before_json, after_json, detail, module)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(
    email || null,
    username || null,
    action,
    uuid || null,
    rowId || null,
    before !== undefined ? JSON.stringify(before) : null,
    after !== undefined ? JSON.stringify(after) : null,
    detail || null,
    module || null
  ).run();
}
