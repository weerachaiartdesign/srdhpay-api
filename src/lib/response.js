// ============================================================
// response.js — Helper สำหรับสร้าง HTTP Response มาตรฐานของ API
// ============================================================

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS
    }
  });
}

// ใช้ตอนสำเร็จ: ok({ data: [...] }) หรือ ok({ message: '...' })
export function ok(payload = {}) {
  return json({ success: true, ...payload }, 200);
}

// ใช้ตอนผิดพลาด: fail('ข้อความ', 400)
export function fail(message, status = 400, extra = {}) {
  return json({ success: false, message, ...extra }, status);
}

// ตอบกลับ Preflight Request (OPTIONS) ของ CORS
export function corsPreflight() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

// อ่าน JSON body แบบปลอดภัย (กัน error ถ้า body ไม่ใช่ JSON)
export async function readJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}
