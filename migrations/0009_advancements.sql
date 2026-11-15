-- The advancements screen as the game lays it out (every advancement with its title, icon, frame,
-- parent and position), as the server mod reports it when the server starts (JSON). One row.
CREATE TABLE advancement_tree (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  ts   INTEGER NOT NULL,
  data TEXT NOT NULL
);

-- Each player's advancement progress as the mod last reported it (JSON): which they have and when,
-- and for the ones they're partway through, how far and which criteria are done.
-- Keyed by name, as gear is.
CREATE TABLE advancements (
  name TEXT PRIMARY KEY COLLATE NOCASE,
  uuid TEXT,
  ts   INTEGER NOT NULL,
  data TEXT NOT NULL
);
