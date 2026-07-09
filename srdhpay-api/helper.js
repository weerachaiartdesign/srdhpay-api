// helper.js - Common utilities

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
  });
}

export function errorResponse(message, status = 400) {
  return jsonResponse({ success: false, error: message }, status);
}

export function successResponse(data = null, message = 'Success') {
  return jsonResponse({ success: true, data, message });
}

// SHA-256 hash using Web Crypto API
export async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Validate token & return user info
export async function validateToken(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('Missing or invalid token');
  }
  const token = authHeader.split(' ')[1];

  const stmt = await env.DB.prepare(
    `SELECT email, role, username, guest_flag, active, expire_at 
     FROM sessions WHERE token = ? AND active = 1`
  );
  const result = await stmt.bind(token).first();

  if (!result) throw new Error('Invalid session');
  if (result.expire_at && new Date(result.expire_at) < new Date()) {
    throw new Error('Session expired');
  }
  if (result.active === 0) throw new Error('Account inactive');

  return {
    email: result.email,
    role: result.role,
    username: result.username,
    guest_flag: result.guest_flag,
    token,
  };
}

// Check permission from settings_permission
export async function hasPermission(env, module, role) {
  const stmt = await env.DB.prepare(
    `SELECT ${role} FROM settings_permission WHERE module = ?`
  );
  const result = await stmt.bind(module).first();
  return result && result[role] === 1;
}

// Log user action
export async function logAction(env, email, username, role, action, page = null, detail = null, token_id = null) {
  const stmt = await env.DB.prepare(
    `INSERT INTO logs (email, username, role, action, page, detail, token_id) 
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  await stmt.bind(email, username, role, action, page, detail, token_id).run();
}

// Audit log (important changes)
export async function auditLog(env, email, username, action, uuid, row_id, before_json, after_json, detail, module) {
  const stmt = await env.DB.prepare(
    `INSERT INTO audit_logs (email, username, action, uuid, row_id, before_json, after_json, detail, module) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  await stmt.bind(
    email, username, action, uuid, row_id, 
    before_json ? JSON.stringify(before_json) : null,
    after_json ? JSON.stringify(after_json) : null,
    detail, module
  ).run();
}

// Send Telegram notification
export async function sendTelegram(env, message) {
  try {
    // Read config from settings_system
    const stmt = await env.DB.prepare(
      `SELECT key, value FROM settings_system WHERE key IN ('telegram_enabled', 'telegram_bot_token', 'telegram_chat_id')`
    );
    const rows = await stmt.all();
    const config = {};
    rows.results.forEach(row => {
      config[row.key] = row.value;
    });

    if (!config.telegram_enabled || config.telegram_enabled !== '1') return;
    if (!config.telegram_bot_token || !config.telegram_chat_id) return;

    const url = `https://api.telegram.org/bot${config.telegram_bot_token}/sendMessage`;
    const body = JSON.stringify({
      chat_id: config.telegram_chat_id,
      text: message,
      parse_mode: 'HTML',
    });

    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  } catch (e) {
    console.error('Telegram failed:', e);
  }
}

// Get current fiscal year (2 digits) from settings
export async function getFiscalYearShort(env) {
  const stmt = await env.DB.prepare(
    `SELECT value FROM settings_app WHERE key = 'fiscal_year_short'`
  );
  const result = await stmt.first();
  return result ? result.value : '69';
}

// Get register_no and receive_no counters (for running number)
export async function getNextRunningNumber(env, key, fiscalYear) {
  // This function is used by running.js
  // We'll implement the actual logic in running.js
}

// Date helpers
export function toThaiDate(dateStr) {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  const thaiMonths = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  return `${d.getDate()} ${thaiMonths[d.getMonth()]} ${d.getFullYear() + 543}`;
}

export function toISODate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return d.toISOString().split('T')[0];
}

// Validate date sequence (for workflow)
export function validateDateSequence(dates) {
  // dates: { register, receive, edit, return, pass, propose, approve, pay, cancel }
  // Returns true if all dates are in order (if present)
  const keys = ['register', 'receive', 'edit', 'return', 'pass', 'propose', 'approve', 'pay', 'cancel'];
  let prev = null;
  for (const key of keys) {
    if (dates[key]) {
      const curr = new Date(dates[key]);
      if (prev && curr < prev) return false;
      prev = curr;
    }
  }
  return true;
}