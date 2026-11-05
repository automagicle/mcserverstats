-- Each season's teams and players' real names. Filled from a private roster-s<n>.json with
-- `npm run roster:remote` (see README), so the names stay out of this public repository.
CREATE TABLE roster (
  season INTEGER NOT NULL,
  ign TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL,
  team TEXT NOT NULL,
  PRIMARY KEY (season, ign)
);
