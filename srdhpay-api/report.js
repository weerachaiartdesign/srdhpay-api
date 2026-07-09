// report.js - รายงานสรุปและสถานะ

import { validateToken, hasPermission, jsonResponse, errorResponse, successResponse } from './helper.js';

export const handleReport = {
  // 5.9.1 รายงานการเบิกจ่าย (Summary)
  async summary(request, env) {
    try {
      const user = await validateToken(request, env);
      const canAccess = await hasPermission(env, 'report', user.role);
      if (!canAccess) return errorResponse('Permission denied', 403);

      const url = new URL(request.url);
      const moneyType = url.searchParams.get('money_type') || '';

      // Build query
      let query = `
        SELECT 
          r.dept,
          r.money_type,
          COUNT(*) as total_count,
          SUM(r.amount) as total_amount,
          SUM(CASE WHEN r.status = 'PAID' THEN r.amount ELSE 0 END) as paid_amount,
          SUM(CASE WHEN r.status != 'PAID' AND r.status != 'CANCELLED' THEN r.amount ELSE 0 END) as remaining_amount,
          COUNT(CASE WHEN r.status != 'CANCELLED' AND r.status != 'PAID' THEN 1 END) as remaining_count
        FROM register r
        WHERE (r.cancel_status IS NULL OR r.cancel_status = 0)
      `;

      const params = [];
      if (moneyType) {
        query += ` AND r.money_type = ?`;
        params.push(moneyType);
      }

      query += ` GROUP BY r.dept, r.money_type ORDER BY r.dept, r.money_type`;

      const stmt = await env.DB.prepare(query);
      const rows = await stmt.bind(...params).all();

      // Get list of money types
      const moneyStmt = await env.DB.prepare(`SELECT name FROM settings_money_type WHERE active = 1 ORDER BY sort_order`);
      const moneyRows = await moneyStmt.all();
      const moneyTypes = moneyRows.results.map(r => r.name);

      // Get list of depts
      const deptStmt = await env.DB.prepare(`SELECT name FROM settings_dept WHERE active = 1 ORDER BY sort_order`);
      const deptRows = await deptStmt.all();
      const depts = deptRows.results.map(r => r.name);

      // Transform to matrix
      const matrix = {};
      for (const d of depts) {
        matrix[d] = {};
        for (const m of moneyTypes) {
          matrix[d][m] = {
            total_count: 0,
            total_amount: 0,
            paid_amount: 0,
            remaining_amount: 0,
            remaining_count: 0,
          };
        }
      }

      for (const row of rows.results) {
        if (matrix[row.dept] && matrix[row.dept][row.money_type]) {
          matrix[row.dept][row.money_type] = {
            total_count: row.total_count,
            total_amount: row.total_amount,
            paid_amount: row.paid_amount,
            remaining_amount: row.remaining_amount,
            remaining_count: row.remaining_count,
          };
        }
      }

      return successResponse({
        depts,
        moneyTypes,
        matrix,
        summary: rows.results,
      });
    } catch (err) {
      return errorResponse(err.message, 401);
    }
  },

  // 5.9.2 รายงานสถานะฎีกา
  async status(request, env) {
    try {
      const user = await validateToken(request, env);
      const canAccess = await hasPermission(env, 'report', user.role);
      if (!canAccess) return errorResponse('Permission denied', 403);

      const url = new URL(request.url);
      const status = url.searchParams.get('status') || '';
      const dateFrom = url.searchParams.get('date_from') || '';
      const dateTo = url.searchParams.get('date_to') || '';

      let query = `
        SELECT 
          r.receive_date, r.request_no_display, r.dk_no_display, 
          r.vendor, r.description, r.amount, r.dept, r.sender,
          r.status, r.receive_no_display, r.register_no_display
        FROM register r
        WHERE (r.cancel_status IS NULL OR r.cancel_status = 0)
      `;
      const params = [];

      if (status) {
        query += ` AND r.status = ?`;
        params.push(status);
      }
      if (dateFrom) {
        query += ` AND r.receive_date >= ?`;
        params.push(dateFrom);
      }
      if (dateTo) {
        query += ` AND r.receive_date <= ?`;
        params.push(dateTo + ' 23:59:59');
      }

      query += ` ORDER BY r.receive_date DESC, r.receive_no_raw DESC`;

      const stmt = await env.DB.prepare(query);
      const rows = await stmt.bind(...params).all();

      return successResponse(rows.results || []);
    } catch (err) {
      return errorResponse(err.message, 401);
    }
  }
};