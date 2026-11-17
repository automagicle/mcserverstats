-- Accounts that belong to the same person: each alias (another account's name) is shown as, and counted
-- together with, the name it points to, on every page: playtime, player lists, the player page (both
-- accounts' sessions, chat, gear and advancements), Combat and team colors. It applies to everything already
-- recorded (the Worker merges them when it reads, src/aliases.js). Nothing is changed or deleted: take the
-- row out and the accounts show apart again. Chat log messages still show the name they were sent under.
--   npx wrangler d1 execute mcstats --remote --command "INSERT OR REPLACE INTO player_aliases (alias, name) VALUES ('OldName', 'MainName')"
--   npx wrangler d1 execute mcstats --remote --command "DELETE FROM player_aliases WHERE alias = 'OldName'"
CREATE TABLE player_aliases (
  alias TEXT PRIMARY KEY COLLATE NOCASE,  -- the other account's name
  name  TEXT NOT NULL COLLATE NOCASE      -- the name to show it as (the main account)
);

INSERT INTO player_aliases (alias, name) VALUES ('GusDaGoat', 'Gusthegoat');
