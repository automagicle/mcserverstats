-- Players left out of the dashboard's Activity and Combat pages as if they had never been on: their
-- playtime, their place in player counts and lists, their page, their deaths. Names are matched
-- without regard to case. It applies to everything already recorded (the Worker leaves them out when
-- it reads, src/hidden.js), and nothing more is recorded for them while they're listed. The chat log
-- is not affected. Nothing is deleted: take a name off the list and what was recorded shows again.
--   npx wrangler d1 execute mcstats --remote --command "INSERT OR IGNORE INTO hidden_players (name, note) VALUES ('Name', 'why')"
--   npx wrangler d1 execute mcstats --remote --command "DELETE FROM hidden_players WHERE name = 'Name'"
CREATE TABLE hidden_players (
  name TEXT PRIMARY KEY COLLATE NOCASE,
  note TEXT
);

INSERT INTO hidden_players (name, note) VALUES ('Monday_Maniac', 'not a real player on the server');
