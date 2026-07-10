// ============================================================
// telegram.js — แจ้งเตือนผ่าน Telegram Bot ตามข้อ 5.12.4 / 7.22
// เหตุการณ์ที่แจ้ง: import, receive, assign_editor, edit, return, pass,
//                  propose, approve, pay, cancel, recovery
// เหตุการณ์ที่ไม่แจ้ง: login, logout, login failed
// ============================================================

const NOTIFY_KEY_MAP = {
  import: 'tg_notify_import',
  receive: 'tg_notify_receive',
  assign_editor: 'tg_notify_assign_editor',
  edit: 'tg_notify_edit',
  return: 'tg_notify_return',
  pass: 'tg_notify_pass',
  propose: 'tg_notify_propose',
  approve: 'tg_notify_approve',
  pay: 'tg_notify_pay',
  cancel: 'tg_notify_cancel',
  recovery: 'tg_notify_recovery'
};

// เรียกแบบ "fire and forget ที่ปลอดภัย" — ถ้า telegram error ต้องไม่กระทบ business logic หลัก
export async function notifyTelegram(env, eventKey, message) {
  try {
    const toggleKey = NOTIFY_KEY_MAP[eventKey];
    if (!toggleKey) return; // event นี้ไม่ได้อยู่ในรายการที่ต้องแจ้งเตือน

    const rows = await env.DB.prepare(
      `SELECT key, value FROM settings_system WHERE key IN ('telegram_enabled','telegram_bot_token','telegram_chat_id', ?)`
    ).bind(toggleKey).all();

    const settings = {};
    for (const row of rows.results) settings[row.key] = row.value;

    if (settings.telegram_enabled !== '1') return;
    if (settings[toggleKey] !== '1') return;
    if (!settings.telegram_bot_token || !settings.telegram_chat_id) return;

    await fetch(`https://api.telegram.org/bot${settings.telegram_bot_token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: settings.telegram_chat_id, text: message })
    });
  } catch (err) {
    console.error('Telegram notify error:', err);
  }
}
