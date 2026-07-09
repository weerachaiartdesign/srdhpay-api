// auth.js - Login, Guest, Logout, Session

import { 
  sha256, 
  validateToken, 
  logAction, 
  jsonResponse, 
  errorResponse, 
  successResponse,
  corsHeaders 
} from './helper.js';

export const handleAuth = {
  // Login
  async login(request, env) {
    const body = await request.json();
    const { email, password } = body;

    if (!email || !password) {
      return errorResponse('Email and password required');
    }

    // Hash password
    const hashed = await sha256(password);

    const stmt = await env.DB.prepare(
      `SELECT id, email, role, username, active, force_change_password 
       FROM auth WHERE email = ? AND password = ?`
    );
    const user = await stmt.bind(email, hashed).first();

    if (!user) {
      await logAction(env, email, null, null, 'login_failed', null, 'Invalid credentials');
      return errorResponse('Invalid email or password', 401);
    }

    if (user.active === 0) {
      await logAction(env, email, user.username, user.role, 'login_failed', null, 'Account inactive');
      return errorResponse('Account is inactive', 403);
    }

    // Create session token (UUID v4 simple)
    const token = crypto.randomUUID();
    const loginAt = new Date().toISOString();
    // Expire after 12 hours (from settings_system)
    const expireHours = await this._getSessionTokenAge(env);
    const expireAt = new Date(Date.now() + expireHours * 3600000).toISOString();

    const insert = await env.DB.prepare(
      `INSERT INTO sessions (token, email, role, username, login_at, expire_at, last_active_at, guest_flag, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1)`
    );
    await insert.bind(token, user.email, user.role, user.username, loginAt, expireAt, loginAt).run();

    // Log success
    await logAction(env, user.email, user.username, user.role, 'login', null, 'Login successful', token);

    return successResponse({
      token,
      email: user.email,
      role: user.role,
      username: user.username,
      force_change_password: user.force_change_password === 1,
      darkmode: 0, // Will be read from auth.darkmode, we'll fetch it
    });
  },

  // Guest login
  async guest(request, env) {
    const guestId = 'G-' + crypto.randomUUID().substring(0, 6).toUpperCase();
    const token = crypto.randomUUID();
    const loginAt = new Date().toISOString();
    const expireHours = await this._getGuestTimeout(env);
    const expireAt = new Date(Date.now() + expireHours * 3600000).toISOString();

    const insert = await env.DB.prepare(
      `INSERT INTO sessions (token, email, role, username, login_at, expire_at, last_active_at, guest_flag, active)
       VALUES (?, ?, 'guest', ?, ?, ?, ?, 1, 1)`
    );
    await insert.bind(token, guestId, guestId, loginAt, expireAt, loginAt).run();

    await logAction(env, guestId, guestId, 'guest', 'guest_access', null, 'Guest login', token);

    return successResponse({
      token,
      email: guestId,
      role: 'guest',
      username: 'ผู้เยี่ยมชม',
      guest_flag: 1,
    });
  },

  // Logout
  async logout(request, env) {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return errorResponse('Missing token', 401);
    }
    const token = authHeader.split(' ')[1];

    // Get user info before deleting
    const stmt = await env.DB.prepare(`SELECT email, username, role FROM sessions WHERE token = ?`);
    const session = await stmt.bind(token).first();

    // Delete session
    const del = await env.DB.prepare(`DELETE FROM sessions WHERE token = ?`);
    await del.bind(token).run();

    if (session) {
      await logAction(env, session.email, session.username, session.role, 'logout', null, 'Logout');
    }

    return successResponse(null, 'Logged out');
  },

  // Get current user info
  async me(request, env) {
    try {
      const user = await validateToken(request, env);
      // Also get darkmode from auth table
      const stmt = await env.DB.prepare(`SELECT darkmode FROM auth WHERE email = ?`);
      const row = await stmt.bind(user.email).first();
      return successResponse({
        ...user,
        darkmode: row ? row.darkmode : 0,
      });
    } catch (err) {
      return errorResponse(err.message, 401);
    }
  },

  // Helper to get session token age
  async _getSessionTokenAge(env) {
    const stmt = await env.DB.prepare(
      `SELECT value FROM settings_system WHERE key = 'session_token_age_hours'`
    );
    const result = await stmt.first();
    return result ? parseInt(result.value) : 12;
  },

  async _getGuestTimeout(env) {
    const stmt = await env.DB.prepare(
      `SELECT value FROM settings_system WHERE key = 'session_guest_timeout_hours'`
    );
    const result = await stmt.first();
    return result ? parseInt(result.value) : 2;
  }
};
