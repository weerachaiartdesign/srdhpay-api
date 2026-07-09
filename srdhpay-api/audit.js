// audit.js - ดึง Audit Logs

import { validateToken, hasPermission, jsonResponse, errorResponse, successResponse } from './helper.js';

export const handleAudit = {
  async list(request, env) {
    try {
      const user = await validateToken(request, env);
      // Only admin can view audit logs fully
      if (user.role !== 'admin') {
        return errorResponse('Permission denied', 403);
      }

      const url = new URL(request.url);
      const page = parseInt(url.searchParams.get('page')) || 1;
      const limit = parseInt(url.searchParams.get('limit')) || 50;
      const offset = (page - 1) * limit;
      const module = url.searchParams.get('module') || '';
      const action = url.searchParams.get('action') || '';

      let query = `SELECT * FROM audit_logs WHERE 1=1`;
      const params = [];

      if (module) {
        query += ` AND module = ?`;
        params.push(module);
      }
      if (action) {
        query += ` AND action = ?`;
        params.push(action);
      }

      query += ` ORDER BY time DESC LIMIT ? OFFSET ?`;
      params.push(limit, offset);

      const stmt = await env.DB.prepare(query);
      const rows = await stmt.bind(...params).all();

      // Count total
      let countQuery = `SELECT COUNT(*) as total FROM audit_logs WHERE 1=1`;
      const countParams = [];
      if (module) { countQuery += ` AND module = ?`; countParams.push(module); }
      if (action) { countQuery += ` AND action = ?`; countParams.push(action); }
      const countStmt = await env.DB.prepare(countQuery);
      const countResult = await countStmt.bind(...countParams).first();

      return successResponse({
        data: rows.results || [],
        pagination: {
          page,
          limit,
          total: countResult ? countResult.total : 0,
        },
      });
    } catch (err) {
      return errorResponse(err.message, 401);
    }
  }
};