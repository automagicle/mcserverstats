-- Who the server mod (1.7.0 or newer) last said is online: everyone in the tab list, which the
-- server-list ping the minute-by-minute check uses can leave out. One row, replaced at each report
-- (about every 20 seconds while the server runs); src/poll.js adds its players to what the ping lists.
CREATE TABLE server_online (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  ts       INTEGER NOT NULL,   -- when the Worker received it (unix seconds, the Worker's clock)
  players  TEXT NOT NULL,      -- JSON [{ uuid, name }]
  stopping INTEGER NOT NULL DEFAULT 0  -- 1: the server was shutting down
);
