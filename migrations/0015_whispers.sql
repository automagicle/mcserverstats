-- Private messages (/w, /msg, /tell) that involve someone on the dashboard: sent from the website, or
-- sent in game to a player who's only on the website (src/whisper.js). Whispers between two players
-- in game never come here. Only the two people in one can read it back.
CREATE TABLE whispers (
  id      INTEGER PRIMARY KEY,
  ts_ms   INTEGER NOT NULL,
  sender  TEXT NOT NULL COLLATE NOCASE,  -- an IGN, or '@admin' for an admin sending without a player name
  target  TEXT NOT NULL COLLATE NOCASE,  -- an IGN
  text    TEXT NOT NULL,
  via     TEXT NOT NULL                  -- 'web': typed on the dashboard; 'game': typed in game
);
CREATE INDEX whispers_sender ON whispers (sender, ts_ms);
CREATE INDEX whispers_target ON whispers (target, ts_ms);
