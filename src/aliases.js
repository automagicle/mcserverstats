// Player aliases (the player_aliases table): another account's name that belongs to the same person.
// Everything recorded under an alias is shown as, and counted with, the name it points to. Nothing is
// rewritten; the accounts are merged here when the data is read.

// SQL: the name to show for the player name in `col`.
export const canonName = (col) => `COALESCE((SELECT pa.name FROM player_aliases pa WHERE pa.alias = ${col}), ${col})`;

// SQL: the uuid to link to for that player: the main account's, when the name is an alias and it has one.
export const canonUuid = (nameCol, uuidCol) =>
  `COALESCE((SELECT p2.uuid FROM player_aliases pa JOIN players p2 ON pa.name = p2.name
             WHERE pa.alias = ${nameCol} ORDER BY p2.first_seen DESC LIMIT 1), ${uuidCol})`;

// Every account of the player with this uuid (or name): { name, uuid, first_seen, uuids, names }, where name
// and uuid are the main account's. null if there's no such player.
export async function playerGroup(db, { uuid = null, name = null }) {
  if (uuid) name = (await db.prepare('SELECT name FROM players WHERE uuid = ?').bind(uuid).first())?.name;
  if (!name) return null;
  const main = (await db.prepare('SELECT name FROM player_aliases WHERE alias = ?').bind(name).first())?.name || name;
  const { results } = await db.prepare(
    `SELECT uuid, name, first_seen FROM players p
     WHERE p.name = ?1 COLLATE NOCASE OR EXISTS (SELECT 1 FROM player_aliases pa WHERE pa.name = ?1 AND pa.alias = p.name)
     ORDER BY first_seen`
  ).bind(main).all();
  if (!results.length) return null;
  const own = results.filter((r) => r.name.toLowerCase() === main.toLowerCase()).pop() || results[results.length - 1];
  return {
    name: own.name.toLowerCase() === main.toLowerCase() ? own.name : main,
    uuid: own.uuid,
    first_seen: results[0].first_seen,
    uuids: results.map((r) => r.uuid),
    names: [...new Set([main, ...results.map((r) => r.name)])],
  };
}

export const marks = (list) => list.map(() => '?').join(', ');
