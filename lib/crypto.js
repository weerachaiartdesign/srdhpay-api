// ============================================================
// crypto.js — Hash รหัสผ่าน, สร้าง Session Token, สร้าง Guest ID
// ใช้ Web Crypto API ที่มีอยู่ใน Cloudflare Workers อยู่แล้ว (ไม่ต้องลง library เพิ่ม)
// ============================================================

// แฮชข้อความด้วย SHA-256 แล้วคืนค่าเป็น hex string (ตรงรูปแบบที่ใช้เก็บใน auth.password)
export async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hashBuffer)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// สร้าง Session Token แบบสุ่ม ไม่ซ้ำ (ใช้ใน table sessions.token)
export function generateToken() {
  return (
    crypto.randomUUID().replace(/-/g, '') +
    crypto.randomUUID().replace(/-/g, '')
  );
}

// สร้าง Guest ID รูปแบบ G-8F2A91 ตามข้อ 5.1.2
export function generateGuestId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return `G-${code}`;
}
