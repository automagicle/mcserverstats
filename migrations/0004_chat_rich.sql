-- The whole message as the game shows it (other players' names, item names, colors), for
-- deaths, advancements, joins and leaves: JSON [{ t, c?, p? }], p = the player a piece names.
ALTER TABLE chat ADD COLUMN rich TEXT;
-- A player's messages, for their page, the player card and search by player.
CREATE INDEX chat_uuid ON chat(uuid, ts_ms);
