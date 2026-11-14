// Kills and deaths, for the Combat page and the combat part of player pages.
//
// Every death message the mod logs also gets a row in `deaths` saying who died, who the game
// credits with it (another player, or a creature), and how. The mod (1.4.0 or newer) sends that
// with the message; for messages from older versions, and the ones logged before this table
// existed, it's worked out here from the message itself: the styled text marks every player it
// names, and the wording says how it happened.

import { json } from './util.js';

const NAME_RE = /^[A-Za-z0-9_.]{1,20}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_RE = /^death\.[A-Za-z0-9_.]{1,80}$/;
const MOB_RE = /^[a-z0-9_.:-]{1,64}$/;

// The game's damage types (death.attack.<type>…), grouped into the causes the dashboard shows.
const BY_TYPE = {
  player: 'melee', mob: 'melee', sting: 'melee', mace_smash: 'melee', spear: 'melee',
  arrow: 'shot', trident: 'shot', thrown: 'shot', fireball: 'shot', witherSkull: 'shot',
  explosion: 'explosion', fireworks: 'explosion', badRespawnPoint: 'explosion',
  fall: 'fall', flyIntoWall: 'fall', stalagmite: 'fall',
  inFire: 'fire', onFire: 'fire', hotFloor: 'fire',
  lava: 'lava',
  drown: 'drown', dryout: 'drown',
  outOfWorld: 'void', outsideBorder: 'void',
  magic: 'magic', indirectMagic: 'magic', even_more_magic: 'magic', dragonBreath: 'magic',
  wither: 'wither', sonic_boom: 'sonic', lightningBolt: 'lightning',
  anvil: 'crush', fallingBlock: 'crush', fallingStalactite: 'crush', cramming: 'crush',
  inWall: 'suffocation', starve: 'starve', freeze: 'freeze',
  cactus: 'thorns', sweetBerryBush: 'thorns', thorns: 'thorns',
};
export const CAUSES = new Set([...Object.values(BY_TYPE), 'other']);

function causeFromKey(key) {
  if (key.startsWith('death.fell.')) return 'fall';
  const type = /^death\.attack\.([A-Za-z_]+)/.exec(key)?.[1];
  return BY_TYPE[type] || 'other';
}

// The same, from the English wording (messages logged without their key).
const BY_WORDING = [
  [/fell out of the world|didn't want to live in the same world|left the confines of this world/, 'void'],
  [/hit the ground too hard|fell (from|off|while|too far)|was doomed to fall|experienced kinetic energy|impaled on a stalagmite/, 'fall'],
  [/tried to swim in lava/, 'lava'],
  [/went up in flames|burned to death|walked into fire|burnt to a crisp|danger zone|floor was lava/, 'fire'],
  [/drowned|died from dehydration/, 'drown'],
  [/blew up|was blown up|went off with a bang|Intentional Game Design/, 'explosion'],
  [/was shot by|was impaled by|was pummeled by|was fireballed by/, 'shot'],
  [/struck by lightning/, 'lightning'],
  [/withered away/, 'wither'],
  [/sonically-charged shriek/, 'sonic'],
  [/killed by magic|using magic|even more magic|dragon's breath/, 'magic'],
  [/suffocated in a wall/, 'suffocation'],
  [/was squashed|was squished|skewered by a falling/, 'crush'],
  [/starved to death/, 'starve'],
  [/pricked to death|poked to death|walked into a cactus|trying to hurt/, 'thorns'],
  [/froze to death|frozen to death/, 'freeze'],
  [/was slain by|stung to death|was smashed by|was speared by/, 'melee'],
];
const causeFromText = (text) => BY_WORDING.find(([re]) => re.test(text))?.[1] || 'other';

const same = (a, b) => a.toLowerCase() === b.toLowerCase();

// Who and how, for one death message.
//   m: { name (the victim), text, rich?: [{ t, c?, p? }] (parsed), death?: the mod's { cause, killer?, killer_uuid?, mob?, weapon? } }
//   names: every known player name, to find a killer in messages logged without styling (optional)
// -> { killer, killer_uuid, mob, cause, weapon } (null where unknown; cause is always set)
export function describeDeath(m, names = null) {
  const d = m.death && typeof m.death === 'object' ? m.death : null;
  const text = String(m.text || '');
  let killer = null, killerUuid = null, mob = null, weapon = null;
  let cause = d && typeof d.cause === 'string' && KEY_RE.test(d.cause) ? causeFromKey(d.cause) : causeFromText(text);

  if (d) {
    if (typeof d.killer === 'string' && NAME_RE.test(d.killer)) killer = d.killer;
    if (killer && typeof d.killer_uuid === 'string' && UUID_RE.test(d.killer_uuid)) killerUuid = d.killer_uuid.toLowerCase();
    if (!killer && typeof d.mob === 'string' && MOB_RE.test(d.mob)) mob = d.mob;
    if (typeof d.weapon === 'string') weapon = d.weapon.replace(/[\u0000-\u001f\u007f]|§./g, '').trim().slice(0, 60) || null;
  } else {
    // every player a styled message names is marked; the first one who isn't the victim did it
    const named = Array.isArray(m.rich) ? m.rich.find((p) => p && typeof p.p === 'string' && NAME_RE.test(p.p) && !same(p.p, m.name)) : null;
    if (named) killer = named.p;
    else if (!Array.isArray(m.rich) && names) {
      const rest = ` ${text.replace(/[^A-Za-z0-9_. ]/g, ' ')} `;
      killer = names.find((n) => !same(n, m.name) && rest.includes(` ${n} `)) || null;
    }
    weapon = / using (.+)$/.exec(text)?.[1].replace(/^\[|\]$/g, '').slice(0, 60) || null;
    if (!killer) {
      // "was slain by Wither Skeleton", "… whilst trying to escape Zombie"
      const by = /(?: by| escape| fighting) ((?:[A-Z][A-Za-z']+)(?: [A-Z][A-Za-z']+){0,2})(?: using .+)?$/.exec(text)?.[1];
      if (by && !same(by, m.name)) mob = by.toLowerCase().replace(/[^a-z]+/g, '_');
    }
  }
  if (killer && same(killer, m.name)) { killer = null; killerUuid = null; } // their own arrow, their own TNT
  return { killer, killer_uuid: killerUuid, mob, cause, weapon };
}

// The statement that records a just-logged death message (by its event id) in `deaths`.
export function deathInsert(db, eventId, m) {
  const d = describeDeath(m);
  return db.prepare(
    `INSERT OR IGNORE INTO deaths (id, ts_ms, victim, victim_uuid, killer, killer_uuid, mob, cause, weapon)
     SELECT id, ts_ms, name, uuid, ?2,
            COALESCE(?3, (SELECT uuid FROM players WHERE name = ?2 COLLATE NOCASE ORDER BY first_seen DESC LIMIT 1)),
            ?4, ?5, ?6
     FROM chat WHERE event_id = ?1 AND kind = 'death' AND name IS NOT NULL`
  ).bind(eventId, d.killer, d.killer_uuid, d.mob, d.cause, d.weapon);
}

// Deaths copied in from the chat log before this table existed still need their killer and cause.
// Done a few hundred at a time, whenever combat data is asked for, until none are left.
async function describePending(db) {
  for (let round = 0; round < 8; round++) {
    const { results } = await db.prepare(
      `SELECT d.id, d.victim, c.text, c.rich FROM deaths d JOIN chat c ON c.id = d.id WHERE d.cause IS NULL LIMIT 250`
    ).all();
    if (!results.length) return;
    let names = null;
    if (results.some((r) => !r.rich)) {
      names = (await db.prepare('SELECT name FROM players').all()).results.map((r) => r.name).filter((n) => NAME_RE.test(n));
    }
    const stmt = db.prepare(
      `UPDATE deaths SET killer = ?2, mob = ?3, cause = ?4, weapon = ?5,
              killer_uuid = (SELECT uuid FROM players WHERE name = ?2 COLLATE NOCASE ORDER BY first_seen DESC LIMIT 1)
       WHERE id = ?1`
    );
    await db.batch(results.map((r) => {
      let rich = null;
      try { rich = r.rich ? JSON.parse(r.rich) : null; } catch {}
      const d = describeDeath({ name: r.victim, text: r.text, rich }, names);
      return stmt.bind(r.id, d.killer, d.mob, d.cause, d.weapon);
    }));
    if (results.length < 250) return;
  }
}

// GET /api/combat[?after=ID] — every death in the season, oldest first, as compact rows
// [id, ts (unix seconds), victim, killer or null, cause, mob or null], plus the uuid of each player
// named (by lowercased name) when it's known. after=ID gives only deaths logged since that id.
export async function combatData(env, url, season) {
  const db = env.DB;
  await describePending(db);
  const after = Math.max(0, Math.floor(Number(url.searchParams.get('after'))) || 0);
  const rows = await db.prepare(
    `SELECT id, ts_ms, victim, victim_uuid, killer, killer_uuid, cause, mob FROM deaths
     WHERE ts_ms >= ? AND ts_ms < ? AND id > ? ORDER BY ts_ms, id LIMIT 50000`
  ).bind(season.lo * 1000, season.hi * 1000, after).raw();
  const uuids = {};
  let maxId = after;
  const out = rows.map(([id, ts, victim, victimUuid, killer, killerUuid, cause, mob]) => {
    if (victimUuid) uuids[victim.toLowerCase()] = victimUuid;
    if (killer && killerUuid) uuids[killer.toLowerCase()] = killerUuid;
    if (id > maxId) maxId = id;
    return [id, Math.floor(ts / 1000), victim, killer, cause || 'other', mob];
  });
  return json({ cols: ['id', 'ts', 'victim', 'killer', 'cause', 'mob'], rows: out, uuids, max_id: maxId });
}

// GET /api/combat/log — death messages, newest first, `limit` at a time, as the chat log gives them
// (with their styled text) plus killer, cause and mob:
//   player=NAME     only deaths of, or kills by, this player
//   type=pvp|other  only deaths by another player's hand, or only the rest
//   before=TS:ID    the next page          after=TS:ID  only newer ones (live updates)
export async function combatLog(env, url, season) {
  const q = url.searchParams;
  const limit = Math.min(100, Math.max(1, Math.floor(Number(q.get('limit'))) || 40));
  const where = ['d.ts_ms >= ?', 'd.ts_ms < ?'];
  const args = [season.lo * 1000, season.hi * 1000];
  const player = q.get('player');
  if (player) {
    if (!NAME_RE.test(player)) return json({ error: 'bad name' }, 400);
    where.push('(d.victim = ? OR d.killer = ?)');
    args.push(player, player);
  }
  if (q.get('type') === 'pvp') where.push('d.killer IS NOT NULL');
  else if (q.get('type') === 'other') where.push('d.killer IS NULL');
  for (const [key, cmp] of [['before', '<'], ['after', '>']]) {
    if (!q.has(key)) continue;
    const c = /^(\d+):(\d+)$/.exec(q.get(key));
    if (!c) return json({ error: 'bad cursor' }, 400);
    where.push(`(d.ts_ms ${cmp} ? OR (d.ts_ms = ? AND d.id ${cmp} ?))`);
    args.push(Number(c[1]), Number(c[1]), Number(c[2]));
  }
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.ts_ms AS ts, c.kind, c.uuid, c.name, c.text, c.display, c.rich, d.killer, d.cause, d.mob
     FROM deaths d JOIN chat c ON c.id = d.id
     WHERE ${where.join(' AND ')} ORDER BY d.ts_ms DESC, d.id DESC LIMIT ?`
  ).bind(...args, limit + 1).all();
  const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
  return json({
    results: results.slice(0, limit).map((r) => ({ ...r, display: parse(r.display), rich: parse(r.rich) })),
    more: results.length > limit,
  });
}
