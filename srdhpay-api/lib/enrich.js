// ============================================================
// enrich.js — เติมชื่อผู้ตรวจที่แสดงผล (editor_display) จากอีเมลที่เก็บใน register.editor
// ============================================================

export async function attachEditorNames(env, rows) {
  const emails = [...new Set((rows || []).map((r) => r.editor).filter(Boolean))];
  if (emails.length === 0) return rows;

  const placeholders = emails.map(() => '?').join(',');
  const result = await env.DB.prepare(
    `SELECT email, username FROM auth WHERE email IN (${placeholders})`
  ).bind(...emails).all();

  const nameMap = {};
  for (const r of result.results) nameMap[r.email] = r.username;

  return rows.map((r) => ({
    ...r,
    editor_display: r.editor ? (nameMap[r.editor] || r.editor) : null
  }));
}
