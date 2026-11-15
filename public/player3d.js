// A player drawn in 3D the way the game draws them: their skin, the armor they wear (with trims,
// leather dye and the enchantment shimmer), their best weapon in the main hand and their egg in the
// off hand with its particle aura. The model turns a little toward the mouse, and the head follows
// it a bit more.
//
// Textures come from /api/mc/… (the game's own, for the server's version) and /api/skin/<name>.
// Loaded on demand by app.js: mountPlayer(container, { name, uuid?, armor, mainhand?, offhand?, aura?: { id, cracked }, signal? })
// -> { dispose() }. Items are as the server mod reports them (see src/gear.js).

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.min.js';

const TEX = (path) => `/api/mc/textures/${path}.png`;
const BASE_YAW = 0.42; // turned a little to show the weapon side
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- images ---------- */

const images = new Map();
function loadImage(url) {
  if (!images.has(url)) {
    images.set(url, new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    }));
  }
  return images.get(url);
}

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function pixelTexture(source) {
  const t = new THREE.CanvasTexture(source);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ---------- skin ---------- */

// The skin as the game prepares it: a 64×64 sheet whose base layer is fully opaque (only the outer
// layer has see-through pixels). Old 64×32 skins keep their size; their left limbs mirror the right.
async function loadSkin(name, uuid) {
  let model = 'classic';
  let img = null;
  try {
    const res = await fetch(`/api/skin/${encodeURIComponent(name)}${uuid ? `?uuid=${uuid}` : ''}`);
    if (res.ok) {
      model = res.headers.get('X-Skin-Model') || 'unknown';
      const url = URL.createObjectURL(await res.blob());
      img = await loadImage(url);
    }
  } catch { /* the default skin below */ }
  if (!img || img.width !== 64 || (img.height !== 64 && img.height !== 32)) {
    img = await loadImage(TEX('entity/player/wide/steve'));
    model = 'classic';
  }
  const c = canvas(64, img.height);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const data = g.getImageData(0, 0, 64, img.height);
  const px = data.data;
  const alpha = (x, y) => px[(y * 64 + x) * 4 + 3];
  const opaque = (x0, y0, x1, y1) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) px[(y * 64 + x) * 4 + 3] = 255;
  };
  if (model === 'unknown') {
    // Slim skins leave the outer column of each arm's front empty.
    let empty = true;
    if (img.height === 64) for (let y = 20; y < 32 && empty; y++) if (alpha(54, y) || alpha(55, y)) empty = false;
    model = img.height === 64 && empty ? 'slim' : 'classic';
  }
  if (img.height === 32) {
    // The old "hat" trick: a hat layer with no see-through pixel at all is ignored.
    let solid = true;
    for (let y = 0; y < 16 && solid; y++) for (let x = 32; x < 64; x++) if (alpha(x, y) < 128) { solid = false; break; }
    if (solid) for (let y = 0; y < 16; y++) for (let x = 32; x < 64; x++) px[(y * 64 + x) * 4 + 3] = 0;
  }
  opaque(0, 0, 32, 16);
  opaque(0, 16, 64, 32);
  if (img.height === 64) opaque(16, 48, 48, 64);
  g.putImageData(data, 0, 0);
  return { canvas: c, slim: model === 'slim', legacy: img.height === 32 };
}

/* ---------- boxes with the game's texture layout ---------- */

// A w×h×d box textured like the game's model cubes: the net starts at (u, v) on a texW×texH sheet.
// inflate grows the box without changing its texture (outer layers, armor). mirror flips it left to
// right (left limbs drawn from the right limb's texture).
function cube(w, h, d, u, v, texW, texH, inflate = 0, mirror = false) {
  const g = new THREE.BoxGeometry(w + inflate * 2, h + inflate * 2, d + inflate * 2);
  const rect = (x1, y1, x2, y2) => {
    const l = x1 / texW, r = x2 / texW, t = 1 - y1 / texH, b = 1 - y2 / texH;
    return mirror ? [[r, t], [l, t], [r, b], [l, b]] : [[l, t], [r, t], [l, b], [r, b]]; // TL TR BL BR
  };
  const playerRight = rect(u, v + d, u + d, v + d + h);
  const front = rect(u + d, v + d, u + d + w, v + d + h);
  const playerLeft = rect(u + d + w, v + d, u + 2 * d + w, v + d + h);
  const back = rect(u + 2 * d + w, v + d, u + 2 * d + 2 * w, v + d + h);
  const top = rect(u + d, v, u + d + w, v + d);
  const b0 = rect(u + d + w, v, u + d + 2 * w, v + d);
  const bottom = [b0[2], b0[3], b0[0], b0[1]]; // drawn upside down
  // BoxGeometry's faces: +x, -x, +y, -y, +z (front), -z. The model faces +z, so its right is -x.
  const faces = mirror ? [playerRight, playerLeft, top, bottom, front, back] : [playerLeft, playerRight, top, bottom, front, back];
  const uv = g.attributes.uv;
  faces.forEach((f, i) => f.forEach(([s, t], k) => uv.setXY(i * 4 + k, s, t)));
  uv.needsUpdate = true;
  return g;
}

/* ---------- armor ---------- */

// Which boxes each armor piece covers. Helmet, chestplate and boots use the outer armor texture
// (layer "humanoid", grown by 1); leggings use the inner one ("humanoid_leggings", grown by 0.5).
const ARMOR = {
  head: { layer: 'humanoid', boxes: [['head', 8, 8, 8, 0, 0, 1], ['head', 8, 8, 8, 32, 0, 1.5]] },
  chest: { layer: 'humanoid', boxes: [['body', 8, 12, 4, 16, 16, 1], ['rightArm', 4, 12, 4, 40, 16, 1], ['leftArm', 4, 12, 4, 40, 16, 1, true]] },
  legs: { layer: 'humanoid_leggings', boxes: [['body', 8, 12, 4, 16, 16, 0.5], ['rightLeg', 4, 12, 4, 0, 16, 0.5], ['leftLeg', 4, 12, 4, 0, 16, 0.5, true]] },
  feet: { layer: 'humanoid', boxes: [['rightLeg', 4, 12, 4, 0, 16, 1], ['leftLeg', 4, 12, 4, 0, 16, 1, true]] },
};
const LEATHER_UNDYED = 0xa06540;
// the armor sets the game draws on players (an elytra or a pumpkin has none)
const BODY_ARMOR = new Set(['leather', 'chainmail', 'copper', 'iron', 'gold', 'diamond', 'netherite', 'turtle_scute']);
const ID_RE = /^[a-z0-9_]+$/;

// Trim patterns are drawn in eight grey keys (trim_palette.png); each material swaps them for its colors.
async function trimLayer(layer, trim) {
  if (!ID_RE.test(trim.pattern) || !ID_RE.test(trim.palette)) return null;
  const [pattern, keys, colors] = await Promise.all([
    loadImage(TEX(`trims/entity/${layer}/${trim.pattern}`)),
    loadImage(TEX('trims/color_palettes/trim_palette')),
    loadImage(TEX(`trims/color_palettes/${trim.palette}`)),
  ]);
  if (!pattern || !keys || !colors) return null;
  const read = (img) => {
    const c = canvas(img.width, img.height);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    return g.getImageData(0, 0, img.width, img.height);
  };
  const k = read(keys).data, p = read(colors).data;
  const swap = new Map();
  for (let i = 0; i < keys.width; i++) swap.set((k[i * 4] << 16) | (k[i * 4 + 1] << 8) | k[i * 4 + 2], [p[i * 4], p[i * 4 + 1], p[i * 4 + 2]]);
  const out = read(pattern);
  const d = out.data;
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    let rgb = swap.get((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    if (!rgb) { // not one of the keys: the nearest by brightness
      let best = Infinity;
      for (let j = 0; j < keys.width; j++) {
        const diff = Math.abs(k[j * 4] - d[i]);
        if (diff < best) { best = diff; rgb = [p[j * 4], p[j * 4 + 1], p[j * 4 + 2]]; }
      }
    }
    [d[i], d[i + 1], d[i + 2]] = rgb;
  }
  const c = canvas(out.width, out.height);
  c.getContext('2d').putImageData(out, 0, 0);
  return c;
}

// One armor piece's texture: its material, dyed if it's leather, with its trim on top.
async function armorTexture(item, layer) {
  if (!BODY_ARMOR.has(item?.asset)) return null;
  const base = await loadImage(TEX(`entity/equipment/${layer}/${item.asset}`));
  if (!base) return null; // not worn on the body (elytra, a carved pumpkin…)
  const c = canvas(base.width, base.height);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(base, 0, 0);
  if (item.asset === 'leather') {
    const dye = item.dye ?? LEATHER_UNDYED;
    const data = g.getImageData(0, 0, c.width, c.height);
    const d = data.data;
    const [r, gr, b] = [(dye >> 16) & 255, (dye >> 8) & 255, dye & 255];
    for (let i = 0; i < d.length; i += 4) {
      d[i] = (d[i] * r) / 255;
      d[i + 1] = (d[i + 1] * gr) / 255;
      d[i + 2] = (d[i + 2] * b) / 255;
    }
    g.putImageData(data, 0, 0);
    const overlay = await loadImage(TEX(`entity/equipment/${layer}/leather_overlay`));
    if (overlay) g.drawImage(overlay, 0, 0);
  }
  if (item.trim) {
    const trim = await trimLayer(layer, item.trim);
    if (trim) g.drawImage(trim, 0, 0);
  }
  return c;
}

/* ---------- the enchantment shimmer ---------- */

let glintImage = null;
function glintMaterial(map, glint, scale) {
  return new THREE.ShaderMaterial({
    uniforms: { map: { value: map }, glint: { value: glint }, time: { value: 0 }, scale: { value: scale } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform sampler2D map; uniform sampler2D glint; uniform float time; uniform vec2 scale; varying vec2 vUv;
      void main() {
        if (texture2D(map, vUv).a < 0.5) discard;
        vec2 p = vUv * scale;
        vec2 a = vec2(p.x * 0.985 + p.y * 0.17, p.y * 0.985 - p.x * 0.17) + vec2(time * 0.11, 0.0);
        vec2 b = vec2(p.x * 0.94 - p.y * 0.34, p.y * 0.94 + p.x * 0.34) - vec2(time * 0.07, 0.0);
        vec3 c = texture2D(glint, a).rgb + texture2D(glint, b).rgb;
        gl_FragColor = vec4(c * 0.55, 1.0);
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
}

/* ---------- held items ---------- */

// An item as the game holds it: its 16×16 picture given one pixel of thickness, with the edges of
// every pixel filled in, so it looks solid from any side.
function itemGeometry(img) {
  const n = img.width;
  const frameH = Math.min(img.height, n); // animated textures are a strip of frames; the first one
  const c = canvas(n, img.height);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const a = g.getImageData(0, 0, n, img.height).data;
  const solid = (x, y) => x >= 0 && y >= 0 && x < n && y < frameH && a[(y * n + x) * 4 + 3] > 127;
  const pos = [], nor = [], uv = [];
  const vTop = 1, vOf = (y) => 1 - y / img.height;
  const quad = (p, normal, uvs) => {
    for (const i of [0, 1, 2, 0, 2, 3]) {
      pos.push(...p[i]);
      nor.push(...normal);
      uv.push(...uvs[i]);
    }
  };
  const h = n / 2;
  const X = (x) => x - h, Y = (y) => h - y;
  const vb = vOf(frameH);
  // front and back
  quad([[-h, -h, 0.5], [h, -h, 0.5], [h, h, 0.5], [-h, h, 0.5]], [0, 0, 1], [[0, vb], [1, vb], [1, vTop], [0, vTop]]);
  quad([[h, -h, -0.5], [-h, -h, -0.5], [-h, h, -0.5], [h, h, -0.5]], [0, 0, -1], [[1, vb], [0, vb], [0, vTop], [1, vTop]]);
  for (let y = 0; y < frameH; y++) {
    for (let x = 0; x < n; x++) {
      if (!solid(x, y)) continue;
      const cu = (x + 0.5) / n, cv = vOf(y + 0.5);
      const t = [[cu, cv], [cu, cv], [cu, cv], [cu, cv]];
      const x0 = X(x), x1 = X(x + 1), y0 = Y(y), y1 = Y(y + 1);
      if (!solid(x - 1, y)) quad([[x0, y1, -0.5], [x0, y1, 0.5], [x0, y0, 0.5], [x0, y0, -0.5]], [-1, 0, 0], t);
      if (!solid(x + 1, y)) quad([[x1, y1, 0.5], [x1, y1, -0.5], [x1, y0, -0.5], [x1, y0, 0.5]], [1, 0, 0], t);
      if (!solid(x, y - 1)) quad([[x0, y0, 0.5], [x1, y0, 0.5], [x1, y0, -0.5], [x0, y0, -0.5]], [0, 1, 0], t);
      if (!solid(x, y + 1)) quad([[x0, y1, -0.5], [x1, y1, -0.5], [x1, y1, 0.5], [x0, y1, 0.5]], [0, -1, 0], t);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return { geo, canvas: c, size: n };
}

// Where the game puts an item in a hand (third person). Its chain, from ItemInHandLayer and
// ItemTransform in the game's code, starting at the arm's joint with the arm's own turn applied:
//   turn -90° about x, 180° about y, move (±1, 2, -10) pixels to the hand,
//   then the item model's own "thirdperson" display: move, turn (x, then y, then z), scale,
//   and the item drawn as a 16-pixel square centred on that point, one pixel thick.
// The display values are the game's (models/item/generated.json, handheld.json, handheld_mace.json).
// For the left hand the game flips the display's x move and its y and z turns; handheld.json's own
// left-hand entry is already the flipped one, so both hands end up with the same turn.
const HELD = {
  generated: { rot: [0, 0, 0], move: [0, 3, 1], scale: 0.55 }, // eggs and other plain items: flat on the hand, face up
  handheld: { rot: [0, -90, 55], move: [0, 4, 0.5], scale: 0.85 }, // swords and tools: blade forward
  mace: { rot: [0, -90, 55], move: [0, 4, 1], scale: 1 },
};
const HANDHELD_RE = /_(sword|axe|pickaxe|shovel|hoe|spear)$|^(stick|bone|blaze_rod|breeze_rod|fishing_rod|trident)$/;
const displayOf = (id) => (id === 'mace' ? HELD.mace : HANDHELD_RE.test(id) ? HELD.handheld : HELD.generated);

// The game's model space has y pointing down and the player facing -z; here y is up and the
// player faces +z. Turning half way round the x axis takes one to the other.
const FROM_GAME = new THREE.Matrix4().makeScale(1, -1, -1);
const rad = (deg) => (deg * Math.PI) / 180;

// The item's place inside its arm (the arm's joint at the origin, in pixels). size: the picture's width.
function heldMatrix(display, right, size, slim) {
  const side = right ? 1 : -1;
  const m = new THREE.Matrix4().copy(FROM_GAME);
  const mul = (x) => m.multiply(x);
  const T = (x, y, z) => new THREE.Matrix4().makeTranslation(x, y, z);
  if (slim) mul(T(0.5 * side, 0, 0)); // thinner arms hold things half a pixel further in
  mul(new THREE.Matrix4().makeRotationX(rad(-90)));
  mul(new THREE.Matrix4().makeRotationY(rad(180)));
  mul(T(side, 2, -10));
  mul(T(side * display.move[0], display.move[1], display.move[2]));
  mul(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rad(display.rot[0]), rad(display.rot[1]), rad(display.rot[2]), 'XYZ')));
  const k = (display.scale * 16) / size;
  mul(new THREE.Matrix4().makeScale(k, k, k));
  return m;
}

/* ---------- the egg's particles ---------- */

// Egg SMP shows a particle aura around a player holding their egg in the off hand (core/Aura.java
// in the egg mod). Every game tick (20 a second), with spin counting 0 to 15:
//   - a small dust speck in the egg's main color somewhere around the body,
//   - a main-color speck on a ring 0.72 blocks out, a sixteenth of a turn further round each tick
//     and rising from 0.25 to 1.3 blocks,
//   - an accent-color speck opposite it, sinking from 1.3 to 0.25,
//   - and when spin is 0, two of the egg's own accent particle at shoulder height.
// Colors and accent particles are the egg mod's (core/EggType.java). A cracked egg (no energy)
// gives dim smoke instead.
const AURA = {
  life: [1.0, 0.31, 0.55, 0.79, 0.09, 0.29, 'end_rod'],
  hunger: [0.84, 0.89, 0.35, 0.88, 0.48, 0.0, 'happy_villager'],
  sky: [0.49, 0.83, 0.99, 0.01, 0.52, 0.78, 'enchant'],
  gravity: [0.61, 0.79, 1.0, 0.15, 0.39, 0.92, 'small_gust'],
  gambler: [0.96, 0.77, 0.27, 0.24, 0.86, 0.52, 'happy_villager'],
  fire: [1.0, 0.48, 0.12, 1.0, 0.18, 0.05, 'flame'],
  blood: [0.77, 0.09, 0.09, 1.0, 0.16, 0.16, 'crimson_spore'],
  echo: [0.18, 0.83, 0.75, 0.06, 0.46, 0.43, 'sculk_soul'],
  aqua: [0.24, 0.86, 1.0, 0.08, 0.40, 0.90, 'nautilus'],
  meteor: [1.0, 0.94, 0.62, 1.0, 0.86, 0.42, 'end_rod'],
  train: [0.88, 0.23, 0.23, 0.60, 0.64, 0.69, 'smoke'],
  binding: [0.77, 0.80, 0.84, 0.89, 0.70, 0.25, 'crit'],
  murica: [0.78, 0.06, 0.18, 0.24, 0.43, 1.0, 'firework'],
  dung: [0.63, 0.41, 0.23, 0.55, 0.64, 0.17, 'composter'],
  wizard: [0.69, 0.29, 1.0, 0.42, 0.12, 0.69, 'portal'],
  redstone: [1.0, 0.23, 0.23, 0.55, 0.0, 0.0, 'electric_spark'],
  fat: [1.0, 0.62, 0.71, 0.79, 0.42, 0.54, 'heart'],
  woods: [0.24, 0.56, 0.23, 0.61, 0.80, 0.40, 'happy_villager'],
  smite: [0.17, 0.72, 0.63, 0.49, 0.30, 1.0, 'nautilus'],
  stash: [0.24, 0.86, 0.59, 0.77, 0.64, 0.35, 'happy_villager'],
  sulfur: [0.91, 0.83, 0.30, 0.23, 0.23, 0.23, 'ash'],
  subzero: [0.56, 0.85, 1.0, 0.91, 0.98, 1.0, 'snowflake'],
  combo: [0.49, 0.83, 1.0, 0.91, 0.97, 1.0, 'crit'],
  electric: [0.31, 0.85, 1.0, 1.0, 0.94, 0.48, 'electric_spark'],
  deadshot: [0.88, 0.28, 0.28, 0.91, 0.78, 0.45, 'crit'],
  purpur: [0.79, 0.63, 0.86, 0.66, 0.43, 0.66, 'end_rod'],
};
const AURA_CRACKED = [0.45, 0.45, 0.48, 0.28, 0.28, 0.3, 'smoke'];

const frames = (name, n, down = true) => Array.from({ length: n }, (_, i) => `${name}_${down ? n - 1 - i : i}`);
const GENERIC = frames('generic', 8); // big to small, as dust and smoke shrink away
// The accent particles, near enough to the game's: pictures (played through over its life, or one
// picked at random), size in blocks, life in ticks, how it drifts (blocks per tick), and its tint.
const ACCENT = {
  end_rod: { tex: frames('glitter', 8), size: 0.11, life: [40, 60], vy: -0.004, spread: 0.02, fade: true },
  happy_villager: { tex: ['glint'], size: 0.09, life: [16, 24], vy: 0, spread: 0.004 },
  composter: { tex: ['glint'], size: 0.09, life: [16, 24], vy: 0.004, spread: 0.004 },
  enchant: { tex: 'abcdefghijklmnopqrstuvwxyz'.split('').map((l) => `sga_${l}`), pick: true, size: 0.1, life: [30, 40], vy: -0.012, spread: 0.02, tint: [0.75, 0.8, 1] },
  nautilus: { tex: ['nautilus'], size: 0.1, life: [30, 40], vy: -0.012, spread: 0.02 },
  small_gust: { tex: frames('small_gust', 7, false), size: 0.28, life: [12, 16], vy: 0, spread: 0 },
  flame: { tex: ['flame'], size: 0.12, life: [14, 22], vy: 0.006, spread: 0.004, shrink: true },
  crimson_spore: { tex: ['generic_0'], size: 0.07, life: [40, 70], vy: -0.006, spread: 0.012, tint: [0.9, 0.4, 0.5] },
  sculk_soul: { tex: frames('sculk_soul', 11, false), size: 0.16, life: [22, 30], vy: 0.02, spread: 0.004 },
  smoke: { tex: GENERIC, size: 0.14, life: [10, 30], vy: 0.012, spread: 0.006, tint: [0.2, 0.2, 0.2] },
  crit: { tex: ['critical_hit'], size: 0.1, life: [8, 14], vy: -0.004, spread: 0.02, shrink: true },
  firework: { tex: frames('spark', 8), size: 0.1, life: [30, 46], vy: -0.004, spread: 0.02, fade: true },
  portal: { tex: GENERIC, pick: true, size: 0.1, life: [30, 40], vy: 0.008, spread: 0.02, tint: [0.75, 0.25, 0.95], shrink: true },
  electric_spark: { tex: ['glow'], size: 0.08, life: [6, 12], vy: 0, spread: 0.02, tint: [1, 0.9, 0.5] },
  heart: { tex: ['heart'], size: 0.18, life: [16, 16], vy: 0.012, spread: 0.002 },
  ash: { tex: ['generic_0'], size: 0.06, life: [30, 60], vy: -0.01, spread: 0.008, tint: [0.25, 0.25, 0.25] },
  snowflake: { tex: GENERIC, size: 0.1, life: [20, 40], vy: -0.008, spread: 0.01, tint: [0.92, 0.98, 1] },
};
const BLOCK = 16 / 0.9375; // the game draws players a touch smaller than their model: this many pixels to a block
const gauss = () => { // roughly a normal spread, like the game's
  let t = 0;
  for (let i = 0; i < 4; i++) t += Math.random();
  return (t - 2) * 1.73;
};

// The aura around the model. Positions are in blocks (feet at the origin, the game's axes turned to
// the scene's); tick() is one game tick, draw(part) places the sprites between ticks.
async function makeAura(scene, look, keep) {
  const [r, g, b, r2, g2, b2, accentName] = look;
  const accent = ACCENT[accentName] || ACCENT.end_rod;
  const names = [...new Set([...GENERIC, ...accent.tex])];
  const textures = new Map();
  await Promise.all(names.map(async (n) => {
    const img = await loadImage(TEX(`particle/${n}`));
    if (img) textures.set(n, keep(pixelTexture(img)));
  }));
  if (!textures.has('generic_0')) return null; // no particle pictures (an older Worker): no aura
  const group = new THREE.Group();
  scene.add(group);
  const live = [];
  const spare = [];
  let n = 0;

  const spawn = (p) => {
    const sprite = spare.pop() || new THREE.Sprite(keep(new THREE.SpriteMaterial({ transparent: true, alphaTest: 0.05, depthWrite: false })));
    sprite.material.color.setRGB(p.color[0], p.color[1], p.color[2], THREE.SRGBColorSpace);
    sprite.material.opacity = 1;
    group.add(sprite);
    live.push({ age: 0, px: p.x, py: p.y, pz: p.z, ...p, sprite });
  };
  // A dust speck, as the game makes one: slightly varied color, a size and life that follow its
  // scale, a slow drift that soon stops.
  const dust = (x, y, z, cr, cg, cb, scale) => {
    const f = Math.random() * 0.4 + 0.6;
    const shade = () => (Math.random() * 0.2 + 0.8) * f;
    spawn({
      x, y, z, tex: GENERIC, color: [cr * shade(), cg * shade(), cb * shade()],
      vx: gauss() * 0.004, vy: 0.01 + gauss() * 0.004, vz: gauss() * 0.004, drag: 0.96,
      size: 0.1 * (Math.random() * 0.5 + 0.5) * 2 * 0.75 * scale * 2,
      life: Math.max(1, Math.floor((8 / (Math.random() * 0.8 + 0.2)) * scale)), grow: true,
    });
  };
  const ring = (yawDeg, y, radius) => { // the game's "rotated <yaw> 0, forward <radius>"
    const a = rad(yawDeg);
    return [-Math.sin(a) * radius, y, Math.cos(a) * radius];
  };

  return {
    tick() {
      for (let i = live.length - 1; i >= 0; i--) {
        const p = live[i];
        p.px = p.x; p.py = p.y; p.pz = p.z;
        if (++p.age >= p.life) {
          group.remove(p.sprite);
          spare.push(p.sprite);
          live.splice(i, 1);
          continue;
        }
        p.x += p.vx; p.y += p.vy; p.z += p.vz;
        p.vx *= p.drag; p.vy *= p.drag; p.vz *= p.drag;
      }
      const spin = n++ % 16;
      dust(gauss() * 0.18, 0.75 + gauss() * 0.28, gauss() * 0.18, r, g, b, 0.45);
      dust(...ring(spin * 22.5, 0.25 + 0.07 * spin, 0.72), r, g, b, 0.7);
      dust(...ring(spin * 22.5 + 180, 1.3 - 0.07 * spin, 0.72), r2, g2, b2, 0.55);
      if (spin === 0) {
        for (let k = 0; k < 2; k++) {
          const [x, y, z] = ring(90, 1.05, 0.85);
          const life = accent.life[0] + Math.floor(Math.random() * (accent.life[1] - accent.life[0] + 1));
          spawn({
            x: x + gauss() * 0.08, y: y + gauss() * 0.08, z: z + gauss() * 0.08,
            tex: accent.pick ? [accent.tex[Math.floor(Math.random() * accent.tex.length)]] : accent.tex,
            color: accent.tint || [1, 1, 1], size: accent.size * (0.8 + Math.random() * 0.4), life,
            vx: gauss() * accent.spread, vy: accent.vy + gauss() * accent.spread * 0.5, vz: gauss() * accent.spread, drag: 0.96,
            fade: accent.fade, shrink: accent.shrink,
          });
        }
      }
    },
    // part: how far into the current tick (0 to 1)
    draw(part) {
      for (const p of live) {
        const t = (p.age + part) / p.life;
        const tex = textures.get(p.tex[Math.min(p.tex.length - 1, Math.floor(t * p.tex.length))]) || textures.get('generic_0');
        if (p.sprite.material.map !== tex) {
          p.sprite.material.map = tex;
          p.sprite.material.needsUpdate = true;
        }
        let size = p.size * BLOCK;
        if (p.grow) size *= Math.min(1, t * 32);
        if (p.shrink) size *= 1 - t * 0.6;
        if (p.fade) p.sprite.material.opacity = t > 0.5 ? Math.max(0, 1 - (t - 0.5) * 2) : 1;
        p.sprite.scale.set(size, size, 1);
        p.sprite.position.set(
          (p.px + (p.x - p.px) * part) * BLOCK, (p.py + (p.y - p.py) * part) * BLOCK, (p.pz + (p.z - p.pz) * part) * BLOCK);
      }
    },
    clear() {
      for (const p of live) group.remove(p.sprite);
      live.length = 0;
    },
  };
}

/* ---------- the model ---------- */

export async function mountPlayer(container, spec) {
  const disposables = [];
  const keep = (x) => (disposables.push(x), x);
  const glints = [];
  let disposed = false;
  const cancelled = () => disposed || spec.signal?.aborted;

  const [skin, glintImg] = await Promise.all([
    loadSkin(spec.name, spec.uuid),
    glintImage ??= loadImage(TEX('misc/enchanted_glint_armor')),
  ]);
  const glintTex = glintImg ? keep(pixelTexture(glintImg)) : null;
  if (glintTex) {
    glintTex.wrapS = glintTex.wrapT = THREE.RepeatWrapping;
    glintTex.magFilter = glintTex.minFilter = THREE.LinearFilter;
  }

  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 1.9));
  const sun = new THREE.DirectionalLight(0xffffff, 1.5);
  sun.position.set(-0.6, 1, 0.9);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xffffff, 0.45);
  fill.position.set(0.8, 0.2, -0.6);
  scene.add(fill);

  const material = (map) => keep(new THREE.MeshLambertMaterial({ map, alphaTest: 0.5, side: THREE.DoubleSide }));
  const mesh = (geo, mat, x, y, z) => {
    const m = new THREE.Mesh(keep(geo), mat);
    m.position.set(x, y, z);
    return m;
  };

  // Body parts, each turning around its joint: feet at y = 0, facing +z.
  const root = new THREE.Group();
  scene.add(root);
  const part = (x, y, z) => {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    root.add(g);
    return g;
  };
  const armW = skin.slim ? 3 : 4;
  const armY = skin.slim ? 21.5 : 22;
  const parts = {
    head: part(0, 24, 0),
    body: part(0, 24, 0),
    rightArm: part(-5, armY, 0),
    leftArm: part(5, armY, 0),
    rightLeg: part(-1.9, 12, 0),
    leftLeg: part(1.9, 12, 0),
  };
  // where each part's box sits from its joint (armor arms are 4 wide even on slim models)
  const offset = {
    head: [0, 4, 0], body: [0, -6, 0], rightLeg: [0, -6, 0], leftLeg: [0, -6, 0],
    rightArm: [skin.slim ? -0.5 : -1, -4, 0], leftArm: [skin.slim ? 0.5 : 1, -4, 0],
  };
  const armorOffset = { ...offset, rightArm: [-1, -4, 0], leftArm: [1, -4, 0] };

  const skinMat = material(keep(pixelTexture(skin.canvas)));
  const H = skin.legacy ? 32 : 64;
  // Neighbouring limbs overlap (the legs are 3.8 apart but 4 wide, armor wider still), so their
  // front and back faces would share a plane and flicker where they cross. Each part is grown by a
  // hair more than the one it overlaps, so one is always clearly in front.
  const NUDGE = { body: 0, rightArm: 0.03, leftArm: 0.03, rightLeg: 0.015, leftLeg: 0, head: 0 };
  const add = (name, w, h, d, u, v, inflate = 0, mirror = false, mat = skinMat, texW = 64, texH = H) => {
    const [x, y, z] = (mat === skinMat ? offset : armorOffset)[name];
    const m = mesh(cube(w, h, d, u, v, texW, texH, inflate + NUDGE[name], mirror), mat, x, y, z);
    parts[name].add(m);
    return m;
  };

  add('head', 8, 8, 8, 0, 0);
  add('head', 8, 8, 8, 32, 0, 0.5);
  add('body', 8, 12, 4, 16, 16);
  add('rightArm', armW, 12, 4, 40, 16);
  add('rightLeg', 4, 12, 4, 0, 16);
  if (skin.legacy) {
    add('leftArm', armW, 12, 4, 40, 16, 0, true);
    add('leftLeg', 4, 12, 4, 0, 16, 0, true);
  } else {
    add('body', 8, 12, 4, 16, 32, 0.25);
    add('rightArm', armW, 12, 4, 40, 32, 0.25);
    add('rightLeg', 4, 12, 4, 0, 32, 0.25);
    add('leftArm', armW, 12, 4, 32, 48);
    add('leftArm', armW, 12, 4, 48, 48, 0.25);
    add('leftLeg', 4, 12, 4, 16, 48);
    add('leftLeg', 4, 12, 4, 0, 48, 0.25);
  }

  // Armor
  await Promise.all(Object.entries(ARMOR).map(async ([slot, { layer, boxes }]) => {
    const item = spec.armor?.[slot];
    const c = item && await armorTexture(item, layer);
    if (!c || cancelled()) return;
    const tex = keep(pixelTexture(c));
    const mat = material(tex);
    const gmat = item.glint && glintTex ? keep(glintMaterial(tex, glintTex, new THREE.Vector2(2, 1))) : null;
    if (gmat) glints.push(gmat);
    for (const [name, w, h, d, u, v, inflate, mirror] of boxes) {
      const m = add(name, w, h, d, u, v, inflate, mirror, mat, c.width, c.height);
      if (gmat) {
        const shine = new THREE.Mesh(m.geometry, gmat);
        shine.position.copy(m.position);
        parts[name].add(shine);
      }
    }
  }));

  // Held items: the weapon in the main (right) hand, the egg in the off (left) hand, placed exactly
  // as the game places them (see HELD above).
  const holdItem = async (item, arm) => {
    const id = item && (item.model || item.id);
    if (!id || !ID_RE.test(id)) return false;
    const img = await loadImage(TEX(`item/${id}`));
    if (!img || cancelled()) return false;
    const { geo, canvas: c, size } = itemGeometry(img);
    const tex = keep(pixelTexture(c));
    const mat = material(tex);
    const holder = new THREE.Group();
    holder.matrixAutoUpdate = false;
    holder.matrix.copy(heldMatrix(displayOf(id), arm === 'rightArm', size, skin.slim));
    holder.add(new THREE.Mesh(keep(geo), mat));
    if (item.glint && glintTex) {
      const gmat = keep(glintMaterial(tex, glintTex, new THREE.Vector2(0.5, 0.5)));
      glints.push(gmat);
      holder.add(new THREE.Mesh(geo, gmat));
    }
    parts[arm].add(holder);
    return true;
  };
  const [hasWeapon, hasEgg] = await Promise.all([
    holdItem(spec.mainhand, 'rightArm'),
    holdItem(spec.offhand, 'leftArm'),
  ]);

  // The egg's particles, only while the egg is in the hand and things may move.
  const auraLook = spec.aura?.cracked ? AURA_CRACKED : AURA[spec.aura?.id];
  const aura = hasEgg && auraLook && !reducedMotion() ? await makeAura(scene, auraLook, keep) : null;

  if (cancelled()) {
    for (const d of disposables) d.dispose?.();
    return { dispose() {} };
  }

  /* ---------- drawing ---------- */

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.className = 'p-model-canvas';
  container.append(renderer.domElement);

  const camera = new THREE.PerspectiveCamera(26, 1, 1, 400);
  camera.position.set(0, 19, 86);
  camera.lookAt(0, 16.5, 0);
  const resize = () => {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // keep the whole player in view however narrow the box is
    camera.fov = w / h < 0.62 ? 2 * Math.atan(Math.tan((26 * Math.PI) / 360) * (0.62 / (w / h))) * (180 / Math.PI) : 26;
    camera.updateProjectionMatrix();
    renderer.render(scene, camera); // resizing clears the canvas; don't wait a frame to redraw
    wake();
  };

  // Turning toward the pointer
  const target = { yaw: BASE_YAW, headYaw: 0, headPitch: 0 };
  const now = { yaw: BASE_YAW, headYaw: 0, headPitch: 0 };
  const onPointer = (e) => {
    const r = renderer.domElement.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height * 0.22; // around the head
    const nx = Math.max(-1, Math.min(1, (e.clientX - cx) / (innerWidth * 0.5)));
    const ny = Math.max(-1, Math.min(1, (e.clientY - cy) / (innerHeight * 0.5)));
    target.yaw = BASE_YAW + nx * 0.45;
    target.headYaw = nx * 0.5;
    target.headPitch = ny * 0.45;
    wake();
  };
  const onLeave = (e) => {
    if (e.relatedTarget) return;
    Object.assign(target, { yaw: BASE_YAW, headYaw: 0, headPitch: 0 });
    wake();
  };
  addEventListener('pointermove', onPointer, { passive: true });
  document.addEventListener('pointerout', onLeave);

  // The game's standing pose: an arm holding something is raised a tenth of a half turn, and both
  // sway gently.
  const HOLD = Math.PI / 10;
  const pose = (t) => {
    const sway = reducedMotion() ? 0 : 1;
    const z = (Math.cos(t * 1.8) * 0.05 + 0.05) * sway;
    const x = Math.sin(t * 1.34) * 0.05 * sway;
    parts.rightArm.rotation.set((hasWeapon ? -HOLD : 0) + x, 0, -z);
    parts.leftArm.rotation.set((hasEgg ? -HOLD : 0) - x, 0, z);
    root.rotation.y = now.yaw;
    parts.head.rotation.set(now.headPitch, now.headYaw, 0, 'YXZ');
  };

  let frame = 0, visible = true, last = performance.now(), auraTime = 0;
  const loop = (ms) => {
    frame = 0;
    const dt = Math.min(0.1, (ms - last) / 1000);
    last = ms;
    const k = 1 - Math.exp(-dt * 6);
    let moving = false;
    for (const key of ['yaw', 'headYaw', 'headPitch']) {
      now[key] += (target[key] - now[key]) * k;
      if (Math.abs(target[key] - now[key]) > 0.001) moving = true;
    }
    const t = ms / 1000;
    for (const g of glints) g.uniforms.time.value = t;
    if (aura) {
      // the game's 20 ticks a second; after a pause (a hidden tab) start again rather than catch up
      auraTime += dt * 20;
      if (auraTime > 40) { aura.clear(); auraTime = 1; }
      for (; auraTime >= 1; auraTime -= 1) aura.tick();
      aura.draw(auraTime);
    }
    pose(t);
    renderer.render(scene, camera);
    if (visible && !document.hidden && (moving || !reducedMotion() || glints.length || aura)) frame = requestAnimationFrame(loop);
  };
  function wake() {
    if (!frame && visible && !document.hidden && !disposed) {
      last = performance.now();
      frame = requestAnimationFrame(loop);
    }
  }
  const seen = new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    wake();
  });
  seen.observe(container);
  const sized = new ResizeObserver(resize);
  sized.observe(container);
  const onVisibility = () => wake();
  document.addEventListener('visibilitychange', onVisibility);
  resize();
  pose(0);
  renderer.render(scene, camera);

  return {
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      removeEventListener('pointermove', onPointer);
      document.removeEventListener('pointerout', onLeave);
      document.removeEventListener('visibilitychange', onVisibility);
      seen.disconnect();
      sized.disconnect();
      for (const d of disposables) d.dispose?.();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
