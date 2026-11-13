-- Who may send chat from the dashboard: each player's login emails for a season (a player can have
-- several). Filled from the private roster-s<n>.json by `npm run roster:remote`, like the roster.
CREATE TABLE roster_email (
  season INTEGER NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  ign TEXT NOT NULL COLLATE NOCASE,
  PRIMARY KEY (season, email)
);
-- 'web' for messages sent from the dashboard (the mod posts them in game and logs them here).
ALTER TABLE chat ADD COLUMN via TEXT;
