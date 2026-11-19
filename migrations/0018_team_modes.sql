-- Two more ways a team can take part in the dashboard, both picked on the admin page:
--   teams.show_bar = 2: in the Combat scoreboard "in the middle": no kills and deaths headline of its
--     own; its deaths, and its kills of each side, sit between the two sides of the tug-of-war bar.
--     (0 is still left out, 1 still a side or a block of its own.)
--   teams.activity_with: the id of another team whose Activity charts its playtime counts in. The
--     charts then show no series for this team; its players' time is part of the other team's.
ALTER TABLE teams ADD COLUMN activity_with TEXT;
