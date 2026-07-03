// ============================================================
// index.js — Main Router ของ Cloudflare Worker (srdhpay-api)
// ทุก Request เข้ามาที่นี่จุดเดียว แล้วกระจายไปตาม path prefix
//
// *** หมายเหตุสำคัญตอน Deploy ***
// ต้องไปตั้งค่า D1 Binding ชื่อ "DB" ที่หน้า Worker > Settings > Bindings
// ให้ผูกกับฐานข้อมูล UUID 26443676-5af5-4dfe-ad5a-f97ce7862fa4
// ไม่เช่นนั้น env.DB จะเป็น undefined และทุก API จะ error
// ============================================================

import { corsPreflight, fail } from 'lib/response.js';
import { handleAuthRoutes } from './routes/auth.js';
import { handleRegisterRoutes } from './routes/register.js';
import { handleReceiveRoutes } from './routes/receive.js';
import { handleVerifyRoutes } from './routes/verify.js';
import { handleApproveRoutes } from './routes/approve.js';
import { handlePaymentRoutes } from './routes/payment.js';
import { handleCancelRoutes } from './routes/cancel.js';
import { handleDashboardRoutes } from './routes/dashboard.js';
import { handleReportRoutes } from './routes/report.js';
import { handleSettingsRoutes } from './routes/settings.js';
import { handleSystemRoutes } from './routes/system.js';

export default {
  async fetch(request, env, ctx) {
    // ตอบ CORS Preflight ก่อนเสมอ
    if (request.method === 'OPTIONS') {
      return corsPreflight();
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // ----------------------------------------------------
      // จุดต่อ Route ของแต่ละโมดูล (จะเปิดใช้ทีละ Part)
      // ----------------------------------------------------

      // Part 2: Auth Module (เปิดใช้งานแล้ว)
      if (path.startsWith('/api/auth/')) {
        return await handleAuthRoutes(request, env, path);
      }

      // Part 4: Cancel/Restore ต้องตรวจก่อน Register เพราะ path ขึ้นต้นด้วย /api/register/ เหมือนกัน
      if (path === '/api/register/cancel' || path === '/api/register/restore') {
        return await handleCancelRoutes(request, env, path);
      }

      // Part 3: Receive Module ต้องตรวจก่อน Register เพราะ path ขึ้นต้นด้วย /api/register/ เหมือนกัน
      if (path.startsWith('/api/register/receive')) {
        return await handleReceiveRoutes(request, env, path);
      }

      // Part 3: Register Module (Import + List + Detail)
      if (path.startsWith('/api/register/')) {
        return await handleRegisterRoutes(request, env, path);
      }

      // Part 4: Verify Module (แก้ไข/รับคืน/ตรวจผ่าน)
      if (path.startsWith('/api/verify/')) {
        return await handleVerifyRoutes(request, env, path);
      }

      // Part 4: Approve Module (เสนอ/อนุมัติ)
      if (path.startsWith('/api/approve/')) {
        return await handleApproveRoutes(request, env, path);
      }

      // Part 4: Payment Module (จ่ายเช็ค)
      if (path.startsWith('/api/payment/')) {
        return await handlePaymentRoutes(request, env, path);
      }

      // Part 5: Dashboard Module
      if (path.startsWith('/api/dashboard/')) {
        return await handleDashboardRoutes(request, env, path);
      }

      // Part 5: Report Module
      if (path.startsWith('/api/report/')) {
        return await handleReportRoutes(request, env, path);
      }

      // Part 5: Settings Module
      if (path.startsWith('/api/settings/')) {
        return await handleSettingsRoutes(request, env, path);
      }

      // Part 5: System Module
      if (path.startsWith('/api/system/')) {
        return await handleSystemRoutes(request, env, path);
      }

      // Health check เบื้องต้น สำหรับทดสอบว่า Worker ทำงาน
      if (path === '/api/health') {
        return new Response(JSON.stringify({ success: true, message: 'SRDH Pay API is running' }), {
          headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
      }

      return fail('ไม่พบ Endpoint นี้', 404);
    } catch (err) {
      console.error('Unhandled error:', err);
      return fail('เกิดข้อผิดพลาดในระบบ: ' + err.message, 500);
    }
  }
};
