-- Deaths to the world border ("left the confines of this world") get their own cause, so the Combat
-- page can leave out the ones no player caused (src/combat.js). Nothing is deleted.
UPDATE deaths SET cause = 'border'
WHERE id IN (SELECT id FROM chat WHERE kind = 'death' AND text LIKE '%left the confines of this world%');
