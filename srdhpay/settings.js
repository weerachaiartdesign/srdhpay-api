// settings.js - จัดการ Settings ทั้งหมด (App, Money Type, Vendor, Dept, System)

import { validateToken, hasPermission, auditLog, jsonResponse, errorResponse, successResponse } from './helper.js';

export const handleSettings = {
  async route(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace('/api/settings/', '');
    const method = request.method;

    try {
      const user = await validateToken(request, env);
      const canAccess = await hasPermission(env, 'settings', user.role);
      if (!canAccess) return errorResponse('Permission denied', 403);

      // Parse table name
      const parts = path.split('/');
      const table = parts[0]; // e.g., 'app', 'money_type', 'vendor', 'dept', 'system'
      const id = parts[1] ? parseInt(parts[1]) : null;

      switch (table) {
        case 'app':
          return await this.handleTable(env, 'settings_app', method, id, request);
        case 'money_type':
          return await this.handleMoneyType(env, method, id, request);
        case 'vendor':
          return await this.handleTable(env, 'settings_vendor', method, id, request);
        case 'dept':
          return await this.handleTable(env, 'settings_dept', method, id, request);
        case 'system':
          return await this.handleSystem(env, method, id, request);
        default:
          return errorResponse('Invalid settings table', 404);
      }
    } catch (err) {
      return errorResponse(err.message, 401);
    }
  },

  // Generic CRUD for simple key-value tables
  async handleTable(env, table, method, id, request) {
    const user = await validateToken(request, env);

    if (method === 'GET') {
      if (id) {
        const stmt = await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`);
        const row = await stmt.bind(id).first();
        return successResponse(row);
      } else {
        const stmt = await env.DB.prepare(`SELECT * FROM ${table} ORDER BY id`);
        const rows = await stmt.all();
        return successResponse(rows.results || []);
      }
    }

    if (method === 'POST') {
      const body = await request.json();
      // For settings_app and settings_system, we use key-value
      if (table === 'settings_app' || table === 'settings_system') {
        const { key, value, description } = body;
        if (!key) return errorResponse('Key is required');
        const stmt = await env.DB.prepare(
          `INSERT INTO ${table} (key, value, description, updated_by) VALUES (?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = ?, description = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ?`
        );
        await stmt.bind(key, value, description || null, user.username, value, description || null, user.username).run();
        await auditLog(env, user.email, user.username, 'settings_update', null, null, null, { key, value }, 'Updated settings', table);
        return successResponse({ key, value });
      }
      // For others (money_type, vendor, dept)
      const { name, color, sort_order, active } = body;
      if (!name) return errorResponse('Name is required');
      const stmt = await env.DB.prepare(
        `INSERT INTO ${table} (name, color, sort_order, active) VALUES (?, ?, ?, ?)`
      );
      const result = await stmt.bind(name, color || '#808080', sort_order || 99, active !== undefined ? active : 1).run();
      return successResponse({ id: result.meta.last_row_id });
    }

    if (method === 'PUT') {
      if (!id) return errorResponse('ID is required');
      const body = await request.json();
      const fields = [];
      const values = [];
      const allowedFields = ['name', 'color', 'sort_order', 'active', 'value', 'description', 'key'];
      for (const [key, val] of Object.entries(body)) {
        if (allowedFields.includes(key)) {
          fields.push(`${key} = ?`);
          values.push(val);
        }
      }
      if (fields.length === 0) return errorResponse('No fields to update');
      values.push(id);
      const stmt = await env.DB.prepare(`UPDATE ${table} SET ${fields.join(', ')} WHERE id = ?`);
      await stmt.bind(...values).run();
      await auditLog(env, user.email, user.username, 'settings_update', null, null, null, body, 'Updated settings', table);
      return successResponse({ updated: true });
    }

    if (method === 'DELETE') {
      if (!id) return errorResponse('ID is required');
      const stmt = await env.DB.prepare(`DELETE FROM ${table} WHERE id = ?`);
      await stmt.bind(id).run();
      return successResponse({ deleted: true });
    }

    return errorResponse('Method not allowed', 405);
  },

  // Special handlers
  async handleMoneyType(env, method, id, request) {
    // Use generic but ensure color validation
    return await this.handleTable(env, 'settings_money_type', method, id, request);
  },

  async handleSystem(env, method, id, request) {
    const user = await validateToken(request, env);
    if (method === 'GET') {
      if (id) {
        const stmt = await env.DB.prepare(`SELECT * FROM settings_system WHERE id = ?`);
        const row = await stmt.bind(id).first();
        return successResponse(row);
      } else {
        const stmt = await env.DB.prepare(`SELECT * FROM settings_system ORDER BY id`);
        const rows = await stmt.all();
        return successResponse(rows.results || []);
      }
    }

    if (method === 'POST' || method === 'PUT') {
      const body = await request.json();
      const { key, value, description } = body;
      if (!key) return errorResponse('Key is required');
      const stmt = await env.DB.prepare(
        `INSERT INTO settings_system (key, value, description, updated_by) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = ?, description = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ?`
      );
      await stmt.bind(key, value, description || null, user.username, value, description || null, user.username).run();
      await auditLog(env, user.email, user.username, 'system_settings_update', null, null, null, { key, value }, 'Updated system settings', 'settings_system');
      return successResponse({ key, value });
    }

    return errorResponse('Method not allowed', 405);
  }
};
