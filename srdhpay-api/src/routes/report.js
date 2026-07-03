// ============================================================
// routes/report.js — รายงาน (5.9)
// 1) รายงานการเบิกจ่าย แยกตามประเภทเงิน (report_type.html)
// 2) รายงานสถานะฎีกา ตามช่วงวันที่ (report_status.html)
// ============================================================

import { ok, fail } from '../lib/response.js';
import { requireAuth, requirePermission } from '../lib/auth-middleware.js';

// ------------------------------------------------------------
// GET /api/report/by-type   (5.9.1)
// แยกตารางตาม money_type ทุกประเภท, คอลัมน์เป็นรายหน่วยงาน
// ------------------------------------------------------------
async function handleByType(request, env) {
  const { user, error } = await requireAuth(request, env);
  if (error) return error;
  const permError = await requirePermission(env, user, 'report');
  if (permError) return permError;

  const moneyTypes = (await env.DB.prepare(
    `SELECT name FROM settings_money_type WHERE active = 1 ORDER BY sort_order`
  ).all()).results.map((r) => r.name);

  const rows = (await env.DB.prepare(
    `SELECT money_type, dept, status, amount FROM register WHERE status NOT IN ('CANCELLED', 'WAITING')`
  ).all()).results;

  const report = moneyTypes.map((mt) => {
    const items = rows.filter((r) => r.money_type === mt);
    const deptMap = new Map();
    for (const r of items) {
      if (!deptMap.has(r.dept)) {
        deptMap.set(r.dept, { dept: r.dept, received_count: 0, paid_count: 0, remaining_count: 0, requested_amount: 0, paid_amount: 0, remaining_amount: 0 });
      }
      const bucket = deptMap.get(r.dept);
      bucket.received_count += 1; // ทุกแถวในที่นี้ผ่านสถานะ "รับเข้าระบบ" มาแล้ว (ไม่รวม WAITING/CANCELLED)
      bucket.requested_amount += r.amount;
      if (r.status === 'PAID') {
        bucket.paid_count += 1;
        bucket.paid_amount += r.amount;
      } else {
        bucket.remaining_count += 1;
        bucket.remaining_amount += r.amount;
      }
    }
    return { money_type: mt, depts: [...deptMap.values()] };
  });

  return ok({ data: report, generated_at: new Date().toISOString() });
}

// ------------------------------------------------------------
// GET /api/report/status?action=received|editing|proposed&start_date=&end_date=  (5.9.2-5.9.5)
// กรองตามช่วงวันที่ของ field ที่สัมพันธ์กับสถานะนั้น
// ------------------------------------------------------------
async function handleStatusReport(request, env) {
  const { user, error } = await requireAuth(request, env);
  if (error) return error;
  const permError = await requirePermission(env, user, 'report');
  if (permError) return permError;

  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  const startDate = url.searchParams.get('start_date');
  const endDate = url.searchParams.get('end_date');

  const config = {
    received: { status: 'RECEIVED', dateCol: 'receive_date' },
    editing: { status: 'EDITING', dateCol: 'edit_date' },
    proposed: { status: 'PROPOSED', dateCol: 'propose_date' }
  };
  const cfg = config[action];
  if (!cfg) return fail('action ไม่ถูกต้อง (ต้องเป็น received, editing หรือ proposed)', 400);
  if (!startDate || !endDate) return fail('กรุณาเลือกช่วงวันที่', 400);

  const rows = (await env.DB.prepare(
    `SELECT receive_date, request_no_display, dk_no_display, vendor, description, amount, dept, sender
     FROM register
     WHERE status = ? AND ${cfg.dateCol} BETWEEN ? AND ?
     ORDER BY receive_date ASC`
  ).bind(cfg.status, startDate, endDate).all()).results;

  return ok({ data: rows });
}

export async function handleReportRoutes(request, env, path) {
  if (path === '/api/report/by-type' && request.method === 'GET') return handleByType(request, env);
  if (path === '/api/report/status' && request.method === 'GET') return handleStatusReport(request, env);
  return fail('ไม่พบ Endpoint นี้ใน Report Module', 404);
}
