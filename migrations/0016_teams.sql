-- Each season's teams, edited on the admin page (src/admin.js): what they're called, their color, the
-- order they're listed and stacked in, and how much of the dashboard each one is part of. The roster
-- table says which team a player is on (roster.team = teams.id).
CREATE TABLE teams (
  season        INTEGER NOT NULL,
  id            TEXT NOT NULL,     -- as in roster.team: lowercase letters, digits, dashes
  name          TEXT NOT NULL,     -- "Red Faction"
  short         TEXT NOT NULL,     -- "Red"
  color         TEXT NOT NULL,     -- #rrggbb, on a light page
  color_dark    TEXT,              -- on a dark page; worked out from color when not set
  sort          INTEGER NOT NULL DEFAULT 0,
  show_bar      INTEGER NOT NULL DEFAULT 1,  -- in the Combat page's scoreboard bar
  show_chart    INTEGER NOT NULL DEFAULT 1,  -- its kills as their own series in the Combat chart
  show_activity INTEGER NOT NULL DEFAULT 1,  -- in the Activity page's by-team charts
  PRIMARY KEY (season, id)
);

-- The two there have been so far, as they've looked; then any other team a roster already names.
INSERT INTO teams (season, id, name, short, color, color_dark, sort)
  SELECT season, 'red', 'Red Faction', 'Red', '#c42f2a', '#f27a72', 0 FROM roster WHERE team = 'red' GROUP BY season;
INSERT INTO teams (season, id, name, short, color, color_dark, sort)
  SELECT season, 'blue', 'Blue Faction', 'Blue', '#1d5fc4', '#6ea8f5', 1 FROM roster WHERE team = 'blue' GROUP BY season;
INSERT INTO teams (season, id, name, short, color, sort)
  SELECT season, team, upper(substr(team, 1, 1)) || substr(team, 2), upper(substr(team, 1, 1)) || substr(team, 2), '#7a7f87', 2
  FROM roster WHERE team NOT IN ('red', 'blue') GROUP BY season, team;
