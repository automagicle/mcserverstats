-- One row per death message, with who (or what) did it worked out, for the Combat page.
-- New deaths are filled in as the mod reports them (src/combat.js). The ones already in the chat
-- log are copied here bare; the Worker works out their killer and cause the first time the
-- Combat page is opened (cause stays NULL until then).
CREATE TABLE deaths (
  id          INTEGER PRIMARY KEY,           -- the death message's row in chat
  ts_ms       INTEGER NOT NULL,
  victim      TEXT NOT NULL COLLATE NOCASE,
  victim_uuid TEXT,
  killer      TEXT COLLATE NOCASE,           -- the player the game credits with it, if any
  killer_uuid TEXT,
  mob         TEXT,                          -- a creature that did it, as its entity type ("zombie")
  cause       TEXT,                          -- melee, shot, fall, lava, … (see CAUSES in src/combat.js)
  weapon      TEXT                           -- the named item it was done with, when the message says
);
CREATE INDEX deaths_ts ON deaths(ts_ms);
CREATE INDEX deaths_todo ON deaths(id) WHERE cause IS NULL;

INSERT INTO deaths (id, ts_ms, victim, victim_uuid)
SELECT id, ts_ms, name, uuid FROM chat WHERE kind = 'death' AND name IS NOT NULL;
