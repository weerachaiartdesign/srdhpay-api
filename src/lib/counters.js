// ============================================================
// counters.js — Fiscal Running Engine
// จัดการเลขที่ลงทะเบียน (REGISTER_NO), เลขที่รับ (RECEIVE_NO),
// และแปลงรูปแบบเลขที่ใบขอเบิก (REQUEST_NO) / เลขที่ฎีกา (DK_NO)
// ============================================================

import { fiscalYearShort } from './datetime.js';

// ------------------------------------------------------------
// จองช่วงเลข running แบบ atomic (lock-safe) คืนค่า "เลขเริ่มต้น" ของช่วงที่จองได้
// เช่น เดิม current_value = 5, จอง count=3 -> จะได้ current_value ใหม่ = 8 และคืนค่า start = 6 (เลขที่ใช้ได้คือ 6,7,8)
// ใช้กับ:
//   - register: count = 1 เสมอ (1 batch = SEQ4 เพิ่มที่ละ 1 ไม่ว่า batch จะมีกี่รายการ)
//   - receive : count = จำนวนรายการที่เลือกรับเข้าระบบในครั้งนี้ (ออกเลขต่อรายการ)
// ------------------------------------------------------------
export async function reserveCounterRange(db, keyName, fiscalYearFull, count = 1) {
  // สร้างแถวตั้งต้นถ้ายังไม่มี (ปีงบใหม่ -> key ใหม่ -> เริ่มจาก 0 โดยอัตโนมัติ = reset ปีงบ)
  await db.prepare(
    `INSERT INTO counters (key_name, current_value, fiscal_year) VALUES (?, 0, ?)
     ON CONFLICT(key_name) DO NOTHING`
  ).bind(keyName, fiscalYearFull).run();

  const result = await db.prepare(
    `UPDATE counters
     SET current_value = current_value + ?, updated_at = CURRENT_TIMESTAMP
     WHERE key_name = ?
     RETURNING current_value`
  ).bind(count, keyName).run();

  const newValue = result.results[0].current_value;
  return newValue - count + 1; // จุดเริ่มต้นของช่วง
}

// คีย์ของ counters ตามปีงบ เช่น register_2569 / receive_2569
export function registerCounterKey(fiscalYearFull) {
  return `register_${fiscalYearFull}`;
}
export function receiveCounterKey(fiscalYearFull) {
  return `receive_${fiscalYearFull}`;
}

// ------------------------------------------------------------
// REGISTER_NO : RG + FY2 + COUNT3 + SEQ4  (เช่น RG690150001)
// countInBatch = จำนวนรายการที่บันทึกจริงใน batch นี้ (นับรวม create+update)
// seq = ลำดับ batch ที่จองได้จาก reserveCounterRange (count=1)
// ------------------------------------------------------------
export function buildRegisterNo(fiscalYearFull, countInBatch, seq) {
  const fy2 = fiscalYearShort(fiscalYearFull);
  const count3 = String(countInBatch).padStart(3, '0');
  const seq4 = String(seq).padStart(4, '0');
  return {
    raw: `${fy2}${count3}${seq4}`,        // 690150001
    display: `RG${fy2}${count3}${seq4}`   // RG690150001
  };
}

// ------------------------------------------------------------
// RECEIVE_NO : ID + FY2 - SEQ4 (แสดงผล) / FY2+SEQ4 (เก็บ)  เช่น ID69-0001 / 690001
// seq = เลขลำดับเฉพาะรายการนี้ (ได้จาก reserveCounterRange แบบจองเป็นช่วง)
// ------------------------------------------------------------
export function buildReceiveNo(fiscalYearFull, seq) {
  const fy2 = fiscalYearShort(fiscalYearFull);
  const seq4 = String(seq).padStart(4, '0');
  return {
    raw: `${fy2}${seq4}`,        // 690001
    display: `ID${fy2}-${seq4}`  // ID69-0001
  };
}

// ------------------------------------------------------------
// REQUEST_NO : เก็บ 9 หลัก (FY2 + SEQ7) / แสดงผล "ลำดับ/FY2" เช่น 1/69 <-> 690000001
// ------------------------------------------------------------
export function parseRequestNoDisplay(display) {
  const str = String(display || '').trim();
  if (!str.includes('/')) throw new Error(`รูปแบบเลขที่ใบขอเบิกไม่ถูกต้อง: "${str}" (ต้องมี / เช่น 1/69)`);
  const [seqPart, fyPart] = str.split('/');
  const seq = parseInt(seqPart, 10);
  const fy = (fyPart || '').trim();
  if (isNaN(seq) || !fy) throw new Error(`รูปแบบเลขที่ใบขอเบิกไม่ถูกต้อง: "${str}"`);
  const seq7 = String(seq).padStart(7, '0');
  return `${fy}${seq7}`;
}
export function formatRequestNoDisplay(raw) {
  const fy = String(raw).slice(0, 2);
  const seq = parseInt(String(raw).slice(2), 10);
  return `${seq}/${fy}`;
}

export function parseDkNoDisplay(display) {
  const str = String(display || '').trim();
  if (!str.includes('/')) throw new Error(`รูปแบบเลขที่ฎีกาไม่ถูกต้อง: "${str}" (ต้องมี / เช่น 1801/69)`);
  const [seqPart, fyPart] = str.split('/');
  const seq = parseInt(seqPart, 10);
  const fy = (fyPart || '').trim();
  if (isNaN(seq) || !fy) throw new Error(`รูปแบบเลขที่ฎีกาไม่ถูกต้อง: "${str}"`);
  const seq7 = String(seq).padStart(7, '0');
  return `${fy}${seq7}`;
}
export function formatDkNoDisplay(raw) {
  const fy = String(raw).slice(0, 2);
  const seq = parseInt(String(raw).slice(2), 10);
  return `${seq}/${fy}`;
}
