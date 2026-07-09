// running.js - Generate register_no and receive_no with skip-on-rollback

import { getFiscalYearShort } from './helper.js';

// Generate register number (batch) - reserves and returns register_no_raw and display
export async function getNextRegisterNumber(env, count) {
  const fiscalYear = await getFiscalYearShort(env);
  const key = `register_${fiscalYear}`;

  // We need to reserve a sequence number for this batch
  // Use D1 transaction to increment and get current value
  // Then we generate register_no_raw = FY + count padded 3 digits + seq padded 4 digits
  // For example: 69 + 015 + 0001 = 690150001

  const result = await env.DB.transaction(async (tx) => {
    // Get current sequence (atomic increment)
    const stmt = await tx.prepare(
      `UPDATE counters SET current_value = current_value + 1 
       WHERE key_name = ? 
       RETURNING current_value`
    );
    const row = await stmt.bind(key).first();
    if (!row) {
      // If no row, insert with initial value 1
      await tx.prepare(
        `INSERT INTO counters (key_name, current_value, fiscal_year) VALUES (?, 1, ?)`
      ).bind(key, parseInt(fiscalYear) + 2400).run();
      // Note: fiscal_year is full year like 2569, we store it
      // but we use fiscalYearShort for key
      return 1;
    }
    return row.current_value;
  });

  const seq = result; // the returned number (1,2,3...)

  // Build register_no_raw
  const countPadded = String(count).padStart(3, '0');
  const seqPadded = String(seq).padStart(4, '0');
  const raw = `${fiscalYear}${countPadded}${seqPadded}`;
  const display = `RG${raw}`;

  return {
    raw,
    display,
    seq, // sequence number
  };
}

// Generate receive number (for each item)
export async function getNextReceiveNumbers(env, count) {
  const fiscalYear = await getFiscalYearShort(env);
  const key = `receive_${fiscalYear}`;

  // We need to reserve a block of 'count' numbers atomically
  // Use transaction to increment current_value by count and get the starting value
  const result = await env.DB.transaction(async (tx) => {
    const stmt = await tx.prepare(
      `UPDATE counters SET current_value = current_value + ? 
       WHERE key_name = ? 
       RETURNING current_value`
    );
    const row = await stmt.bind(count, key).first();
    if (!row) {
      // If no row, initialize with current_value = count, starting number is 1
      await tx.prepare(
        `INSERT INTO counters (key_name, current_value, fiscal_year) VALUES (?, ?, ?)`
      ).bind(key, count, parseInt(fiscalYear) + 2400).run();
      return 1; // starting sequence
    }
    // The returned current_value is the new max, so starting = current_value - count + 1
    return row.current_value - count + 1;
  });

  const startSeq = result;
  const numbers = [];
  for (let i = 0; i < count; i++) {
    const seq = startSeq + i;
    const seqPadded = String(seq).padStart(4, '0');
    const raw = `${fiscalYear}${seqPadded}`;
    const display = `ID${fiscalYear}-${seqPadded}`;
    numbers.push({ raw, display, seq });
  }
  return numbers;
}

// Rollback function (if something fails after reserving numbers)
// We don't decrement counter because we use skip policy: reserved numbers are skipped.
// So no need to rollback counter.
