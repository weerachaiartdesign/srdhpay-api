// register.js - จัดการข้อมูลทะเบียนเบิกจ่ายทั้งหมด

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
  // 5.3 รายการทะเบียนเบิกจ่าย (List)
  async list(request, env) {
    try {
      const user = await validateToken(request, env);
      const url = new URL(request.url);
      const page = parseInt(url.searchParams.get('page')) || 1;
      const limit = parseInt(url.searchParams.get('limit')) || 50;
      const offset = (page - 1) * limit;

      // Filters
      const money_type = url.searchParams.get('money_type') || '';
      const dept = url.searchParams.get('dept') || '';
      const status = url.searchParams.get('status') || '';
      const search = url.searchParams.get('search') || '';
      const sort = url.searchParams.get('sort') || 'desc';

      // Guest read-only
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

      // Don't show WAITING in list (5.3.1)
      conditions.push(`r.status != 'WAITING'`);

      if (money_type) {
        conditions.push(`r.money_type = ?`);
        params.push(money_type);
      }
      if (dept) {
        conditions.push(`r.dept = ?`);
        params.push(dept);
      }
      if (status) {
        conditions.push(`r.status = ?`);
        params.push(status);
      }
      if (search) {
        conditions.push(`(
          r.vendor LIKE ? OR 
          r.description LIKE ? OR 
          r.receive_no_display LIKE ? OR 
          r.request_no_display LIKE ? OR 
          r.dk_no_display LIKE ? OR 
          r.invoice LIKE ? OR 
          r.egp_no LIKE ?
        )`);
        const s = `%${search}%`;
        params.push(s, s, s, s, s, s, s);
      }

      if (conditions.length) {
        query += ' AND ' + conditions.join(' AND ');
      }

      const order = sort === 'asc' ? 'ASC' : 'DESC';
      query += ` ORDER BY r.receive_date ${order}, r.receive_no_raw ${order} LIMIT ? OFFSET ?`;
      params.push(limit, offset);

      const stmt = await env.DB.prepare(query);
      const rows = await stmt.bind(...params).all();

      // Get total count
      let countQuery = `
        SELECT COUNT(*) as total FROM register r
        WHERE (r.cancel_status IS NULL OR r.cancel_status = 0 OR r.cancel_status != 1)
        AND r.status != 'WAITING'
      `;
      let countParams = [];
      // Re-add conditions for count (without limit/offset)
      const conds = conditions.filter(c => c !== `r.status != 'WAITING'`);
      if (conds.length) {
        countQuery += ' AND ' + conds.join(' AND ');
        // We need to clone params without limit/offset
        // Actually easier: re-run with the same filter but no pagination
      }
      // For simplicity we'll just count with same query pattern but limit removed
      // Let's just do a separate count with the same filters
      let countStmt = await env.DB.prepare(countQuery);
      // Rebind filters excluding limit/offset
      let countParamsList = [];
      if (money_type) countParamsList.push(money_type);
      if (dept) countParamsList.push(dept);
      if (status) countParamsList.push(status);
      if (search) {
        const s = `%${search}%`;
        countParamsList.push(s, s, s, s, s, s, s);
      }
      const countResult = await countStmt.bind(...countParamsList).first();

      return successResponse({
        data: rows.results || [],
        pagination: {
          page,
          limit,
          total: countResult ? countResult.total : 0,
        },
      });
    } catch (err) {
      return errorResponse(err.message, 401);
    }
  },

  // 5.4 นำเข้าข้อมูล (Import)
  async import(request, env) {
    try {
      const user = await validateToken(request, env);
      if (user.role === 'guest') return errorResponse('Permission denied', 403);

      // Check permission
      const canImport = await hasPermission(env, 'import', user.role);
      if (!canImport) return errorResponse('Permission denied', 403);

      const body = await request.json();
      const { items } = body; // Array of register objects

      if (!items || !Array.isArray(items) || items.length === 0) {
        return errorResponse('No items to import');
      }

      // Check import limit
      const limitKey = user.role === 'staff' ? 'import_limit_staff' : 'import_limit_admin';
      const limitStmt = await env.DB.prepare(`SELECT value FROM settings_app WHERE key = ?`);
      const limitRow = await limitStmt.bind(limitKey).first();
      const maxLimit = limitRow ? parseInt(limitRow.value) : (user.role === 'staff' ? 20 : 100);
      if (items.length > maxLimit) {
        return errorResponse(`Cannot import more than ${maxLimit} items at once`);
      }

      // Validate each item
      const today = new Date().toISOString();
      const fiscalYear = await getFiscalYearShort(env);
      const dept = user.dept || '';

      // Prepare items for validation
      const validItems = [];
      for (const item of items) {
        // Mandatory fields
        if (!item.money_type) return errorResponse('Money type is required');
        if (!item.request_no_raw) return errorResponse('Request no is required');
        if (!item.amount || item.amount <= 0) return errorResponse('Amount must be greater than 0');
        if (!item.vendor) return errorResponse('Vendor is required');

        // If request_no_raw is 1/69 format, convert to raw
        let requestRaw = item.request_no_raw;
        let requestDisplay = item.request_no_display;
        if (requestRaw.includes('/')) {
          const parts = requestRaw.split('/');
          const num = parseInt(parts[0]);
          const year = parseInt(parts[1]);
          const fullYear = year > 50 ? 1900 + year : 2000 + year;
          const raw = `${fullYear.toString().slice(-2)}${String(num).padStart(7, '0')}`;
          requestRaw = raw;
          requestDisplay = requestRaw; // Or keep original
        }

        // DK No could be empty initially
        let dkRaw = item.dk_no_raw || null;
        let dkDisplay = item.dk_no_display || null;
        if (dkRaw && dkRaw.includes('/')) {
          const parts = dkRaw.split('/');
          const num = parseInt(parts[0]);
          const year = parseInt(parts[1]);
          const fullYear = year > 50 ? 1900 + year : 2000 + year;
          const raw = `${fullYear.toString().slice(-2)}${String(num).padStart(7, '0')}`;
          dkRaw = raw;
          dkDisplay = dkRaw;
        }

        validItems.push({
          ...item,
          request_no_raw: requestRaw,
          request_no_display: item.request_no_display || requestRaw,
          dk_no_raw: dkRaw,
          dk_no_display: item.dk_no_display || dkRaw,
          dept: item.dept || dept,
          sender: item.sender || user.username,
          register_date: today,
          source: item.source || 'IMPORT',
          status: 'WAITING',
        });
      }

      // Start D1 Transaction for atomic registration
      const result = await env.DB.transaction(async (tx) => {
        // 1. Reserve Register Number
        const registerNo = await getNextRegisterNumber({ DB: tx }, validItems.length);

        const inserted = [];
        for (const item of validItems) {
          // Check duplicate (REQUEST_NO_raw + MONEY_TYPE)
          const dupStmt = await tx.prepare(
            `SELECT uuid, * FROM register WHERE request_no_raw = ? AND money_type = ? AND (cancel_status IS NULL OR cancel_status = 0)`
          );
          const existing = await dupStmt.bind(item.request_no_raw, item.money_type).first();

          let uuid = item.uuid || crypto.randomUUID();

          if (existing) {
            // UPDATE existing (keep old register_no, overwrite non-empty fields)
            uuid = existing.uuid;
            const fields = [];
            const values = [];

            // Overwrite only if new value is not empty/undefined
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
            // Always update updated_at and updated_by
            fields.push('updated_at = ?');
            values.push(new Date().toISOString());
            fields.push('updated_by = ?');
            values.push(user.username);

            // Keep original register_no
            if (fields.length === 0) continue; // nothing to update

            values.push(uuid);
            const updateStmt = await tx.prepare(
              `UPDATE register SET ${fields.join(', ')} WHERE uuid = ?`
            );
            await updateStmt.bind(...values).run();

            await auditLog(
              { DB: tx },
              user.email,
              user.username,
              'update_import',
              uuid,
              existing.id || null,
              existing,
              { ...existing, ...item },
              'Updated via re-import',
              'register'
            );

            inserted.push({ ...existing, ...item, uuid });
          } else {
            // INSERT new
            const insertStmt = await tx.prepare(`
              INSERT INTO register (
                uuid, money_type, dept, sender, reserve_no, reserve_amount,
                egp_no, invoice, vendor, amount, description,
                request_no_raw, request_no_display,
                dk_no_raw, dk_no_display,
                register_no_raw, register_no_display,
                register_date, status, source, created_by, updated_by
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            await insertStmt.bind(
              uuid,
              item.money_type,
              item.dept || dept,
              item.sender || user.username,
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
              user.username
            ).run();

            await auditLog(
              { DB: tx },
              user.email,
              user.username,
              'import',
              uuid,
              null,
              null,
              item,
              'Imported new item',
              'register'
            );
            inserted.push({ ...item, uuid });
          }
        }

        // Log success
        await logAction(
          { DB: tx },
          user.email,
          user.username,
          user.role,
          'import',
          '/import',
          `Imported ${inserted.length} items (Batch: ${registerNo.display})`,
          null
        );

        return { inserted, registerNo };
      });

      // Send Telegram notification
      await sendTelegram(
        env,
        `📥 *นำเข้าข้อมูลสำเร็จ*\nผู้ใช้: ${user.username}\nจำนวน: ${result.inserted.length} รายการ\nเลขทะเบียน: ${result.registerNo.display}\nเวลาที่ทำการ: ${new Date().toLocaleString('th-TH')}`
      );

      return successResponse({
        imported: result.inserted.length,
        register_no: result.registerNo.display,
        register_no_raw: result.registerNo.raw,
        items: result.inserted,
      });
    } catch (err) {
      console.error('Import error:', err);
      return errorResponse(`Import failed: ${err.message}`, 500);
    }
  },

  // 5.5 รับเข้าระบบ (Receive)
  async receive(request, env) {
    try {
      const user = await validateToken(request, env);
      if (!['admin', 'manager'].includes(user.role)) {
        return errorResponse('Permission denied', 403);
      }

      const body = await request.json();
      const { uuids } = body; // array of UUIDs

      if (!uuids || !Array.isArray(uuids) || uuids.length === 0) {
        return errorResponse('No items selected');
      }

      const today = new Date().toISOString();

      // Fetch items to receive
      const placeholders = uuids.map(() => '?').join(',');
      const fetchStmt = await env.DB.prepare(
        `SELECT * FROM register WHERE uuid IN (${placeholders}) AND status = 'WAITING'`
      );
      const items = await fetchStmt.bind(...uuids).all();

      if (!items.results || items.results.length === 0) {
        return errorResponse('No valid items in WAITING status');
      }

      // Reserve receive numbers
      const receiveNumbers = await getNextReceiveNumbers(env, items.results.length);

      const result = await env.DB.transaction(async (tx) => {
        const updatedItems = [];
        for (let i = 0; i < items.results.length; i++) {
          const item = items.results[i];
          const num = receiveNumbers[i];

          await tx.prepare(
            `UPDATE register SET 
              receive_no_raw = ?, receive_no_display = ?, 
              receive_date = ?, status = 'RECEIVED', updated_at = ?, updated_by = ?
             WHERE uuid = ?`
          ).bind(
            num.raw,
            num.display,
            today,
            today,
            user.username,
            item.uuid
          ).run();

          await auditLog(
            { DB: tx },
            user.email,
            user.username,
            'receive',
            item.uuid,
            item.id,
            item,
            { ...item, receive_no_raw: num.raw, receive_no_display: num.display, status: 'RECEIVED' },
            'Received items',
            'register'
          );

          updatedItems.push({ ...item, ...num });
        }

        await logAction(
          { DB: tx },
          user.email,
          user.username,
          user.role,
          'receive',
          '/receive',
          `Received ${updatedItems.length} items`,
          null
        );

        return { updatedItems };
      });

      await sendTelegram(
        env,
        `📨 *รับเข้าระบบสำเร็จ*\nผู้ใช้: ${user.username}\nจำนวน: ${result.updatedItems.length} รายการ\nเลขรับ: ${result.updatedItems.map(i => i.display).join(', ')}\nเวลาที่ทำการ: ${new Date().toLocaleString('th-TH')}`
      );

      return successResponse({
        received: result.updatedItems.length,
        items: result.updatedItems,
      });
    } catch (err) {
      return errorResponse(`Receive failed: ${err.message}`, 500);
    }
  },

  // 5.5.4 กำหนดผู้ตรวจ (Assign Editor)
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
      if (!editor_email) {
        return errorResponse('Editor email is required');
      }

      // Verify editor exists and has role 'editor'
      const editorCheck = await env.DB.prepare(
        `SELECT username FROM auth WHERE email = ? AND role = 'editor' AND active = 1`
      );
      const editor = await editorCheck.bind(editor_email).first();
      if (!editor) {
        return errorResponse('Editor not found or inactive');
      }

      const placeholders = uuids.map(() => '?').join(',');
      const result = await env.DB.transaction(async (tx) => {
        const updatedItems = [];
        const stmt = await tx.prepare(
          `UPDATE register SET editor = ?, status = 'CHECKUP', updated_at = ?, updated_by = ? 
           WHERE uuid IN (${placeholders}) AND status = 'RECEIVED' RETURNING *`
        );
        const rows = await stmt.bind(editor_email, new Date().toISOString(), user.username, ...uuids).all();

        if (!rows.results || rows.results.length === 0) {
          throw new Error('No valid items in RECEIVED status');
        }

        for (const row of rows.results) {
          await auditLog(
            { DB: tx },
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
          updatedItems.push(row);
        }

        return { updatedItems };
      });

      await sendTelegram(
        env,
        `👤 *กำหนดผู้ตรวจ*\nผู้ใช้: ${user.username}\nผู้ตรวจ: ${editor_email}\nจำนวน: ${result.updatedItems.length} รายการ\nเวลาที่ทำการ: ${new Date().toLocaleString('th-TH')}`
      );

      return successResponse({
        assigned: result.updatedItems.length,
        editor: editor_email,
      });
    } catch (err) {
      return errorResponse(`Assign editor failed: ${err.message}`, 500);
    }
  },

  // 5.6 บันทึกการตรวจสอบ (Edit/Send for correction)
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

      // Check permission: editor sees only their own, admin/manager sees all
      let query = `SELECT * FROM register WHERE uuid IN (${placeholders}) AND status = 'CHECKUP'`;
      if (user.role === 'editor') {
        query += ` AND editor = ?`;
      }
      const stmt = await env.DB.prepare(query);
      let rows;
      if (user.role === 'editor') {
        rows = await stmt.bind(user.email, ...uuids).all();
      } else {
        rows = await stmt.bind(...uuids).all();
      }

      if (!rows.results || rows.results.length === 0) {
        return errorResponse('No valid items in CHECKUP status');
      }

      const result = await env.DB.transaction(async (tx) => {
        const updatedItems = [];
        for (const row of rows.results) {
          await tx.prepare(
            `UPDATE register SET edit_date = ?, status = 'EDITING', updated_at = ?, updated_by = ? WHERE uuid = ?`
          ).bind(today, today, user.username, row.uuid).run();

          await auditLog(
            { DB: tx },
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
          updatedItems.push(row);
        }
        return { updatedItems };
      });

      await sendTelegram(
        env,
        `✏️ *ส่งแก้ไข*\nผู้ใช้: ${user.username}\nจำนวน: ${result.updatedItems.length} รายการ\nเวลาที่ทำการ: ${new Date().toLocaleString('th-TH')}`
      );

      return successResponse({ edited: result.updatedItems.length });
    } catch (err) {
      return errorResponse(`Edit failed: ${err.message}`, 500);
    }
  },

  // 5.6.4 รับคืน (Return)
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
      if (user.role === 'editor') {
        query += ` AND editor = ?`;
      }
      const stmt = await env.DB.prepare(query);
      let rows;
      if (user.role === 'editor') {
        rows = await stmt.bind(user.email, ...uuids).all();
      } else {
        rows = await stmt.bind(...uuids).all();
      }

      if (!rows.results || rows.results.length === 0) {
        return errorResponse('No valid items in EDITING status');
      }

      const result = await env.DB.transaction(async (tx) => {
        const updatedItems = [];
        for (const row of rows.results) {
          await tx.prepare(
            `UPDATE register SET return_date = ?, status = 'CHECKUP', updated_at = ?, updated_by = ? WHERE uuid = ?`
          ).bind(today, today, user.username, row.uuid).run();

          await auditLog(
            { DB: tx },
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
          updatedItems.push(row);
        }
        return { updatedItems };
      });

      await sendTelegram(
        env,
        `↩️ *รับคืน*\nผู้ใช้: ${user.username}\nจำนวน: ${result.updatedItems.length} รายการ\nเวลาที่ทำการ: ${new Date().toLocaleString('th-TH')}`
      );

      return successResponse({ returned: result.updatedItems.length });
    } catch (err) {
      return errorResponse(`Return failed: ${err.message}`, 500);
    }
  },

  // 5.6.5 ตรวจผ่าน (Pass)
  async pass(request, env) {
    try {
      const user = await validateToken(request, env);
      const body = await request.json();
      const { uuids, dk_nos } = body; // dk_nos: array of { uuid, dk_no_raw, dk_no_display }

      if (!uuids || !Array.isArray(uuids) || uuids.length === 0) {
        return errorResponse('No items selected');
      }

      // Map dk_nos by uuid
      const dkMap = {};
      if (dk_nos) {
        for (const d of dk_nos) {
          dkMap[d.uuid] = d;
        }
      }

      const placeholders = uuids.map(() => '?').join(',');
      const today = new Date().toISOString();

      let query = `SELECT * FROM register WHERE uuid IN (${placeholders}) AND status IN ('CHECKUP', 'EDITING')`;
      if (user.role === 'editor') {
        query += ` AND editor = ?`;
      }
      const stmt = await env.DB.prepare(query);
      let rows;
      if (user.role === 'editor') {
        rows = await stmt.bind(user.email, ...uuids).all();
      } else {
        rows = await stmt.bind(...uuids).all();
      }

      if (!rows.results || rows.results.length === 0) {
        return errorResponse('No valid items in CHECKUP or EDITING status');
      }

      const result = await env.DB.transaction(async (tx) => {
        const updatedItems = [];
        for (const row of rows.results) {
          const dk = dkMap[row.uuid];
          // DK No is required to pass (7.2)
          let dkRaw = row.dk_no_raw;
          let dkDisplay = row.dk_no_display;
          if (dk) {
            // Format dk_no (e.g. 1801/69 -> 690001801)
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
            throw new Error(`DK No is required for ${row.uuid}`);
          }

          await tx.prepare(
            `UPDATE register SET 
              dk_no_raw = ?, dk_no_display = ?, 
              pass_date = ?, status = 'PASSED', 
              updated_at = ?, updated_by = ? 
             WHERE uuid = ?`
          ).bind(dkRaw, dkDisplay, today, today, user.username, row.uuid).run();

          await auditLog(
            { DB: tx },
            user.email,
            user.username,
            'pass',
            row.uuid,
            row.id,
            row,
            { ...row, dk_no_raw: dkRaw, dk_no_display: dkDisplay, pass_date: today, status: 'PASSED' },
            'Passed verification',
            'register'
          );
          updatedItems.push(row);
        }
        return { updatedItems };
      });

      await sendTelegram(
        env,
        `✅ *ตรวจผ่าน*\nผู้ใช้: ${user.username}\nจำนวน: ${result.updatedItems.length} รายการ\nเวลาที่ทำการ: ${new Date().toLocaleString('th-TH')}`
      );

      return successResponse({ passed: result.updatedItems.length });
    } catch (err) {
      return errorResponse(`Pass failed: ${err.message}`, 500);
    }
  },

  // 5.7 เสนอ (Propose)
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

      const result = await env.DB.transaction(async (tx) => {
        for (const row of rows.results) {
          await tx.prepare(
            `UPDATE register SET propose_date = ?, status = 'PROPOSED', updated_at = ?, updated_by = ? WHERE uuid = ?`
          ).bind(today, today, user.username, row.uuid).run();

          await auditLog(
            { DB: tx },
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
        return { count: rows.results.length };
      });

      await sendTelegram(
        env,
        `📤 *เสนอ*\nผู้ใช้: ${user.username}\nจำนวน: ${result.count} รายการ\nเวลาที่ทำการ: ${new Date().toLocaleString('th-TH')}`
      );

      return successResponse({ proposed: result.count });
    } catch (err) {
      return errorResponse(`Propose failed: ${err.message}`, 500);
    }
  },

  // 5.7.4 อนุมัติ (Approve)
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

      const result = await env.DB.transaction(async (tx) => {
        for (const row of rows.results) {
          await tx.prepare(
            `UPDATE register SET approve_date = ?, status = 'APPROVED', updated_at = ?, updated_by = ? WHERE uuid = ?`
          ).bind(today, today, user.username, row.uuid).run();

          await auditLog(
            { DB: tx },
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
        return { count: rows.results.length };
      });

      await sendTelegram(
        env,
        `✅ *อนุมัติ*\nผู้ใช้: ${user.username}\nจำนวน: ${result.count} รายการ\nเวลาที่ทำการ: ${new Date().toLocaleString('th-TH')}`
      );

      return successResponse({ approved: result.count });
    } catch (err) {
      return errorResponse(`Approve failed: ${err.message}`, 500);
    }
  },

  // 5.8 จ่ายเช็ค (Payment)
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

      const result = await env.DB.transaction(async (tx) => {
        for (const row of rows.results) {
          await tx.prepare(
            `UPDATE register SET pay_date = ?, status = 'PAID', updated_at = ?, updated_by = ? WHERE uuid = ?`
          ).bind(today, today, user.username, row.uuid).run();

          await auditLog(
            { DB: tx },
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
        return { count: rows.results.length };
      });

      await sendTelegram(
        env,
        `💵 *จ่ายเช็คสำเร็จ*\nผู้ใช้: ${user.username}\nจำนวน: ${result.count} รายการ\nเวลาที่ทำการ: ${new Date().toLocaleString('th-TH')}`
      );

      return successResponse({ paid: result.count });
    } catch (err) {
      return errorResponse(`Payment failed: ${err.message}`, 500);
    }
  },

  // 5.11.6 ยกเลิก (Cancel)
  async cancel(request, env) {
    try {
      const user = await validateToken(request, env);
      const body = await request.json();
      const { uuid, note } = body;

      if (!uuid) return errorResponse('UUID required');

      // Fetch current item
      const stmt = await env.DB.prepare(`SELECT * FROM register WHERE uuid = ?`);
      const item = await stmt.bind(uuid).first();
      if (!item) return errorResponse('Item not found');

      // Cannot cancel if already PAID (6.4)
      if (item.status === 'PAID') {
        return errorResponse('Cannot cancel a paid item');
      }

      const today = new Date().toISOString();
      const oldStatus = item.status;

      const result = await env.DB.transaction(async (tx) => {
        await tx.prepare(
          `UPDATE register SET 
            cancel_date = ?, cancel_note = ?, 
            cancel_status = 1, cancel_change = ?,
            status = 'CANCELLED',
            updated_at = ?, updated_by = ?
           WHERE uuid = ?`
        ).bind(today, note || null, oldStatus, today, user.username, uuid).run();

        await auditLog(
          { DB: tx },
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

        return { item };
      });

      await sendTelegram(
        env,
        `🚫 *ยกเลิก*\nผู้ใช้: ${user.username}\nUUID: ${uuid}\nหมายเหตุ: ${note || '-'}\nเวลาที่ทำการ: ${new Date().toLocaleString('th-TH')}`
      );

      return successResponse({ cancelled: true });
    } catch (err) {
      return errorResponse(`Cancel failed: ${err.message}`, 500);
    }
  },

  // 5.11.6 กู้คืน (Recover)
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

      const result = await env.DB.transaction(async (tx) => {
        await tx.prepare(
          `UPDATE register SET 
            cancel_date = NULL, cancel_note = NULL, 
            cancel_status = 0, cancel_change = NULL,
            status = ?,
            updated_at = ?, updated_by = ?
           WHERE uuid = ?`
        ).bind(oldStatus, today, user.username, uuid).run();

        await auditLog(
          { DB: tx },
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

        return { item };
      });

      await sendTelegram(
        env,
        `♻️ *กู้คืน*\nผู้ใช้: ${user.username}\nUUID: ${uuid}\nคืนสถานะ: ${oldStatus}\nเวลาที่ทำการ: ${new Date().toLocaleString('th-TH')}`
      );

      return successResponse({ recovered: true, status: oldStatus });
    } catch (err) {
      return errorResponse(`Recover failed: ${err.message}`, 500);
    }
  },

  // 5.11.6 แก้ไขรายการ (Admin Override)
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

      // Fetch current item
      const stmt = await env.DB.prepare(`SELECT * FROM register WHERE uuid = ?`);
      const item = await stmt.bind(uuid).first();
      if (!item) return errorResponse('Item not found');

      // If status is PAID, only admin can override (7.3)
      if (item.status === 'PAID' && user.role !== 'admin') {
        return errorResponse('Only admin can edit PAID items');
      }

      // Build update fields
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
          // Special: if amount is string, parse to float
          let value = val;
          if (key === 'amount' || key === 'reserve_amount') {
            value = parseFloat(val);
          }
          fields.push(`${key} = ?`);
          values.push(value);
          updates[key] = value;
        }
      }

      if (fields.length === 0) {
        return errorResponse('No fields to update');
      }

      // Always update updated_at, updated_by
      fields.push('updated_at = ?');
      values.push(new Date().toISOString());
      fields.push('updated_by = ?');
      values.push(user.username);

      // If admin override PAID, log specifically
      const isOverride = item.status === 'PAID' && user.role === 'admin';

      values.push(uuid);
      const updateStmt = await env.DB.prepare(
        `UPDATE register SET ${fields.join(', ')} WHERE uuid = ?`
      );
      await updateStmt.bind(...values).run();

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

      await logAction(
        env,
        user.email,
        user.username,
        user.role,
        'update_item',
        '/settings',
        `Updated ${uuid}`,
        null
      );

      return successResponse({ updated: true, uuid });
    } catch (err) {
      return errorResponse(`Update failed: ${err.message}`, 500);
    }
  },
};