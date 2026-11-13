// A player drawn in 3D the way the game draws them: their skin, the armor they wear (with trims,
// leather dye and the enchantment shimmer), their best weapon in the main hand and their egg in the
// off hand. The model turns a little toward the mouse, and the head follows it a bit more.
//
// Textures come from /api/mc/… (the game's own, for the server's version) and /api/skin/<name>.
// Loaded on demand by app.js: mountPlayer(container, { name, uuid?, armor, mainhand?, offhand?, signal? })
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
  const add = (name, w, h, d, u, v, inflate = 0, mirror = false, mat = skinMat, texW = 64, texH = H) => {
    const [x, y, z] = (mat === skinMat ? offset : armorOffset)[name];
    const m = mesh(cube(w, h, d, u, v, texW, texH, inflate, mirror), mat, x, y, z);
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

  // Held items: the weapon in the main (right) hand, the egg in the off (left) hand.
  const holdItem = async (item, arm, handheld) => {
    const id = item && (item.model || item.id);
    if (!id || !ID_RE.test(id)) return false;
    const img = await loadImage(TEX(`item/${id}`));
    if (!img || cancelled()) return false;
    const { geo, canvas: c, size } = itemGeometry(img);
    const tex = keep(pixelTexture(c));
    const mat = material(tex);
    const s = 16 / size;
    const it = new THREE.Mesh(keep(geo), mat);
    const holder = new THREE.Group();
    const right = arm === 'rightArm';
    const handX = right ? offset.rightArm[0] : offset.leftArm[0];
    holder.position.set(handX, -10.5, 1);
    if (handheld) {
      // Held by the handle (the picture's lower left), the blade pointing forward and a little up.
      it.scale.setScalar(0.85 * s);
      it.position.set(4.6 * 0.85, 4.6 * 0.85, 0);
      // turned out a little from straight ahead, so its face shows from the front
      holder.rotation.set(0.35, right ? -Math.PI / 2 - 0.95 : Math.PI / 2 + 0.95, 0, 'XYZ');
    } else {
      it.scale.setScalar(0.55 * s);
      holder.position.y += 2.2;
      holder.position.z += 1.4;
      // held up toward the viewer rather than edge-on, as a trophy
      holder.rotation.set(0.25, right ? 0.5 : -0.35, 0, 'XYZ');
    }
    holder.add(it);
    if (item.glint && glintTex) {
      const gmat = keep(glintMaterial(tex, glintTex, new THREE.Vector2(0.5, 0.5)));
      glints.push(gmat);
      const shine = new THREE.Mesh(geo, gmat);
      shine.scale.copy(it.scale);
      shine.position.copy(it.position);
      holder.add(shine);
    }
    parts[arm].add(holder);
    return true;
  };
  const [hasWeapon, hasEgg] = await Promise.all([
    holdItem(spec.mainhand, 'rightArm', true),
    holdItem(spec.offhand, 'leftArm', false),
  ]);

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

  // A resting pose: arms slightly forward to hold their things, gently swaying like in the game.
  const pose = (t) => {
    const sway = reducedMotion() ? 0 : 1;
    const z = (Math.cos(t * 1.8) * 0.05 + 0.05) * sway;
    const x = Math.sin(t * 1.34) * 0.05 * sway;
    parts.rightArm.rotation.set((hasWeapon ? -0.32 : 0) + x, 0, -z - 0.03);
    parts.leftArm.rotation.set((hasEgg ? -0.28 : 0) - x, 0, z + 0.03);
    root.rotation.y = now.yaw;
    parts.head.rotation.set(now.headPitch, now.headYaw, 0, 'YXZ');
  };

  let frame = 0, visible = true, last = performance.now();
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
    pose(t);
    renderer.render(scene, camera);
    if (visible && !document.hidden && (moving || !reducedMotion() || glints.length)) frame = requestAnimationFrame(loop);
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
