// ============================================================
// datetime.js — แปลงวันที่ภาษาไทย และคำนวณปีงบประมาณ
// ============================================================

const THAI_MONTHS_SHORT = [
  'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
  'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'
];

// คืนค่าวันเวลาปัจจุบันรูปแบบ "YYYY-MM-DD HH:MM:SS" สำหรับเก็บใน D1 (DATETIME)
export function nowForDb() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

// คืนค่าวันที่ปัจจุบันรูปแบบ "YYYY-MM-DD" เท่านั้น
export function todayForDb() {
  return new Date().toISOString().slice(0, 10);
}

// แปลงวันที่เป็นข้อความภาษาไทยแบบแสดงผลหน้าเว็บ เช่น "1 ต.ค. 2568"
export function toThaiDisplayDate(dateStr) {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '-';
  const buddhistYear = d.getFullYear() + 543;
  return `${d.getDate()} ${THAI_MONTHS_SHORT[d.getMonth()]} ${buddhistYear}`;
}

// คำนวณปีงบประมาณ (พ.ศ.) จาก Date object — ปีงบเริ่ม 1 ต.ค.
// เช่น 15 มิ.ย. 2569 (ค.ศ.2026) -> อยู่ในปีงบ 2569 (เพราะ มิ.ย. < ต.ค.)
//      15 พ.ย. 2568 (ค.ศ.2025) -> อยู่ในปีงบ 2569 (เพราะ พ.ย. >= ต.ค. นับเป็นปีงบถัดไป)
export function getFiscalYear(dateObj = new Date()) {
  const buddhistYear = dateObj.getFullYear() + 543;
  const month = dateObj.getMonth() + 1; // 1-12
  return month >= 10 ? buddhistYear + 1 : buddhistYear;
}

// ตัดปีงบประมาณเหลือ 2 หลักท้าย เช่น 2569 -> "69"
export function fiscalYearShort(fiscalYearFull) {
  return String(fiscalYearFull).slice(-2);
}

// คืนค่าช่วงวันที่ของปีงบประมาณ { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' } (ปี ค.ศ. สำหรับ query DB)
export function getFiscalYearRange(fiscalYearFull) {
  const startBuddhist = fiscalYearFull - 1; // ปีงบ 2569 เริ่ม 1 ต.ค. 2568
  const startCE = startBuddhist - 543;
  const endCE = fiscalYearFull - 543;
  return {
    start: `${startCE}-10-01`,
    end: `${endCE}-09-30`
  };
}
