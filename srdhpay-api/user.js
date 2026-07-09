// user.js - จัดการผู้ใช้งาน

import { validateToken, hasPermission, sha256, auditLog, logAction, jsonResponse, errorResponse, successResponse } from './helper.js';

export const handleUser = {
  async list(request, env) {
    try {
      const user = await validateToken(request, env);
      const canManage = await hasPermission(env, 'auth_manage', user.role);
      if (!canManage) return errorResponse('Permission denied', 403);

      const stmt = await env.DB.prepare(
        `SELECT id, email, role, username, position, dept, active, force_change_password, darkmode, created_at, updated_at 
         FROM auth ORDER BY id`
      );
      const rows = await stmt.all();
      return successResponse(rows.results || []);
    } catch (err) {
      return errorResponse(err.message, 401);
    }
  },

  async create(request, env) {
    try {
      const user = await validateToken(request, env);
      const canManage = await hasPermission(env, 'auth_manage', user.role);
      if (!canManage) return errorResponse('Permission denied', 403);

      const body = await request.json();
      const { email, password, username, position, dept, role } = body;

      if (!email || !password || !username || !role) {
        return errorResponse('Email, password, username, and role are required');
      }

      // Check if email exists
      const check = await env.DB.prepare(`SELECT email FROM auth WHERE email = ?`);
      const exists = await check.bind(email).first();
      if (exists) return errorResponse('Email already exists');

      // Manager cannot create admin
      if (user.role === 'manager' && role === 'admin') {
        return errorResponse('Manager cannot create admin user');
      }

      const hashed = await sha256(password);
      const today = new Date().toISOString();

      const stmt = await env.DB.prepare(
        `INSERT INTO auth (email, password, role, username, position, dept, active, force_change_password, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`
      );
      const result = await stmt.bind(email, hashed, role, username, position || null, dept || null, user.username, user.username).run();

      await auditLog(
        env,
        user.email,
        user.username,
        'create_user',
        null,
        result.meta.last_row_id,
        null,
        { email, role, username, dept },
        'Created new user',
        'auth'
      );

      return successResponse({ id: result.meta.last_row_id });
    } catch (err) {
      return errorResponse(`Create user failed: ${err.message}`, 500);
    }
  },

  async update(request, env, id) {
    try {
      const user = await validateToken(request, env);
      const canManage = await hasPermission(env, 'auth_manage', user.role);
      if (!canManage) return errorResponse('Permission denied', 403);

      const body = await request.json();
      const { username, position, dept, role, active } = body;

      // Fetch existing user
      const fetchStmt = await env.DB.prepare(`SELECT * FROM auth WHERE id = ?`);
      const existing = await fetchStmt.bind(id).first();
      if (!existing) return errorResponse('User not found');

      // Manager cannot modify admin
      if (user.role === 'manager' && (existing.role === 'admin' || role === 'admin')) {
        return errorResponse('Manager cannot modify admin users');
      }

      const fields = [];
      const values = [];
      if (username) { fields.push('username = ?'); values.push(username); }
      if (position !== undefined) { fields.push('position = ?'); values.push(position); }
      if (dept) { fields.push('dept = ?'); values.push(dept); }
      if (role) { fields.push('role = ?'); values.push(role); }
      if (active !== undefined) { fields.push('active = ?'); values.push(active); }

      if (fields.length === 0) return errorResponse('No fields to update');

      fields.push('updated_at = ?');
      values.push(new Date().toISOString());
      fields.push('updated_by = ?');
      values.push(user.username);
      values.push(id);

      const stmt = await env.DB.prepare(`UPDATE auth SET ${fields.join(', ')} WHERE id = ?`);
      await stmt.bind(...values).run();

      await auditLog(
        env,
        user.email,
        user.username,
        'update_user',
        null,
        id,
        existing,
        { ...existing, username, position, dept, role, active },
        'Updated user',
        'auth'
      );

      return successResponse({ updated: true });
    } catch (err) {
      return errorResponse(`Update user failed: ${err.message}`, 500);
    }
  },

  async delete(request, env, id) {
    try {
      const user = await validateToken(request, env);
      const canManage = await hasPermission(env, 'auth_manage', user.role);
      if (!canManage) return errorResponse('Permission denied', 403);

      // Cannot delete self
      const selfStmt = await env.DB.prepare(`SELECT email FROM auth WHERE id = ?`);
      const target = await selfStmt.bind(id).first();
      if (!target) return errorResponse('User not found');
      if (target.email === user.email) {
        return errorResponse('Cannot delete your own account');
      }

      // Manager cannot delete admin
      if (user.role === 'manager') {
        const roleCheck = await env.DB.prepare(`SELECT role FROM auth WHERE id = ?`);
        const targetRole = await roleCheck.bind(id).first();
        if (targetRole && targetRole.role === 'admin') {
          return errorResponse('Manager cannot delete admin user');
        }
      }

      const stmt = await env.DB.prepare(`DELETE FROM auth WHERE id = ?`);
      await stmt.bind(id).run();

      await auditLog(
        env,
        user.email,
        user.username,
        'delete_user',
        null,
        id,
        target,
        null,
        'Deleted user',
        'auth'
      );

      return successResponse({ deleted: true });
    } catch (err) {
      return errorResponse(`Delete user failed: ${err.message}`, 500);
    }
  },

  async resetPassword(request, env) {
    try {
      const user = await validateToken(request, env);
      const canManage = await hasPermission(env, 'auth_manage', user.role);
      if (!canManage) return errorResponse('Permission denied', 403);

      const body = await request.json();
      const { email } = body;
      if (!email) return errorResponse('Email is required');

      // Get default password from settings
      const defaultStmt = await env.DB.prepare(`SELECT value FROM settings_app WHERE key = 'default_password'`);
      const defaultRow = await defaultStmt.first();
      const defaultPassword = defaultRow ? defaultRow.value : '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4';

      const stmt = await env.DB.prepare(
        `UPDATE auth SET password = ?, force_change_password = 1, updated_at = ?, updated_by = ? WHERE email = ?`
      );
      await stmt.bind(defaultPassword, new Date().toISOString(), user.username, email).run();

      await auditLog(
        env,
        user.email,
        user.username,
        'reset_password',
        null,
        null,
        null,
        { email },
        'Reset password',
        'auth'
      );

      return successResponse({ reset: true });
    } catch (err) {
      return errorResponse(`Reset password failed: ${err.message}`, 500);
    }
  }
};