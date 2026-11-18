// Slow figures kept for a while (the cache table), so a page refreshing every minute reads one row
// instead of working them out again. Without the table (or on any error) it just works them out.
export async function cached(db, key, ttlSeconds, compute) {
  const now = Math.floor(Date.now() / 1000);
  const row = await db.prepare('SELECT ts, value FROM cache WHERE key = ?').bind(key).first().catch(() => null);
  if (row && now - row.ts < ttlSeconds) {
    try { return JSON.parse(row.value); } catch { /* work it out again */ }
  }
  const value = await compute();
  await db.prepare('INSERT INTO cache (key, ts, value) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET ts = excluded.ts, value = excluded.value')
    .bind(key, now, JSON.stringify(value)).run().catch(() => {});
  return value;
}

// After a change that alters them (hiding a player, merging accounts, filling a gap).
export const clearCache = (db) => db.prepare('DELETE FROM cache').run().catch(() => {});
