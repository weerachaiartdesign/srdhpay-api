// register.js - ใช้ env.DB.batch แทน transaction (รองรับ D1)

import {
  validateToken,
  hasPermission,
  logAction,
  auditLog,
  sendTelegram,
  jsonResponse,
  errorResponse,
  successResponse,
  getFiscalYearShort,
  toISODate,
} from './helper.js';
import { getNextRegisterNumber, getNextReceiveNumbers } from './running.js';

export const handleRegister = {
  // ---- list (ไม่ต้องแก้) ----
  async list(request, env) {
    try {
      const user = await validateToken(request, env);
      const url = new URL(request.url);
      const page = parseInt(url.searchParams.get('page')) || 1;
      const limit = parseInt(url.searchParams.get('limit')) || 50;
      const offset = (page - 1) * limit;
      const money_type = url.searchParams.get('money_type') || '';
      const dept = url.searchParams.get('dept') || '';
      const status = url.searchParams.get('status') || '';
      const search = url.searchParams.get('search') || '';
      const sort = url.searchParams.get('sort') || 'desc';

      let params = [];
      let conditions = [];
      let query = `
        SELECT r.*,
               CASE
                 WHEN r.cancel_date IS NOT NULL AND r.cancel_status = 1 THEN 'CANCELLED'
                 ELSE r.status
               END AS computed_status
        FROM register r
        WHERE (r.cancel_status IS NULL OR r.cancel_status = 0 OR r.cancel_status != 1)
      `;
      conditions.push(`r.status != 'WAITING'`);

      if (money_type) { conditions.push(`r.money_type = ?`); params.push(money_type); }
      if (dept) { conditions.push(`r.dept = ?`); params.push(dept); }
      if (status) { conditions.push(`r.status = ?`); params.push(status); }
      if (search) {
        conditions.push(`(
          r.vendor LIKE ? OR r.description LIKE ? OR r.receive_no_display LIKE ? OR
          r.request_no_display LIKE ? OR r.dk_no_display LIKE ? OR r.invoice LIKE ? OR r.egp_no LIKE ?
        )`);
        const s = `%${search}%`;
        params.push(s, s, s, s, s, s, s);
      }

      if (conditions.length) query += ' AND ' + conditions.join(' AND ');
      const order = sort === 'asc' ? 'ASC' : 'DESC';
      query += ` ORDER BY r.receive_date ${order}, r.receive_no_raw ${order} LIMIT ? OFFSET ?`;
      params.push(limit, offset);

      const stmt = await env.DB.prepare(query);
      const rows = await stmt.bind(...params).all();

      // count
      let countQuery = `
        SELECT COUNT(*) as total FROM register r
        WHERE (r.cancel_status IS NULL OR r.cancel_status = 0 OR r.cancel_status != 1)
        AND r.status != 'WAITING'
      `;
      let countParams = [];
      const conds = conditions.filter(c => c !== `r.status != 'WAITING'`);
      if (conds.length) {
        countQuery += ' AND ' + conds.join(' AND ');
        const cp = [];
        if (money_type) cp.push(money_type);
        if (dept) cp.push(dept);
        if (status) cp.push(status);
        if (search) {
          const s = `%${search}%`;
          cp.push(s, s, s, s, s, s, s);
        }
        countParams = cp;
      }
      const countStmt = await env.DB.prepare(countQuery);
      const countResult = await countStmt.bind(...countParams).first();

      return successResponse({
        data: rows.results || [],
        pagination: { page, limit, total: countResult ? countResult.total : 0 },
      });
    } catch (err) {
      return errorResponse(err.message, 401);
    }
  },

  // ---- import (ใช้ batch) ----
  async import(request, env) {
    try {
      const user = await validateToken(request, env);
      if (user.role === 'guest') return errorResponse('Permission denied', 403);
      const canImport = await hasPermission(env, 'import', user.role);
      if (!canImport) return errorResponse('Permission denied', 403);

      const body = await request.json();
      const { items } = body;
      if (!items || !Array.isArray(items) || items.length === 0) {
        return errorResponse('No items to import');
      }

      const limitKey = user.role === 'staff' ? 'import_limit_staff' : 'import_limit_admin';
      const limitRow = await env.DB.prepare(`SELECT value FROM settings_app WHERE key = ?`).bind(limitKey).first();
      const maxLimit = limitRow ? parseInt(limitRow.value) : (user.role === 'staff' ? 20 : 100);
      if (items.length > maxLimit) {
        return errorResponse(`Cannot import more than ${maxLimit} items at once`);
      }

      const today = new Date().toISOString();
      const fiscalYear = await getFiscalYearShort(env);
      const dept = user.dept || '';

      // ตรวจสอบและแปลงข้อมูล
      const validItems = [];
      for (const item of items) {
        if (!item.money_type) return errorResponse('Money type is required');
        if (!item.request_no_raw) return errorResponse('Request no is required');
        if (!item.amount || item.amount <= 0) return errorResponse('Amount must be greater than 0');
        if (!item.vendor) return errorResponse('Vendor is required');

        let requestRaw = item.request_no_raw;
        let requestDisplay = item.request_no_display || requestRaw;
        if (requestRaw.includes('/')) {
          const parts = requestRaw.split('/');
          const num = parseInt(parts[0]);
          const year = parseInt(parts[1]);
          const fullYear = year > 50 ? 1900 + year : 2000 + year;
          requestRaw = `${fullYear.toString().slice(-2)}${String(num).padStart(7, '0')}`;
          requestDisplay = `${num}/${year}`;
        }

        let dkRaw = item.dk_no_raw || null;
        let dkDisplay = item.dk_no_display || null;
        if (dkRaw && dkRaw.includes('/')) {
          const parts = dkRaw.split('/');
          const num = parseInt(parts[0]);
          const year = parseInt(parts[1]);
          const fullYear = year > 50 ? 1900 + year : 2000 + year;
          dkRaw = `${fullYear.toString().slice(-2)}${String(num).padStart(7, '0')}`;
          dkDisplay = `${num}/${year}`;
        }

        validItems.push({
          ...item,
          request_no_raw: requestRaw,
          request_no_display: requestDisplay,
          dk_no_raw: dkRaw,
          dk_no_display: dkDisplay,
          dept: item.dept || dept,
          sender: item.sender || user.username,
          register_date: today,
          source: item.source || 'IMPORT',
          status: 'WAITING',
        });
      }

      // 1. จองเลขทะเบียน
      const registerNo = await getNextRegisterNumber(env, validItems.length);

      // 2. เตรียม statements และเก็บข้อมูลสำหรับ audit
      const statements = [];
      const insertedItems = [];
      const auditData = [];

      for (const item of validItems) {
        // ตรวจสอบซ้ำ
        const dupStmt = env.DB.prepare(
          `SELECT uuid, * FROM register WHERE request_no_raw = ? AND money_type = ? AND (cancel_status IS NULL OR cancel_status = 0)`
        );
        const existing = await dupStmt.bind(item.request_no_raw, item.money_type).first();

        let uuid = item.uuid || crypto.randomUUID();

        if (existing) {
          // UPDATE
          uuid = existing.uuid;
          const fields = [];
          const values = [];
          const fieldsToCheck = [
            'money_type', 'dept', 'sender', 'reserve_no', 'reserve_amount',
            'egp_no', 'invoice', 'vendor', 'amount', 'description',
            'request_no_display', 'dk_no_raw', 'dk_no_display'
          ];
          for (const f of fieldsToCheck) {
            if (item[f] !== undefined && item[f] !== null && item[f] !== '') {
              fields.push(`${f} = ?`);
              values.push(item[f]);
            }
          }
          fields.push('updated_at = ?');
          values.push(new Date().toISOString());
          fields.push('updated_by = ?');
          values.push(user.username);
          values.push(uuid);
          const updateStmt = env.DB.prepare(`UPDATE register SET ${fields.join(', ')} WHERE uuid = ?`);
          statements.push(updateStmt.bind(...values));
          insertedItems.push({ ...existing, ...item, uuid });
          auditData.push({ type: 'update', before: existing, after: { ...existing, ...item }, uuid });
        } else {
          // INSERT
          const insertStmt = env.DB.prepare(`
            INSERT INTO register (
              uuid, money_type, dept, sender, reserve_no, reserve_amount,
              egp_no, invoice, vendor, amount, description,
              request_no_raw, request_no_display,
              dk_no_raw, dk_no_display,
              register_no_raw, register_no_display,
              register_date, status, source, created_by, updated_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          const vals = [
            uuid,
            item.money_type,
            item.dept,
            item.sender,
            item.reserve_no || null,
            item.reserve_amount || 0,
            item.egp_no || null,
            item.invoice || null,
            item.vendor,
            item.amount,
            item.description || null,
            item.request_no_raw,
            item.request_no_display || item.request_no_raw,
            item.dk_no_raw,
            item.dk_no_display,
            registerNo.raw,
            registerNo.display,
            today,
            'WAITING',
            item.source || 'IMPORT',
            user.username,
            user.username,
          ];
          statements.push(insertStmt.bind(...vals));
          insertedItems.push({ ...item, uuid });
          auditData.push({ type: 'insert', before: null, after: item, uuid });
        }
      }

      // 3. รัน batch
      const batchResults = await env.DB.batch(statements);

      // 4. ตรวจสอบความสำเร็จ
      const allSuccess = batchResults.every(r => r.success);
      if (!allSuccess) {
        // ข้อผิดพลาด: ต้อง rollback? แต่เราไม่สามารถ rollback ได้ (skip policy)
        // ให้ log error และแจ้งผู้ใช้
        console.error('Batch import failed:', batchResults);
        throw new Error('Batch operation failed');
      }

      // 5. บันทึก audit และ log
      for (const entry of auditData) {
        await auditLog(
          env,
          user.email,
          user.username,
          entry.type === 'insert' ? 'import' : 'update_import',
          entry.uuid,
          null,
          entry.before,
          entry.after,
          entry.type === 'insert' ? 'Imported new item' : 'Updated via re-import',
          'register'
        );
      }

      await logAction(
        env,
        user.email,
        user.username,
        user.role,
        'import',
        '/import',
        `Imported ${insertedItems.length} items (Batch: ${registerNo.display})`,
        null
      );

      // 6. Telegram
      await sendTelegram(
        env,
        `📥 *นำเข้าข้อมูลสำเร็จ*\nผู้ใช้: ${user.username}\nจำนวน: ${insertedItems.length} รายการ\nเลขทะเบียน: ${registerNo.display}\nเวลาที่ทำการ: ${new Date().toLocaleString('th-TH')}`
      );

      return successResponse({
        imported: insertedItems.length,
        register_no: registerNo.display,
        register_no_raw: registerNo.raw,
        items: insertedItems,
      });
    } catch (err) {
      console.error('Import error:', err);
      return errorResponse(`Import failed: ${err.message}`, 500);
    }
  },

  // ---- receive (ใช้ batch) ----
  async receive(request, env) {
    try {
      const user = await validateToken(request, env);
      if (!['admin', 'manager'].includes(user.role)) {
        return errorResponse('Permission denied', 403);
      }

      const body = await request.json();
      const { uuids } = body;
      if (!uuids || !Array.isArray(uuids) || uuids.length === 0) {
        return errorResponse('No items selected');
      }

      const today = new Date().toISOString();

      // ดึงข้อมูล items ที่มีสถานะ WAITING
      const placeholders = uuids.map(() => '?').join(',');
      const fetchStmt = await env.DB.prepare(
        `SELECT * FROM register WHERE uuid IN (${placeholders}) AND status = 'WAITING'`
      );
      const items = await fetchStmt.bind(...uuids).all();

      if (!items.results || items.results.length === 0) {
        return errorResponse('No valid items in WAITING status');
      }

      // จองเลขรับ
      const receiveNumbers = await getNextReceiveNumbers(env, items.results.length);

      // เตรียม statements
      const statements = [];
      const auditEntries = [];

      for (let i = 0; i < items.results.length; i++) {
        const item = items.results[i];
        const num = receiveNumbers[i];
        const stmt = env.DB.prepare(
          `UPDATE register SET 
            receive_no_raw = ?, receive_no_display = ?, 
            receive_date = ?, status = 'RECEIVED', updated_at = ?, updated_by = ?
           WHERE uuid = ?`
        );
        statements.push(stmt.bind(num.raw, num.display, today, today, user.username, item.uuid));
        auditEntries.push({ item, num });
      }

      // รัน batch
      const batchResults = await env.DB.batch(statements);
      const allSuccess = batchResults.every(r => r.success);
      if (!allSuccess) {
        throw new Error('Batch receive failed');
      }

      // Audit
      for (const entry of auditEntries) {
        await auditLog(
          env,
          user.email,
          user.username,
          'receive',
          entry.item.uuid,
          entry.item.id,
          entry.item,
          { ...entry.item, receive_no_raw: entry.num.raw, receive_no_display: entry.num.display, status: 'RECEIVED' },
          'Received items',
          'register'
        );
      }

      await logAction(
        env,
        user.email,
        user.username,
        user.role,
        'receive',
        '/receive',
        `Received ${auditEntries.length} items`,
        null
      );

      await sendTelegram(
        env,
        `📨 *รับเข้าระบบสำเร็จ*\nผู้ใช้: ${user.username}\nจำนวน: ${auditEntries.length} รายการ\nเวลาที่ทำการ: ${new Date().toLocaleString('th-TH')}`
      );

      return successResponse({
        received: auditEntries.length,
        items: items.results.map((item, i) => ({ ...item, ...receiveNumbers[i] })),
      });
    } catch (err) {
      return errorResponse(`Receive failed: ${err.message}`, 500);
    }
  },

  // ---- assignEditor (ใช้ batch) ----
  async assignEditor(request, env) {
    try {
      const user = await validateToken(request, env);
      if (!['admin', 'manager'].includes(user.role)) {
        return errorResponse('Permission denied', 403);
      }

      const body = await request.json();
      const { uuids, editor_email } = body;
      if (!uuids || !Array.isArray(uuids) || uuids.length === 0) {
        return errorResponse('No items selected');
      }
      if (!editor_email) return errorResponse('Editor email is required');

      const editorCheck = await env.DB.prepare(
        `SELECT username FROM auth WHERE email = ? AND role = 'editor' AND active = 1`
      ).bind(editor_email).first();
      if (!editorCheck) return errorResponse('Editor not found or inactive');

      const placeholders = uuids.map(() => '?').join(',');
      const today = new Date().toISOString();

      // อ่านข้อมูลเดิมก่อน
      const fetchStmt = await env.DB.prepare(
        `SELECT * FROM register WHERE uuid IN (${placeholders}) AND status = 'RECEIVED'`
      );
      const rows = await fetchStmt.bind(...uuids).all();
      if (!rows.results || rows.results.length === 0) {
        return errorResponse('No valid items in RECEIVED status');
      }

      const statements = [];
      const auditEntries = [];
      for (const row of rows.results) {
        const stmt = env.DB.prepare(
          `UPDATE register SET editor = ?, status = 'CHECKUP', updated_at = ?, updated_by = ? WHERE uuid = ?`
        );
        statements.push(stmt.bind(editor_email, today, user.username, row.uuid));
        auditEntries.push(row);
      }

      const batchResults = await env.DB.batch(statements);
      const allSuccess = batchResults.every(r => r.success);
      if (!allSuccess) throw new Error('Batch assign editor failed');

      for (const row of auditEntries) {
        await auditLog(
          env,
          user.email,
          user.username,
          'assign_editor',
          row.uuid,
          row.id,
          null,
          { editor: editor_email, status: 'CHECKUP' },
          `Assigned editor: ${editor_email}`,
          'register'
        );
      }

      await sendTelegram(
        env,
        `👤 *กำหนดผู้ตรวจ*\nผู้ใช้: ${user.username}\nผู้ตรวจ: ${editor_email}\nจำนวน: ${auditEntries.length} รายการ`
      );

      return successResponse({ assigned: auditEntries.length, editor: editor_email });
    } catch (err) {
      return errorResponse(`Assign editor failed: ${err.message}`, 500);
    }
  },

  // ---- edit (ส่งแก้ไข) ----
  async edit(request, env) {
    try {
      const user = await validateToken(request, env);
      const body = await request.json();
      const { uuids } = body;
      if (!uuids || !Array.isArray(uuids) || uuids.length === 0) {
        return errorResponse('No items selected');
      }

      const placeholders = uuids.map(() => '?').join(',');
      const today = new Date().toISOString();

      let query = `SELECT * FROM register WHERE uuid IN (${placeholders}) AND status = 'CHECKUP'`;
      if (user.role === 'editor') query += ` AND editor = ?`;
      const stmt = await env.DB.prepare(query);
      const rows = await (user.role === 'editor' ? stmt.bind(user.email, ...uuids) : stmt.bind(...uuids)).all();

      if (!rows.results || rows.results.length === 0) {
        return errorResponse('No valid items in CHECKUP status');
      }

      const statements = [];
      const auditEntries = [];
      for (const row of rows.results) {
        const stmt2 = env.DB.prepare(
          `UPDATE register SET edit_date = ?, status = 'EDITING', updated_at = ?, updated_by = ? WHERE uuid = ?`
        );
        statements.push(stmt2.bind(today, today, user.username, row.uuid));
        auditEntries.push(row);
      }

      const batchResults = await env.DB.batch(statements);
      if (!batchResults.every(r => r.success)) throw new Error('Batch edit failed');

      for (const row of auditEntries) {
        await auditLog(
          env,
          user.email,
          user.username,
          'edit_send',
          row.uuid,
          row.id,
          row,
          { ...row, edit_date: today, status: 'EDITING' },
          'Sent for correction',
          'register'
        );
      }

      await sendTelegram(
        env,
        `✏️ *ส่งแก้ไข*\nผู้ใช้: ${user.username}\nจำนวน: ${auditEntries.length} รายการ`
      );

      return successResponse({ edited: auditEntries.length });
    } catch (err) {
      return errorResponse(`Edit failed: ${err.message}`, 500);
    }
  },

  // ---- return (รับคืน) ----
  async return(request, env) {
    try {
      const user = await validateToken(request, env);
      const body = await request.json();
      const { uuids } = body;
      if (!uuids || !Array.isArray(uuids) || uuids.length === 0) {
        return errorResponse('No items selected');
      }

      const placeholders = uuids.map(() => '?').join(',');
      const today = new Date().toISOString();

      let query = `SELECT * FROM register WHERE uuid IN (${placeholders}) AND status = 'EDITING'`;
      if (user.role === 'editor') query += ` AND editor = ?`;
      const stmt = await env.DB.prepare(query);
      const rows = await (user.role === 'editor' ? stmt.bind(user.email, ...uuids) : stmt.bind(...uuids)).all();

      if (!rows.results || rows.results.length === 0) {
        return errorResponse('No valid items in EDITING status');
      }

      const statements = [];
      const auditEntries = [];
      for (const row of rows.results) {
        const stmt2 = env.DB.prepare(
          `UPDATE register SET return_date = ?, status = 'CHECKUP', updated_at = ?, updated_by = ? WHERE uuid = ?`
        );
        statements.push(stmt2.bind(today, today, user.username, row.uuid));
        auditEntries.push(row);
      }

      const batchResults = await env.DB.batch(statements);
      if (!batchResults.every(r => r.success)) throw new Error('Batch return failed');

      for (const row of auditEntries) {
        await auditLog(
          env,
          user.email,
          user.username,
          'return',
          row.uuid,
          row.id,
          row,
          { ...row, return_date: today, status: 'CHECKUP' },
          'Returned from correction',
          'register'
        );
      }

      await sendTelegram(
        env,
        `↩️ *รับคืน*\nผู้ใช้: ${user.username}\nจำนวน: ${auditEntries.length} รายการ`
      );

      return successResponse({ returned: auditEntries.length });
    } catch (err) {
      return errorResponse(`Return failed: ${err.message}`, 500);
    }
  },

  // ---- pass (ตรวจผ่าน) ----
  async pass(request, env) {
    try {
      const user = await validateToken(request, env);
      const body = await request.json();
      const { uuids, dk_nos } = body;
      if (!uuids || !Array.isArray(uuids) || uuids.length === 0) {
        return errorResponse('No items selected');
      }

      const dkMap = {};
      if (dk_nos) {
        for (const d of dk_nos) dkMap[d.uuid] = d;
      }

      const placeholders = uuids.map(() => '?').join(',');
      const today = new Date().toISOString();

      let query = `SELECT * FROM register WHERE uuid IN (${placeholders}) AND status IN ('CHECKUP', 'EDITING')`;
      if (user.role === 'editor') query += ` AND editor = ?`;
      const stmt = await env.DB.prepare(query);
      const rows = await (user.role === 'editor' ? stmt.bind(user.email, ...uuids) : stmt.bind(...uuids)).all();

      if (!rows.results || rows.results.length === 0) {
        return errorResponse('No valid items in CHECKUP or EDITING status');
      }

      const statements = [];
      const auditEntries = [];

      for (const row of rows.results) {
        const dk = dkMap[row.uuid];
        let dkRaw = row.dk_no_raw;
        let dkDisplay = row.dk_no_display;
        if (dk) {
          let raw = dk.dk_no_raw;
          let display = dk.dk_no_display;
          if (raw && raw.includes('/')) {
            const parts = raw.split('/');
            const num = parseInt(parts[0]);
            const year = parseInt(parts[1]);
            const fullYear = year > 50 ? 1900 + year : 2000 + year;
            raw = `${fullYear.toString().slice(-2)}${String(num).padStart(7, '0')}`;
            display = `${num}/${year}`;
          }
          dkRaw = raw || dkRaw;
          dkDisplay = display || dkDisplay;
        }
        if (!dkRaw) {
          return errorResponse(`DK No is required for ${row.uuid}`);
        }

        const stmt2 = env.DB.prepare(
          `UPDATE register SET 
            dk_no_raw = ?, dk_no_display = ?, 
            pass_date = ?, status = 'PASSED', 
            updated_at = ?, updated_by = ? 
           WHERE uuid = ?`
        );
        statements.push(stmt2.bind(dkRaw, dkDisplay, today, today, user.username, row.uuid));
        auditEntries.push({ row, dkRaw, dkDisplay });
      }

      const batchResults = await env.DB.batch(statements);
      if (!batchResults.every(r => r.success)) throw new Error('Batch pass failed');

      for (const entry of auditEntries) {
        await auditLog(
          env,
          user.email,
          user.username,
          'pass',
          entry.row.uuid,
          entry.row.id,
          entry.row,
          { ...entry.row, dk_no_raw: entry.dkRaw, dk_no_display: entry.dkDisplay, pass_date: today, status: 'PASSED' },
          'Passed verification',
          'register'
        );
      }

      await sendTelegram(
        env,
        `✅ *ตรวจผ่าน*\nผู้ใช้: ${user.username}\nจำนวน: ${auditEntries.length} รายการ`
      );

      return successResponse({ passed: auditEntries.length });
    } catch (err) {
      return errorResponse(`Pass failed: ${err.message}`, 500);
    }
  },

  // ---- propose ----
  async propose(request, env) {
    try {
      const user = await validateToken(request, env);
      if (!['admin', 'manager'].includes(user.role)) {
        return errorResponse('Permission denied', 403);
      }

      const body = await request.json();
      const { uuids } = body;
      if (!uuids || !Array.isArray(uuids) || uuids.length === 0) {
        return errorResponse('No items selected');
      }

      const placeholders = uuids.map(() => '?').join(',');
      const today = new Date().toISOString();

      const stmt = await env.DB.prepare(
        `SELECT * FROM register WHERE uuid IN (${placeholders}) AND status = 'PASSED'`
      );
      const rows = await stmt.bind(...uuids).all();
      if (!rows.results || rows.results.length === 0) {
        return errorResponse('No valid items in PASSED status');
      }

      const statements = [];
      const auditEntries = [];
      for (const row of rows.results) {
        const stmt2 = env.DB.prepare(
          `UPDATE register SET propose_date = ?, status = 'PROPOSED', updated_at = ?, updated_by = ? WHERE uuid = ?`
        );
        statements.push(stmt2.bind(today, today, user.username, row.uuid));
        auditEntries.push(row);
      }

      const batchResults = await env.DB.batch(statements);
      if (!batchResults.every(r => r.success)) throw new Error('Batch propose failed');

      for (const row of auditEntries) {
        await auditLog(
          env,
          user.email,
          user.username,
          'propose',
          row.uuid,
          row.id,
          row,
          { ...row, propose_date: today, status: 'PROPOSED' },
          'Proposed',
          'register'
        );
      }

      await sendTelegram(
        env,
        `📤 *เสนอ*\nผู้ใช้: ${user.username}\nจำนวน: ${auditEntries.length} รายการ`
      );

      return successResponse({ proposed: auditEntries.length });
    } catch (err) {
      return errorResponse(`Propose failed: ${err.message}`, 500);
    }
  },

  // ---- approve ----
  async approve(request, env) {
    try {
      const user = await validateToken(request, env);
      if (!['admin', 'manager'].includes(user.role)) {
        return errorResponse('Permission denied', 403);
      }

      const body = await request.json();
      const { uuids } = body;
      if (!uuids || !Array.isArray(uuids) || uuids.length === 0) {
        return errorResponse('No items selected');
      }

      const placeholders = uuids.map(() => '?').join(',');
      const today = new Date().toISOString();

      const stmt = await env.DB.prepare(
        `SELECT * FROM register WHERE uuid IN (${placeholders}) AND status = 'PROPOSED'`
      );
      const rows = await stmt.bind(...uuids).all();
      if (!rows.results || rows.results.length === 0) {
        return errorResponse('No valid items in PROPOSED status');
      }

      const statements = [];
      const auditEntries = [];
      for (const row of rows.results) {
        const stmt2 = env.DB.prepare(
          `UPDATE register SET approve_date = ?, status = 'APPROVED', updated_at = ?, updated_by = ? WHERE uuid = ?`
        );
        statements.push(stmt2.bind(today, today, user.username, row.uuid));
        auditEntries.push(row);
      }

      const batchResults = await env.DB.batch(statements);
      if (!batchResults.every(r => r.success)) throw new Error('Batch approve failed');

      for (const row of auditEntries) {
        await auditLog(
          env,
          user.email,
          user.username,
          'approve',
          row.uuid,
          row.id,
          row,
          { ...row, approve_date: today, status: 'APPROVED' },
          'Approved',
          'register'
        );
      }

      await sendTelegram(
        env,
        `✅ *อนุมัติ*\nผู้ใช้: ${user.username}\nจำนวน: ${auditEntries.length} รายการ`
      );

      return successResponse({ approved: auditEntries.length });
    } catch (err) {
      return errorResponse(`Approve failed: ${err.message}`, 500);
    }
  },

  // ---- pay ----
  async pay(request, env) {
    try {
      const user = await validateToken(request, env);
      if (!['admin', 'manager', 'checker'].includes(user.role)) {
        return errorResponse('Permission denied', 403);
      }

      const body = await request.json();
      const { uuids } = body;
      if (!uuids || !Array.isArray(uuids) || uuids.length === 0) {
        return errorResponse('No items selected');
      }

      const placeholders = uuids.map(() => '?').join(',');
      const today = new Date().toISOString();

      const stmt = await env.DB.prepare(
        `SELECT * FROM register WHERE uuid IN (${placeholders}) AND status = 'APPROVED'`
      );
      const rows = await stmt.bind(...uuids).all();
      if (!rows.results || rows.results.length === 0) {
        return errorResponse('No valid items in APPROVED status');
      }

      const statements = [];
      const auditEntries = [];
      for (const row of rows.results) {
        const stmt2 = env.DB.prepare(
          `UPDATE register SET pay_date = ?, status = 'PAID', updated_at = ?, updated_by = ? WHERE uuid = ?`
        );
        statements.push(stmt2.bind(today, today, user.username, row.uuid));
        auditEntries.push(row);
      }

      const batchResults = await env.DB.batch(statements);
      if (!batchResults.every(r => r.success)) throw new Error('Batch pay failed');

      for (const row of auditEntries) {
        await auditLog(
          env,
          user.email,
          user.username,
          'pay',
          row.uuid,
          row.id,
          row,
          { ...row, pay_date: today, status: 'PAID' },
          'Paid',
          'register'
        );
      }

      await sendTelegram(
        env,
        `💵 *จ่ายเช็คสำเร็จ*\nผู้ใช้: ${user.username}\nจำนวน: ${auditEntries.length} รายการ`
      );

      return successResponse({ paid: auditEntries.length });
    } catch (err) {
      return errorResponse(`Payment failed: ${err.message}`, 500);
    }
  },

  // ---- cancel ----
  async cancel(request, env) {
    try {
      const user = await validateToken(request, env);
      const body = await request.json();
      const { uuid, note } = body;
      if (!uuid) return errorResponse('UUID required');

      const stmt = await env.DB.prepare(`SELECT * FROM register WHERE uuid = ?`);
      const item = await stmt.bind(uuid).first();
      if (!item) return errorResponse('Item not found');
      if (item.status === 'PAID') {
        return errorResponse('Cannot cancel a paid item');
      }

      const today = new Date().toISOString();
      const oldStatus = item.status;

      const updateStmt = env.DB.prepare(
        `UPDATE register SET 
          cancel_date = ?, cancel_note = ?, 
          cancel_status = 1, cancel_change = ?,
          status = 'CANCELLED',
          updated_at = ?, updated_by = ?
         WHERE uuid = ?`
      );
      const result = await updateStmt.bind(today, note || null, oldStatus, today, user.username, uuid).run();

      if (!result.success) throw new Error('Cancel update failed');

      await auditLog(
        env,
        user.email,
        user.username,
        'cancel',
        uuid,
        item.id,
        item,
        { ...item, cancel_date: today, cancel_note: note, cancel_status: 1, status: 'CANCELLED' },
        `Cancelled: ${note || 'No reason provided'}`,
        'register'
      );

      await sendTelegram(
        env,
        `🚫 *ยกเลิก*\nผู้ใช้: ${user.username}\nUUID: ${uuid}\nหมายเหตุ: ${note || '-'}`
      );

      return successResponse({ cancelled: true });
    } catch (err) {
      return errorResponse(`Cancel failed: ${err.message}`, 500);
    }
  },

  // ---- recover ----
  async recover(request, env) {
    try {
      const user = await validateToken(request, env);
      const body = await request.json();
      const { uuid } = body;
      if (!uuid) return errorResponse('UUID required');

      const stmt = await env.DB.prepare(`SELECT * FROM register WHERE uuid = ? AND cancel_status = 1`);
      const item = await stmt.bind(uuid).first();
      if (!item) return errorResponse('Item not found or not cancelled');

      const oldStatus = item.cancel_change || 'WAITING';
      const today = new Date().toISOString();

      const updateStmt = env.DB.prepare(
        `UPDATE register SET 
          cancel_date = NULL, cancel_note = NULL, 
          cancel_status = 0, cancel_change = NULL,
          status = ?,
          updated_at = ?, updated_by = ?
         WHERE uuid = ?`
      );
      const result = await updateStmt.bind(oldStatus, today, user.username, uuid).run();
      if (!result.success) throw new Error('Recover update failed');

      await auditLog(
        env,
        user.email,
        user.username,
        'recover',
        uuid,
        item.id,
        item,
        { ...item, cancel_status: 0, status: oldStatus },
        `Recovered from cancelled (restored to ${oldStatus})`,
        'register'
      );

      await sendTelegram(
        env,
        `♻️ *กู้คืน*\nผู้ใช้: ${user.username}\nUUID: ${uuid}\nคืนสถานะ: ${oldStatus}`
      );

      return successResponse({ recovered: true, status: oldStatus });
    } catch (err) {
      return errorResponse(`Recover failed: ${err.message}`, 500);
    }
  },

  // ---- update (admin override) ----
  async update(request, env, uuid) {
    try {
      const user = await validateToken(request, env);
      if (!['admin', 'manager'].includes(user.role)) {
        return errorResponse('Permission denied', 403);
      }

      const body = await request.json();
      const {
        money_type, dept, sender, reserve_no, reserve_amount,
        egp_no, invoice, vendor, amount, description,
        request_no_display, dk_no_raw, dk_no_display,
        editor, edit_date, return_date, pass_date, propose_date, approve_date, pay_date
      } = body;

      const stmt = await env.DB.prepare(`SELECT * FROM register WHERE uuid = ?`);
      const item = await stmt.bind(uuid).first();
      if (!item) return errorResponse('Item not found');

      if (item.status === 'PAID' && user.role !== 'admin') {
        return errorResponse('Only admin can edit PAID items');
      }

      const fields = [];
      const values = [];
      const updates = {};

      const fieldMap = {
        money_type, dept, sender, reserve_no, reserve_amount,
        egp_no, invoice, vendor, amount, description,
        request_no_display, dk_no_raw, dk_no_display,
        editor, edit_date, return_date, pass_date, propose_date, approve_date, pay_date
      };

      for (const [key, val] of Object.entries(fieldMap)) {
        if (val !== undefined && val !== null && val !== '') {
          let value = val;
          if (key === 'amount' || key === 'reserve_amount') {
            value = parseFloat(val);
          }
          fields.push(`${key} = ?`);
          values.push(value);
          updates[key] = value;
        }
      }

      if (fields.length === 0) return errorResponse('No fields to update');

      fields.push('updated_at = ?');
      values.push(new Date().toISOString());
      fields.push('updated_by = ?');
      values.push(user.username);
      values.push(uuid);

      const isOverride = item.status === 'PAID' && user.role === 'admin';

      const updateStmt = env.DB.prepare(`UPDATE register SET ${fields.join(', ')} WHERE uuid = ?`);
      const result = await updateStmt.bind(...values).run();
      if (!result.success) throw new Error('Update failed');

      await auditLog(
        env,
        user.email,
        user.username,
        isOverride ? 'admin_override_paid' : 'update',
        uuid,
        item.id,
        item,
        { ...item, ...updates },
        isOverride ? 'Admin override on PAID item' : 'Updated item',
        'register'
      );

      return successResponse({ updated: true, uuid });
    } catch (err) {
      return errorResponse(`Update failed: ${err.message}`, 500);
    }
  },
};
