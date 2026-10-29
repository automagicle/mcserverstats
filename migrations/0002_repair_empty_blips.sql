-- One-time repair of brief false "nobody online" readings.
-- A check that came back empty (or offline) while players' sessions continued across it
-- (they were seen again within the session gap) gets the number of players bridged across it.
-- Same rule as repairBlips() in src/poll.js.
CREATE TABLE _repair AS
SELECT ts FROM snapshots
WHERE (online = 0 OR up = 0)
  AND EXISTS (SELECT 1 FROM sessions x WHERE x.start_ts < snapshots.ts AND x.end_ts > snapshots.ts);

UPDATE snapshots
SET up = 1,
    online = (SELECT COUNT(*) FROM sessions x WHERE x.start_ts < snapshots.ts AND x.end_ts > snapshots.ts)
WHERE ts IN (SELECT ts FROM _repair);

-- Recompute just the affected hours from their snapshots.
INSERT INTO hourly (hour_ts, samples, up_samples, online_sum, peak)
SELECT ts / 3600 * 3600, COUNT(*), SUM(up), SUM(online), MAX(online)
FROM snapshots
WHERE ts / 3600 IN (SELECT DISTINCT ts / 3600 FROM _repair)
GROUP BY ts / 3600
ON CONFLICT(hour_ts) DO UPDATE SET
  samples = excluded.samples, up_samples = excluded.up_samples,
  online_sum = excluded.online_sum, peak = excluded.peak;

DROP TABLE _repair;
