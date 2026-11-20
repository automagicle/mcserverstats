-- 1 when an admin attributed a death and chose to show "(by name)" after its message in the logs.
ALTER TABLE deaths ADD COLUMN attr_note INTEGER NOT NULL DEFAULT 0;
