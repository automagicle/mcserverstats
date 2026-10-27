-- One row per successful check (every minute).
CREATE TABLE snapshots (
  ts      INTEGER PRIMARY KEY,   -- unix seconds, floored to the minute
  up      INTEGER NOT NULL,      -- 1 if the server was online
  online  INTEGER NOT NULL,      -- player count reported by the server
  max     INTEGER,
  listed  INTEGER NOT NULL       -- how many names the server actually listed
);

-- Rolled up per hour, for long-range charts and heatmaps without reading every minute.
-- Pacific Time offsets are whole hours, so UTC hours line up with local hours.
CREATE TABLE hourly (
  hour_ts     INTEGER PRIMARY KEY,
  samples     INTEGER NOT NULL,
  up_samples  INTEGER NOT NULL,
  online_sum  INTEGER NOT NULL,  -- sum of per-minute counts = player-minutes
  peak        INTEGER NOT NULL
);

CREATE TABLE players (
  uuid        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  first_seen  INTEGER NOT NULL
);

-- A continuous stretch of a player being seen online.
-- Time played = end_ts - start_ts + one poll interval.
CREATE TABLE sessions (
  id        INTEGER PRIMARY KEY,
  uuid      TEXT NOT NULL,
  start_ts  INTEGER NOT NULL,
  end_ts    INTEGER NOT NULL
);
CREATE INDEX sessions_end ON sessions(end_ts);
CREATE INDEX sessions_uuid ON sessions(uuid, start_ts);
