-- Public chat and server messages, sent in by the mcstats-chat server mod.
CREATE TABLE chat (
  id        INTEGER PRIMARY KEY,
  event_id  TEXT NOT NULL UNIQUE,   -- set by the mod, so a retried batch isn't stored twice
  ts_ms     INTEGER NOT NULL,       -- unix milliseconds, when the server saw it
  kind      TEXT NOT NULL,          -- chat, emote, say, join, leave, death, advancement, server, system
  uuid      TEXT,                   -- the player it's from or about, when known
  name      TEXT,
  display   TEXT,                   -- the name as chat shows it: JSON [{ t, c? }] with team prefix and colors
  text      TEXT NOT NULL
);
CREATE INDEX chat_ts ON chat(ts_ms, id);
