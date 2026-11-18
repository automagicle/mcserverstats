-- The admin page (src/admin.js).

-- Chat lines an admin deleted: the whole row (and its death, if it was one) kept as JSON so it can be
-- put back. The mod may resend a line it isn't sure was received; its event_id here keeps it out.
CREATE TABLE deleted_chat (
  event_id   TEXT PRIMARY KEY,
  id         INTEGER NOT NULL,
  ts_ms      INTEGER NOT NULL,
  deleted_at INTEGER NOT NULL,
  chat       TEXT NOT NULL,
  death      TEXT
);

-- 1 for a death an admin left out of the Combat page (it stays in the chat log).
ALTER TABLE deaths ADD COLUMN uncounted INTEGER NOT NULL DEFAULT 0;

-- Season totals that are slow to work out (every session and hour of the season) but change slowly,
-- kept for a few minutes so each page refresh reads one row instead (src/cache.js).
CREATE TABLE cache (
  key   TEXT PRIMARY KEY,
  ts    INTEGER NOT NULL,
  value TEXT NOT NULL
);

-- The latest "Server started/stopped" line (every status refresh) without reading all the chat since.
CREATE INDEX chat_kind ON chat(kind, ts_ms);
