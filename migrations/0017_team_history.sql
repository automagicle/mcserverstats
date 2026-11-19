-- A player's earlier teams, for a team change that only counts from then on (the admin page's
-- "from now on" option): before `until` they were on `team`. The roster table still has the team
-- they're on now. What happened before the switch (playtime in the by-team charts, kills and deaths
-- on the Combat page) stays with the team they were on at the time.
CREATE TABLE team_history (
  season INTEGER NOT NULL,
  ign    TEXT NOT NULL COLLATE NOCASE,
  until  INTEGER NOT NULL,   -- unix seconds: on `team` before this
  team   TEXT NOT NULL,
  PRIMARY KEY (season, ign, until)
);
