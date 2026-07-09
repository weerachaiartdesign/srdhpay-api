// system.js - Permission, Session, Retention, Telegram

import { validateToken, auditLog, jsonResponse, errorResponse, successResponse } from './helper.js';

export const handleSystem = {
  async route(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace('/api/system/', '');
    const method = request.method;

    try {
      const user = await validateToken(request, env);
      if (user.role !== 'admin') {
        return errorResponse('Permission denied', 403);
      }

      switch (path) {
        case 'permission':
          return await this.handlePermission(env, method, request);
        case 'session':
          return await this.handleSession(env, method, request);
        case 'retention':
          return await this.handleRetention(env, method, request);
        case 'telegram':
          return await this.handleTelegram(env, method, request);
        case 'backup':
          return await this.handleBackup(env, method, request);
        default:
          return errorResponse('Invalid system endpoint', 404);
      }
    } catch (err) {
      return errorResponse(err.message, 401);
    }
  },

  // 5.12.1 Permission Matrix
  async handlePermission(env, method, request) {
    const user = await validateToken(request, env);
    if (method === 'GET') {
      const stmt = await env.DB.prepare(`SELECT * FROM settings_permission ORDER BY id`);
      const rows = await stmt.all();
      return successResponse(rows.results || []);
    }

    if (method === 'PUT') {
      const body = await request.json();
      const { id, admin, manager, editor, checker, staff, guest } = body;
      if (!id) return errorResponse('Permission ID required');

      const stmt = await env.DB.prepare(
        `UPDATE settings_permission SET 
          admin = ?, manager = ?, editor = ?, checker = ?, staff = ?, guest = ?,
          updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      );
      await stmt.bind(
        admin !== undefined ? admin : 0,
        manager !== undefined ? manager : 0,
        editor !== undefined ? editor : 0,
        checker !== undefined ? checker : 0,
        staff !== undefined ? staff : 0,
        guest !== undefined ? guest : 0,
        id
      ).run();

      await auditLog(
        env,
        user.email,
        user.username,
        'update_permission',
        null,
        id,
        null,
        body,
        'Updated permission matrix',
        'system'
      );

      return successResponse({ updated: true });
    }
    return errorResponse('Method not allowed', 405);
  },

  // 5.12.2 Session Settings
  async handleSession(env, method, request) {
    const user = await validateToken(request, env);
    if (method === 'GET') {
      const stmt = await env.DB.prepare(
        `SELECT * FROM settings_system WHERE key LIKE 'session_%' ORDER BY key`
      );
      const rows = await stmt.all();
      return successResponse(rows.results || []);
    }

    if (method === 'PUT') {
      const body = await request.json();
      const { key, value } = body;
      if (!key) return errorResponse('Key is required');

      const stmt = await env.DB.prepare(
        `INSERT INTO settings_system (key, value, updated_by) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ?`
      );
      await stmt.bind(key, value, user.username, value, user.username).run();

      await auditLog(
        env,
        user.email,
        user.username,
        'update_session_settings',
        null,
        null,
        null,
        { key, value },
        'Updated session settings',
        'system'
      );

      return successResponse({ updated: true });
    }
    return errorResponse('Method not allowed', 405);
  },

  // 5.12.5 Data Retention
  async handleRetention(env, method, request) {
    const user = await validateToken(request, env);
    if (method === 'GET') {
      const stmt = await env.DB.prepare(
        `SELECT * FROM settings_system WHERE key IN ('retention_enabled', 'retention_years')`
      );
      const rows = await stmt.all();
      return successResponse(rows.results || []);
    }

    if (method === 'POST') {
      // Execute retention: Backup & Delete old data
      const body = await request.json();
      const { years } = body;
      if (!years) return errorResponse('Years required');

      const cutoffDate = new Date();
      cutoffDate.setFullYear(cutoffDate.getFullYear() - years);
      const cutoffStr = cutoffDate.toISOString();

      // 1. Backup data (return as JSON for download) - handled by frontend calling this
      // But here we just delete
      const result = await env.DB.transaction(async (tx) => {
        // Backup first (select all old data)
        const selectStmt = await tx.prepare(
          `SELECT * FROM register WHERE created_at < ?`
        );
        const oldData = await selectStmt.bind(cutoffStr).all();

        // Delete old data from register
        const delStmt = await tx.prepare(
          `DELETE FROM register WHERE created_at < ?`
        );
        await delStmt.bind(cutoffStr).run();

        // Delete old audit logs
        const delAudit = await tx.prepare(
          `DELETE FROM audit_logs WHERE time < ?`
        );
        await delAudit.bind(cutoffStr).run();

        // Delete old logs
        const delLogs = await tx.prepare(
          `DELETE FROM logs WHERE time < ?`
        );
        await delLogs.bind(cutoffStr).run();

        return { deleted_count: oldData.results ? oldData.results.length : 0 };
      });

      await auditLog(
        env,
        user.email,
        user.username,
        'data_retention',
        null,
        null,
        null,
        { years, deleted: result.deleted_count },
        'Executed data retention',
        'system'
      );

      return successResponse({
        deleted: result.deleted_count,
        message: `Deleted ${result.deleted_count} records older than ${years} years`,
      });
    }
    return errorResponse('Method not allowed', 405);
  },

  // 5.12.4 Telegram Notification (Update config)
  async handleTelegram(env, method, request) {
    const user = await validateToken(request, env);
    if (method === 'GET') {
      const stmt = await env.DB.prepare(
        `SELECT * FROM settings_system WHERE key LIKE 'telegram_%' OR key LIKE 'tg_notify_%' ORDER BY key`
      );
      const rows = await stmt.all();
      return successResponse(rows.results || []);
    }

    if (method === 'PUT') {
      const body = await request.json();
      const { key, value } = body;
      if (!key) return errorResponse('Key is required');

      const stmt = await env.DB.prepare(
        `INSERT INTO settings_system (key, value, updated_by) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ?`
      );
      await stmt.bind(key, value, user.username, value, user.username).run();

      await auditLog(
        env,
        user.email,
        user.username,
        'update_telegram_config',
        null,
        null,
        null,
        { key, value },
        'Updated telegram config',
        'system'
      );

      return successResponse({ updated: true });
    }
    return errorResponse('Method not allowed', 405);
  },

  // Backup (Download data)
  async handleBackup(env, method, request) {
    const user = await validateToken(request, env);
    if (method === 'GET') {
      // Export all register data as JSON
      const stmt = await env.DB.prepare(`SELECT * FROM register ORDER BY created_at`);
      const rows = await stmt.all();

      return new Response(JSON.stringify(rows.results || [], null, 2), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Content-Disposition': `attachment; filename="backup_${new Date().toISOString().slice(0,10)}.json"`,
        },
      });
    }
    if (method === 'POST') {
      // Restore from uploaded JSON
      const body = await request.json();
      const { data } = body; // array of rows
      if (!data || !Array.isArray(data)) return errorResponse('Invalid data');

      // Insert or ignore (simple restore)
      let count = 0;
      for (const row of data) {
        // Use insert or ignore
        const cols = Object.keys(row).filter(k => k !== 'id' && k !== 'created_at' && k !== 'updated_at');
        const placeholders = cols.map(() => '?').join(',');
        const values = cols.map(k => row[k]);
        const stmt = await env.DB.prepare(
          `INSERT OR IGNORE INTO register (${cols.join(',')}) VALUES (${placeholders})`
        );
        const result = await stmt.bind(...values).run();
        if (result.meta.changes > 0) count++;
      }

      await auditLog(
        env,
        user.email,
        user.username,
        'restore_backup',
        null,
        null,
        null,
        { count },
        'Restored backup data',
        'system'
      );

      return successResponse({ restored: count });
    }
    return errorResponse('Method not allowed', 405);
  }
};
