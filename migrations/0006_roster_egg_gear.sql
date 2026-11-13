-- Each player's egg for the season (an Egg SMP egg id like "gravity"), shown on their page.
ALTER TABLE roster ADD COLUMN egg TEXT;

-- What each player last had on: armor, held items, and the weapons, tools and eggs in their
-- inventory, as the server mod reports it (JSON). Keyed by name, as the rest of the dashboard is.
CREATE TABLE gear (
  name TEXT PRIMARY KEY COLLATE NOCASE,
  uuid TEXT,
  ts INTEGER NOT NULL,
  data TEXT NOT NULL
);
