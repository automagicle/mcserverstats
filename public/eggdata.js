// What each Egg SMP egg does, for the egg card on player pages: its theme, passive, and its two
// abilities with their cost (a cooldown, or mana). Taken from the egg mod's own reference
// (README.md and docs/STANDARD_EGGS.md in the Egg SMP repository; the numbers are its defaults).
// Keyed like EGGS in app.js. Loaded only when a player page shows an egg.
//
// Every egg: the primary is right-click with the egg in the offhand; the secondary is sneak +
// right-click and needs Level II (an Egg Upgrader). Energy runs 0 to 5, dying costs 1, and at 0
// the egg is Cracked (passives and abilities off).

const cd = (s) => `${s}s cooldown`;
const mana = (n) => `${n} mana`;

export const EGG_INFO = {
  life: {
    symbol: '❤', theme: 'Healing and support',
    passive: '+2 max hearts. Golden apples give double Absorption.',
    primary: { name: 'Vital Pulse', text: 'Heals you and trusted allies nearby.', cost: mana(50) },
    secondary: { name: 'Heartrend Wave', text: 'Steals max hearts from up to 4 nearby foes until you die.', cost: mana(80) },
  },
  hunger: {
    symbol: '♨', theme: 'Hunger and farming',
    passive: 'Food regenerates by itself, eating gives Absorption, and mob and crop drops are doubled.',
    primary: { name: 'Bountiful Harvest', text: 'Grows nearby crops.', cost: cd(30) },
    secondary: { name: 'Famish Beam', text: "Fills your hunger and drains the target's.", cost: cd(25) },
  },
  sky: {
    symbol: '✧', theme: '1.8 PvP and undead',
    passive: 'Every 8th melee hit heals half a heart.',
    primary: { name: '1.8 Renegade', text: 'For 15s, 1.8-style spam with a sword: no attack cooldown and every click lands, at 63% damage. Sprint-jump hits crit for +50%.', cost: cd(145) },
    secondary: { name: 'Necromancy', text: 'Raises the last 3 mobs you killed (any mob but bosses) for 75s. Like tamed wolves, they attack whatever you hit or whatever hurts you; each of their hits is capped at 4 hearts.', cost: cd(270) },
  },
  gravity: {
    symbol: '☁', theme: 'Mobility',
    passive: 'No fall damage. Hits while falling launch you (Wind Burst I).',
    primary: { name: 'Puff', text: 'A mid-air jump boost.', cost: mana(30) },
    secondary: { name: 'Anchor', text: 'Locks your height while you move.', cost: '15 mana per second' },
  },
  gambler: {
    symbol: '♦', theme: 'Luck',
    passive: 'A random potion effect every 30 seconds (mostly good, sometimes bad).',
    primary: { name: 'Russian Roulette', text: 'Your next 6 hits do 2.5x damage or nothing.', cost: cd(30) },
    secondary: { name: 'The House Always Wins', text: "Copies a nearby player's positive effects.", cost: cd(55) },
  },
  fire: {
    symbol: '☀', theme: 'Fire and artillery',
    passive: 'Fire Resistance.',
    primary: { name: 'Snuff', text: 'Your next hit strips Fire Resistance.', cost: cd(55) },
    secondary: { name: 'Meteor', text: 'A delayed fireball on your target (3 charges).', cost: '55s refill' },
  },
  blood: {
    symbol: '†', theme: 'Fight to build resource',
    passive: 'Each melee hit adds Blood (up to 25).',
    primary: { name: 'Blood Tether', text: 'Marks and tracks a player, and gives you Regeneration.', cost: cd(5) },
    secondary: { name: 'Crimson Ritual', text: 'A damaging ring around you.', cost: cd(90) },
  },
  echo: {
    symbol: '◈', theme: 'Sound and sculk',
    passive: 'Swift Sneak III.',
    primary: { name: 'Sonic Boom', text: 'True damage through walls.', cost: mana(90) },
    secondary: { name: 'Echo Fortress', text: 'A sealed sculk dome that reverts afterwards.', cost: mana(100) },
  },
  aqua: {
    symbol: '≈', theme: 'Water control',
    passive: "Water Breathing, Dolphin's Grace, Conduit Power and Aqua Affinity; an underwater double-jump dive; an emergency water shell.",
    primary: { name: 'Undertow', text: 'Drowns nearby enemies.', cost: cd(175) },
    secondary: { name: 'Riptide', text: 'The egg becomes a Riptide III trident and calls a thunderstorm.', cost: cd(40) },
  },
  meteor: {
    symbol: '★', theme: 'Marking and burst damage',
    passive: 'Extra safe fall height.',
    primary: { name: 'Flare', text: 'Highlights everyone nearby.', cost: cd(20) },
    secondary: { name: 'Impact', text: 'Charged hits become crits (+40%).', cost: cd(75) },
  },
  train: {
    symbol: '▤', theme: 'Ramming and team mobility',
    passive: 'Speed III.',
    primary: { name: 'Trainsformation', text: 'Slide as a train for 10 seconds, trampling plants and wood; ramming enemies deals 0.85x your weapon damage, scaled by speed.', cost: cd(160) },
    secondary: { name: 'Public Transit', text: 'Two pillars make a zone giving trusted players Speed II and Saturation; trains inside are twice as big and fast.', cost: cd(50) },
  },
  binding: {
    symbol: '⛓', theme: 'Chains and a timed parry',
    passive: 'Parry: raising a shield just as an axe crit or mace slam lands negates it and freezes the attacker.',
    primary: { name: 'Chain', text: '3 charges: a block pulls you to it, a creature is pulled to you.', cost: '55s refill' },
    secondary: { name: 'Lifesteal Lockbolt', text: 'The target is held nearby, and part of the damage you deal them heals you.', cost: cd(55) },
  },
  murica: {
    symbol: '✸', theme: 'Bows and fireworks',
    passive: 'Infinity on bows and crossbows.',
    primary: { name: 'Lock and Load', text: 'Quick Charge 65 for 10 seconds on a crossbow you hold (cast it with a sword in your main hand).', cost: cd(90) },
    secondary: { name: 'Salute', text: 'Projectiles burst as a large firework that splashes for 1.7x what the hit dealt, as true damage.', cost: cd(300) },
  },
  dung: {
    symbol: '●', theme: 'Stink and traps',
    passive: 'Fertilizer (nearby plants grow much faster) and Stench (wild hostile mobs ignore you unless you hit them). Level II: immune to Nausea and Hunger.',
    primary: { name: 'Stink Bomb', text: 'A cloud where you look gives enemies Nausea, Weakness and Slowness.', cost: cd(105) },
    secondary: { name: 'Landmine', text: 'A poop pile that launches and poisons whoever steps in it (3 at once).', cost: cd(19) },
  },
  woods: {
    symbol: '☘', theme: 'Leather and moss',
    passive: 'Resistance III, Haste II and Speed I while wearing a full set of leather armor.',
    primary: { name: 'Snare', text: "A beam that gives Slowness X for 4 seconds and locks the hotbar slot a player is holding for 15.", cost: cd(60) },
    secondary: { name: 'Grove', text: 'The ground within 8 blocks turns to moss for 10 seconds: Regeneration II for you, Slowness and Nausea for others.', cost: cd(300) },
  },
  smite: {
    symbol: '⚡', theme: 'Guardian laser',
    passive: 'Haste II, and immune to Mining Fatigue.',
    primary: { name: 'Smite', text: 'A guardian laser locks the nearest enemy within 15 blocks; after 3 seconds in sight it deals 3 hearts of true damage and Slowness III.', cost: cd(60) },
    secondary: { name: 'Thorns', text: 'For 5 seconds, a player who hits you takes 35% of that damage back.', cost: cd(60) },
  },
  stash: {
    symbol: '❒', theme: 'Villager prices and a spare inventory',
    passive: 'Hero of the Village II, and double experience from trading, smelting and mining ores.',
    primary: null,
    secondary: { name: 'Hidden Inventory', text: 'Swaps your 27 storage slots with one saved set (the hotbar stays). Dying drops both.', cost: cd(30) },
  },
  sulfur: {
    symbol: '▲', theme: 'Cave dweller of the sulfur caves',
    passive: 'Depth Strider; you walk on water (sneak to sink); no extra dripstone fall damage and half damage from falling dripstone.',
    primary: { name: 'Cube Conundrum', text: 'Absorbs placed blocks of the kind you hold for 5 seconds.', cost: cd(30) },
    secondary: { name: 'Collective Cage', text: 'A 30-second sulfur dome; spikes fall on any other player (trusted ones too) within 6 blocks. Sneak + right-click ends it early.', cost: cd(235) },
  },
  subzero: {
    symbol: '❄', theme: 'Frost-controlling duelist',
    passive: '50% knockback resistance.',
    primary: { name: 'Frost Wave', text: 'Pulls in enemies within 10 blocks and freezes them for 4.5 seconds.', cost: cd(80) },
    secondary: { name: 'Frostbound Swap', text: 'Swaps places with an enemy player, and back after 10 seconds or on recast.', cost: cd(150) },
  },
  combo: {
    symbol: '✱', theme: 'Climbing crits',
    passive: 'Melee crits deal 110% of a normal hit, +10% per crit within a second, up to 170% (instead of the usual 150%).',
    primary: { name: 'Full-Crit', text: 'Your next 30 melee hits are crits, each giving the target Slowness III for a second.', cost: cd(75) },
    secondary: { name: 'Combo Zone', text: 'A 10-block circle follows you for 35 seconds: Slowness I, no block placing, webs and lava deleted.', cost: cd(50) },
  },
  electric: {
    symbol: 'ϟ', theme: 'Living circuit: mark, then spend',
    passive: 'Electrified while sneaking (2x mana regeneration); Electrified hits Mark the target and give mana; melee attackers are zapped; +50% Electric damage on wet targets.',
    primary: { name: 'Circuit', text: 'Four modes: Resistor dash, Capacitor lightning on Marks, Inductor swap with a Mark, Memristor copies a Marked player\'s last primary.', cost: 'mana and a cooldown per mode' },
    secondary: { name: 'Faraday Zone', text: 'A glass sphere for 19 seconds: enemies inside are Marked and your max mana is 200.', cost: cd(290) },
  },
  deadshot: {
    symbol: '⌖', theme: 'Rhythmic long-range sniper',
    passive: 'Metronome: shots on the beat build Rhythm, off-beat shots reset it. Hits from 30+ blocks make the target glow.',
    primary: { name: 'Cadence', text: 'A homing arrow fired from the egg at the enemy you aim at; stronger with Rhythm and distance.', cost: '16s reload' },
    secondary: { name: 'Dead Eye', text: 'Marks an enemy for 10 seconds: a faster beat, free shots that chase the Mark, and a 4.7x Deadshot at max Rhythm.', cost: cd(80) },
  },
  purpur: {
    symbol: '❖', theme: 'Shulker flier',
    passive: 'Shulker Wings: the egg is an elytra in the offhand that never breaks. Firework rockets do not boost it.',
    primary: { name: 'Speed Suppression', text: 'Trusted players nearby get +67% speed; enemies within 10 blocks get Levitation.', cost: cd(45) },
    secondary: { name: 'Quick Dash', text: '20 blocks per second along the ground for 2 seconds, then Speed II and Regeneration II. Not usable within 15 seconds of hitting a player.', cost: cd(30) },
  },
  doggo: {
    symbol: '✿', theme: 'Dog person',
    passive: 'Wolf Armor: your tamed dogs within 48 blocks get wolf armor (once each) and never despawn.',
    primary: { name: 'Pack Call', text: 'Summons 3 tamed dogs in wolf armor that fight for you and stay as pets, up to 6 out at once.', cost: cd(300) },
    secondary: { name: 'Pack Mend', text: 'Heals your tamed dogs within 48 blocks to full and repairs or replaces their wolf armor.', cost: cd(900) },
  },
  wizard: {
    symbol: '✦', theme: 'Spellcasting',
    passive: '1.5x mana regeneration (2x at Level II). Its spells take at most 6 hearts off a player at once.',
    primary: { name: 'Spellcasting', text: 'Casts the selected spell with the Wizard Egg in the main hand and the Witch Egg in the offhand.', cost: 'mana per spell' },
    secondary: { name: 'Quick Cast', text: 'Four chosen spells on attack and use, with the Witch Egg in the main hand.', cost: 'mana per spell', always: true },
  },
  redstone: {
    symbol: '◉', theme: 'Redstone shop',
    passive: 'Redstone Shop: sneak + use opens it, to buy redstone parts with Redstone Dust and trade materials in.',
    primary: { name: 'Remote Trigger', text: 'Right-click the egg to flip your armed trigger lever from anywhere.', cost: null },
    secondary: null,
  },
  fat: {
    symbol: '♣', theme: 'Hoarding materials',
    passive: 'Each full stack (64) of a material in your inventory gives its power. Coal smelts ores as you mine, Iron stops pickaxes breaking, Gold gives Haste II. Level II adds Lapis, Quartz, Diamond and Netherite Scrap powers.',
    primary: null,
    secondary: null,
  },
};
