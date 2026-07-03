// ============================================================
// routes/dashboard.js — ภาพรวมการเบิกจ่ายเงิน (5.2)
// ขอบเขต: เฉพาะรายการในปีงบประมาณปัจจุบัน (อ้างจาก register_date)
// ============================================================

import { ok, fail } from '../lib/response.js';
import { requireAuth, requirePermission } from '../lib/auth-middleware.js';
import { getFiscalYear } from '../lib/datetime.js';

async function getAppSetting(env, key, def) {
  const row = await env.DB.prepare(`SELECT value FROM settings_app WHERE key = ?`).bind(key).first();
  return row?.value ?? def;
}

// นับจำนวนรายการที่ถือว่า "ทั้งหมด" บน dashboard (ไม่รวม WAITING, CANCELLED ตามข้อ 5.2.1)
const COUNTED_STATUSES = ['RECEIVED', 'CHECKUP', 'EDITING', 'PASSED', 'PROPOSED', 'APPROVED', 'PAID'];
const DONE_STATUSES = ['APPROVED', 'PAID'];

// จัดกลุ่ม top-N ตาม key แล้วรวมส่วนเกินเป็น "อื่น"
function groupTopN(items, keyFn, topN, otherLabel) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  // เรียงตามยอดรวม amount มากไปน้อย เพื่อเลือก top-N
  const sortedKeys = [...map.keys()].sort(
    (a, b) => map.get(b).reduce((s, i) => s + i.amount, 0) - map.get(a).reduce((s, i) => s + i.amount, 0)
  );
  const topKeys = sortedKeys.slice(0, topN);
  const otherKeys = sortedKeys.slice(topN);

  const result = topKeys.map((k) => ({ label: k, items: map.get(k) }));
  if (otherKeys.length > 0) {
    const otherItems = otherKeys.flatMap((k) => map.get(k));
    result.push({ label: otherLabel, items: otherItems });
  }
  return result;
}

async function handleSummary(request, env) {
  const { user, error } = await requireAuth(request, env);
  if (error) return error;
  const permError = await requirePermission(env, user, 'dashboard');
  if (permError) return permError;

  const fiscalYear = getFiscalYear();
  const fyStart = await getAppSetting(env, 'fiscal_start_date', null);
  const fyEnd = await getAppSetting(env, 'fiscal_end_date', null);
  const topMoneyType = parseInt(await getAppSetting(env, 'dashboard_top_money_type', '4'), 10);
  const topDept = parseInt(await getAppSetting(env, 'dashboard_top_dept', '5'), 10);
  const topMoney = parseInt(await getAppSetting(env, 'dashboard_top_money', '4'), 10);

  const rows = (await env.DB.prepare(
    `SELECT status, money_type, dept, amount, receive_date, approve_date
     FROM register
     WHERE status != 'CANCELLED' AND register_date BETWEEN ? AND ?`
  ).bind(fyStart, fyEnd).all()).results;

  // ---------- Summary Cards ตาม money_type (top-N) ----------
  const moneyGroups = groupTopN(rows, (r) => r.money_type, topMoneyType, 'เงินอื่น');
  const cards = moneyGroups.map((g) => {
    const doneItems = g.items.filter((r) => DONE_STATUSES.includes(r.status));
    const countedItems = g.items.filter((r) => COUNTED_STATUSES.includes(r.status));
    return {
      money_type: g.label,
      done_count: doneItems.length,
      total_count: countedItems.length,
      done_amount: doneItems.reduce((s, r) => s + r.amount, 0),
      pending_amount: g.items.filter((r) => !DONE_STATUSES.includes(r.status)).reduce((s, r) => s + r.amount, 0),
      requested_amount_total: g.items.reduce((s, r) => s + r.amount, 0)
    };
  });

  // ---------- ระยะเวลาดำเนินการเฉลี่ย (รับเรื่อง - อนุมัติ) เฉพาะ อนุมัติ/จ่ายแล้ว ----------
  const durationItems = rows.filter((r) => DONE_STATUSES.includes(r.status) && r.receive_date && r.approve_date);
  let avgDays = 0;
  if (durationItems.length > 0) {
    const totalDays = durationItems.reduce((sum, r) => {
      const diff = (new Date(r.approve_date) - new Date(r.receive_date)) / (1000 * 60 * 60 * 24);
      return sum + diff;
    }, 0);
    avgDays = Math.floor(totalDays / durationItems.length);
  }

  // ---------- Progress Bar ----------
  const doneCount = rows.filter((r) => DONE_STATUSES.includes(r.status)).length;
  const totalNotCancelled = rows.length; // rows ที่ query มาแล้วคือไม่รวม CANCELLED อยู่แล้ว
  const progressPercent = totalNotCancelled > 0 ? Math.round((doneCount / totalNotCancelled) * 10000) / 100 : 0;

  // ---------- กราฟแท่ง: สถิติตามหน่วยงาน (top-N) ----------
  const deptGroups = groupTopN(rows, (r) => r.dept, topDept, 'หน่วยงานอื่น');
  const deptChart = deptGroups.map((g) => ({
    dept: g.label,
    total_amount: g.items.reduce((s, r) => s + r.amount, 0)
  }));
  const deptLabelsForGrouping = deptGroups.map((g) => g.label);

  // ---------- กราฟแท่ง: สถิติประเภทการเบิกจ่าย (Grouped: หน่วยงาน x ประเภทเงิน) ----------
  const moneyTypeLabelsForGrouping = groupTopN(rows, (r) => r.money_type, topMoney, 'เงินอื่น').map((g) => g.label);

  function reassignToGroup(value, labelList, otherLabel) {
    return labelList.includes(value) ? value : otherLabel;
  }

  const deptMoneyMap = new Map(); // key: dept -> { money_type: amount }
  for (const r of rows) {
    const deptKey = reassignToGroup(r.dept, deptLabelsForGrouping.filter((d) => d !== 'หน่วยงานอื่น'), 'หน่วยงานอื่น');
    const moneyKey = reassignToGroup(r.money_type, moneyTypeLabelsForGrouping.filter((m) => m !== 'เงินอื่น'), 'เงินอื่น');
    if (!deptMoneyMap.has(deptKey)) deptMoneyMap.set(deptKey, {});
    const bucket = deptMoneyMap.get(deptKey);
    bucket[moneyKey] = (bucket[moneyKey] || 0) + r.amount;
  }
  const deptMoneyChart = {
    depts: [...deptMoneyMap.keys()],
    money_types: moneyTypeLabelsForGrouping,
    series: moneyTypeLabelsForGrouping.map((mt) => ({
      money_type: mt,
      values: [...deptMoneyMap.keys()].map((d) => deptMoneyMap.get(d)[mt] || 0)
    }))
  };

  // ---------- กราฟแท่ง: จำนวนฎีกาแต่ละเดือน เทียบ 2 ปีงบ (ต.ค.-ก.ย.) ----------
  const monthlyChart = await buildMonthlyChart(env, fiscalYear);

  return ok({
    fiscal_year: fiscalYear,
    cards,
    avg_duration_days: avgDays,
    progress_percent: progressPercent,
    dept_chart: deptChart,
    dept_money_chart: deptMoneyChart,
    monthly_chart: monthlyChart
  });
}

// เดือน ต.ค.-ก.ย. ของปีงบ ปัจจุบัน vs ปีก่อน นับจาก receive_date และ approve_date
async function buildMonthlyChart(env, fiscalYear) {
  const months = ['ต.ค.', 'พ.ย.', 'ธ.ค.', 'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.'];

  async function countByMonth(dateColumn, fy) {
    // ปีงบ fy เริ่ม 1 ต.ค. (fy-1) ค.ศ. = fy - 1 - 543, สิ้นสุด 30 ก.ย. fy ค.ศ. = fy - 543
    const startCE = fy - 1 - 543;
    const endCE = fy - 543;
    const startDate = `${startCE}-10-01`;
    const endDate = `${endCE}-09-30`;

    const rows = (await env.DB.prepare(
      `SELECT ${dateColumn} as d FROM register WHERE ${dateColumn} BETWEEN ? AND ? AND status != 'CANCELLED'`
    ).bind(startDate, endDate).all()).results;

    const counts = new Array(12).fill(0);
    for (const r of rows) {
      const m = new Date(r.d).getMonth() + 1; // 1-12
      const idx = m >= 10 ? m - 10 : m + 2; // ต.ค.=0 ... ก.ย.=11
      counts[idx]++;
    }
    return counts;
  }

  return {
    labels: months,
    current_year: fiscalYear,
    previous_year: fiscalYear - 1,
    received_current: await countByMonth('receive_date', fiscalYear),
    received_previous: await countByMonth('receive_date', fiscalYear - 1),
    approved_current: await countByMonth('approve_date', fiscalYear),
    approved_previous: await countByMonth('approve_date', fiscalYear - 1)
  };
}

export async function handleDashboardRoutes(request, env, path) {
  if (path === '/api/dashboard/summary' && request.method === 'GET') {
    return handleSummary(request, env);
  }
  return fail('ไม่พบ Endpoint นี้ใน Dashboard Module', 404);
}
