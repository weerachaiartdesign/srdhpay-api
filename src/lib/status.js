// ============================================================
// status.js — Mapping สถานะภาษาไทย + คำนวณสถานะจาก field วันที่ (ข้อ 6.4, 6.6)
// หมายเหตุ: ไม่ได้เก็บ status_display เป็นคอลัมน์ในตาราง (ตามที่ตกลงไว้)
//           แปลงเป็นภาษาไทยตอน Response กลับไปยัง Frontend เท่านั้น
// ============================================================

export const STATUS_MAP = {
  WAITING:   'รอเอกสาร',
  RECEIVED:  'รับเข้าระบบ',
  CHECKUP:   'ตรวจสอบ',
  EDITING:   'ส่งแก้ไข',
  PASSED:    'ตรวจผ่าน',
  PROPOSED:  'เสนอ',
  APPROVED:  'อนุมัติ',
  PAID:      'จ่ายแล้ว',
  CANCELLED: 'ยกเลิก'
};

export function statusDisplay(status) {
  return STATUS_MAP[status] || status || '-';
}

// แปลงทุก row ในผลลัพธ์ query ให้มี field status_display แถมไปด้วย (ใช้ตอนตอบ response)
export function withStatusDisplay(row) {
  if (!row) return row;
  return { ...row, status_display: statusDisplay(row.status) };
}
export function withStatusDisplayList(rows) {
  return (rows || []).map(withStatusDisplay);
}

// คำนวณสถานะ "ที่ควรจะเป็น" จาก field วันที่ทั้งหมด ตามลำดับความสำคัญในข้อ 6.4
// ใช้เป็น safety-net ตรวจสอบความสอดคล้อง และใช้คำนวณสถานะก่อนยกเลิกตอนกู้คืน
export function computeStatusFromFields(row) {
  if (row.cancel_date) return 'CANCELLED';
  if (row.pay_date) return 'PAID';
  if (row.approve_date) return 'APPROVED';
  if (row.propose_date) return 'PROPOSED';
  if (row.pass_date) return 'PASSED';
  if (row.edit_date && (!row.return_date || new Date(row.return_date) < new Date(row.edit_date))) return 'EDITING';
  if (row.editor) return 'CHECKUP';
  if (row.receive_date) return 'RECEIVED';
  if (row.register_date) return 'WAITING';
  return 'WAITING';
}

// คำนวณสถานะก่อนยกเลิก (ไม่นับ cancel_date) — ใช้ตอนกู้คืนรายการที่ถูกยกเลิก
export function computeStatusBeforeCancel(row) {
  return computeStatusFromFields({ ...row, cancel_date: null });
}
