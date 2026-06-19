-- ============================================================
-- verify_d1.sql — ตรวจสอบความพร้อมของ D1 Database
-- วิธีใช้ : Cloudflare Dashboard → D1 → srdhpay → Console
-- ============================================================

-- ══════════════════════════════════════════════
-- STEP 1 : ตรวจสอบว่ามีตารางครบ 14 ตาราง
-- ══════════════════════════════════════════════
SELECT 
  name,
  CASE 
    WHEN name IN (
      '_cf_KV','auth','sqlite_sequence','register',
      'sessions','counters','logs','audit_logs',
      'settings_app','settings_money_type','settings_vendor',
      'settings_dept','settings_system','settings_permission'
    ) THEN '✅ พบแล้ว'
    ELSE '⚠️ ไม่ได้กำหนด'
  END AS status
FROM sqlite_master
WHERE type = 'table'
ORDER BY name;

-- ══════════════════════════════════════════════
-- STEP 2 : ตรวจสอบ Index ที่จำเป็น
-- ══════════════════════════════════════════════
SELECT 
  name AS index_name,
  tbl_name AS table_name
FROM sqlite_master
WHERE type = 'index'
  AND name NOT LIKE 'sqlite_%'
ORDER BY tbl_name, name;

-- ══════════════════════════════════════════════
-- STEP 3 : ตรวจสอบ Columns ของตาราง register
-- ══════════════════════════════════════════════
PRAGMA table_info(register);

-- ══════════════════════════════════════════════
-- STEP 4 : ตรวจสอบ Columns ของตาราง auth
-- ══════════════════════════════════════════════
PRAGMA table_info(auth);

-- ══════════════════════════════════════════════
-- STEP 5 : ตรวจสอบ Columns ของตาราง sessions
-- ══════════════════════════════════════════════
PRAGMA table_info(sessions);

-- ══════════════════════════════════════════════
-- STEP 6 : ตรวจสอบ settings_app (ต้องครบ 16 rows)
-- ══════════════════════════════════════════════
SELECT 
  id,
  key,
  value,
  CASE
    WHEN key IN (
      'fiscal_year','fiscal_year_short','fiscal_start_date',
      'fiscal_end_date','import_allow_start','import_allow_end',
      'dashboard_top_money_type','dashboard_top_dept',
      'dashboard_top_money','default_password','app_version',
      'import_limit_staff','import_limit_admin','app_name',
      'print_margin','print_paper_size'
    ) THEN '✅'
    ELSE '⚠️ key ไม่คาดหวัง'
  END AS check_status
FROM settings_app
ORDER BY id;

-- ══════════════════════════════════════════════
-- STEP 7 : ตรวจสอบ settings_system (ต้องครบ 20 rows)
-- ══════════════════════════════════════════════
SELECT 
  id,
  key,
  value,
  CASE
    WHEN key IN (
      'session_guest_timeout_hours','session_inactivity_minutes',
      'session_token_age_hours','session_max_login_retry',
      'retention_years','retention_enabled',
      'telegram_enabled','telegram_bot_token','telegram_chat_id',
      'tg_notify_import','tg_notify_receive','tg_notify_assign_editor',
      'tg_notify_edit','tg_notify_return','tg_notify_pass',
      'tg_notify_propose','tg_notify_approve','tg_notify_pay',
      'tg_notify_cancel','tg_notify_recovery'
    ) THEN '✅'
    ELSE '⚠️ key ไม่คาดหวัง'
  END AS check_status
FROM settings_system
ORDER BY id;

-- ══════════════════════════════════════════════
-- STEP 8 : ตรวจสอบ settings_permission (ต้องครบ 12 rows)
-- ══════════════════════════════════════════════
SELECT
  id,
  module,
  admin, manager, editor, checker, staff, guest,
  CASE
    WHEN module IN (
      'dashboard','list','import','receive','verify',
      'approve','payment','report','auth_profile',
      'auth_manage','settings','system'
    ) THEN '✅'
    ELSE '⚠️ module ไม่คาดหวัง'
  END AS check_status
FROM settings_permission
ORDER BY id;

-- ══════════════════════════════════════════════
-- STEP 9 : ตรวจสอบ settings_money_type
-- ══════════════════════════════════════════════
SELECT id, name, color, is_active FROM settings_money_type ORDER BY id;

-- ══════════════════════════════════════════════
-- STEP 10 : ตรวจสอบ settings_dept
-- ══════════════════════════════════════════════
SELECT id, name, is_active FROM settings_dept ORDER BY id;

-- ══════════════════════════════════════════════
-- STEP 11 : ตรวจสอบ counters (Running No.)
-- ══════════════════════════════════════════════
SELECT * FROM counters ORDER BY id;

-- ══════════════════════════════════════════════
-- STEP 12 : ตรวจสอบ admin user (ต้องมีอย่างน้อย 1 คน)
-- ══════════════════════════════════════════════
SELECT 
  id, email, name, role,
  is_active,
  force_change_password,
  darkmode,
  created_at
FROM auth
ORDER BY id;

-- ══════════════════════════════════════════════
-- STEP 13 : สรุป row count ทุกตาราง
-- ══════════════════════════════════════════════
SELECT 'auth'                AS tbl, COUNT(*) AS rows FROM auth
UNION ALL
SELECT 'register'           , COUNT(*) FROM register
UNION ALL
SELECT 'sessions'           , COUNT(*) FROM sessions
UNION ALL
SELECT 'counters'           , COUNT(*) FROM counters
UNION ALL
SELECT 'logs'               , COUNT(*) FROM logs
UNION ALL
SELECT 'audit_logs'         , COUNT(*) FROM audit_logs
UNION ALL
SELECT 'settings_app'       , COUNT(*) FROM settings_app
UNION ALL
SELECT 'settings_money_type', COUNT(*) FROM settings_money_type
UNION ALL
SELECT 'settings_vendor'    , COUNT(*) FROM settings_vendor
UNION ALL
SELECT 'settings_dept'      , COUNT(*) FROM settings_dept
UNION ALL
SELECT 'settings_system'    , COUNT(*) FROM settings_system
UNION ALL
SELECT 'settings_permission', COUNT(*) FROM settings_permission
ORDER BY tbl;
