// Items drawn the way the game draws them in an inventory slot: flat items as their texture, blocks
// and other 3D items as their model, turned and lit as the game does it.
//
// What to draw comes from /api/mc/item/<id>.json (the game's own item and model files, with parents
// folded in) and the textures from /api/mc/textures/…; three.js is only loaded for 3D items.
// Loaded on demand by app.js: itemIcon(id) -> Promise<data URL | null> (a 64×64 picture: one slot).

const TEX = (path) => `/api/mc/textures/${path}.png`;
const SIZE = 64; // 4 screen pixels per game pixel, so it stays sharp at 32 CSS pixels on any screen
const ID_RE = /^[a-z0-9_]{1,64}$/;

const images = new Map();
function loadImage(path) {
  if (!images.has(path)) {
    images.set(path, new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = TEX(path);
    }));
  }
  return images.get(path);
}

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// The first frame of a texture (animated ones are a tall strip of frames), tinted if asked.
function frame(img, tint, whole = false) {
  const w = img.naturalWidth, h = whole ? img.naturalHeight : Math.min(img.naturalHeight, img.naturalWidth);
  const c = canvas(w, h);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h, 0, 0, w, h);
  if (tint != null && tint !== 0xffffff) {
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = `#${tint.toString(16).padStart(6, '0')}`;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'destination-in'; // multiply filled the see-through parts too
    ctx.drawImage(img, 0, 0, w, h, 0, 0, w, h);
  }
  return c;
}

const defs = new Map();
function itemDef(id) {
  if (!defs.has(id)) {
    defs.set(id, fetch(`/api/mc/item/${id}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  }
  return defs.get(id);
}

/* ---------- 3D items ---------- */

let three = null; // { THREE, renderer, camera }
async function setup() {
  if (!three) {
    three = import('https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.min.js').then((THREE) => {
      const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, preserveDrawingBuffer: true });
      renderer.setPixelRatio(1);
      renderer.setSize(SIZE, SIZE, false);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      const camera = new THREE.OrthographicCamera(-8, 8, 8, -8, -200, 200); // a slot is 16 game pixels across
      camera.position.set(0, 0, 100);
      return { THREE, renderer, camera };
    });
  }
  return three;
}

const rad = (d) => (d * Math.PI) / 180;

// The game's side lighting for 3D items in a slot: the top brightest, the left side a little
// darker, the right side darkest. n is the face's direction on screen.
const shadeOf = (n) => Math.max(0.45, Math.min(1, 0.787 + 0.246 * n.y - 0.141 * n.x));

// Entity boxes for the items the game draws with code instead of a model file. Each is
// [texture, texture width, height, parts], a part being { at: [x, y, z] (where it hangs), scale?, boxes: [[u, v, x, y, z, w, h, d]] }.
const SPECIAL = {
  chest: () => ['entity/chest/normal', 64, 64, [
    { boxes: [[0, 19, 1, 0, 1, 14, 10, 14]] },
    { at: [0, 9, 1], boxes: [[0, 0, 1, 0, 0, 14, 5, 14], [0, 0, 7, -2, 14, 2, 4, 1]] },
  ]],
  shield: () => ['entity/shield/shield_base_nopattern', 64, 64, [
    { boxes: [[0, 0, -6, -11, -2, 12, 22, 1], [26, 0, -1, -3, -1, 2, 6, 6]] },
  ]],
  banner: () => ['entity/banner/banner_base', 64, 64, [
    { boxes: [[44, 0, -1, -42, -1, 2, 42, 2], [0, 42, -10, -44, -1, 20, 2, 2]] },
    { at: [0, -44, 0], boxes: [[0, 0, -10, 0, -2, 20, 40, 1]] },
  ]],
  head: (s) => (s.kind === 'dragon'
    ? ['entity/enderdragon/dragon', 256, 256, [
      { at: [0, -7.986666, 0], scale: 0.75, boxes: [
        [176, 44, -6, -1, -24, 12, 5, 16], [112, 30, -8, -8, -10, 16, 16, 16],
        [0, 0, -5, -12, -4, 2, 4, 6], [112, 0, -5, -3, -22, 2, 2, 4], [0, 0, 3, -12, -4, 2, 4, 6], [112, 0, 3, -3, -22, 2, 2, 4],
      ] },
      { at: [0, -7.986666 + 4 * 0.75, -8 * 0.75], scale: 0.75, boxes: [[176, 65, -6, 0, -16, 12, 4, 16]] },
    ]]
    : [{ skeleton: 'entity/skeleton/skeleton', wither_skeleton: 'entity/skeleton/wither_skeleton', zombie: 'entity/zombie/zombie',
      creeper: 'entity/creeper/creeper', piglin: 'entity/piglin/piglin' }[s.kind] || 'entity/skeleton/skeleton',
    64, s.kind === 'zombie' || s.kind === 'piglin' ? 64 : 32, [{ boxes: [[0, 0, -4, -8, -4, 8, 8, 8]] }]]),
};

// A decorated pot, as a model: the body's sides and the neck come from two textures.
const POT = {
  textures: { base: 'entity/decorated_pot/decorated_pot_base', side: 'entity/decorated_pot/decorated_pot_side' },
  elements: [
    { from: [1, 0, 1], to: [15, 16, 15], faces: {
      north: { uv: [1, 0, 15, 16], texture: '#side' }, south: { uv: [1, 0, 15, 16], texture: '#side' },
      west: { uv: [1, 0, 15, 16], texture: '#side' }, east: { uv: [1, 0, 15, 16], texture: '#side' },
      up: { uv: [0, 6.5, 7, 13.5], texture: '#base' }, down: { uv: [0, 6.5, 7, 13.5], texture: '#base' },
    } },
    { from: [4, 17, 4], to: [12, 20, 12], faces: {
      north: { uv: [4, 4, 8, 5.5], texture: '#base' }, south: { uv: [4, 4, 8, 5.5], texture: '#base' },
      west: { uv: [4, 4, 8, 5.5], texture: '#base' }, east: { uv: [4, 4, 8, 5.5], texture: '#base' },
      up: { uv: [4, 0, 8, 4], texture: '#base' }, down: { uv: [4, 0, 8, 4], texture: '#base' },
    } },
    { from: [5, 16, 5], to: [11, 17, 11], faces: {
      north: { uv: [3, 5.5, 6, 6], texture: '#base' }, south: { uv: [3, 5.5, 6, 6], texture: '#base' },
      west: { uv: [3, 5.5, 6, 6], texture: '#base' }, east: { uv: [3, 5.5, 6, 6], texture: '#base' },
    } },
  ],
};

// The corners of each face of a box, as seen from outside it: top left, bottom left, bottom right, top right.
function faceCorners(f, [x0, y0, z0], [x1, y1, z1]) {
  switch (f) {
    case 'north': return [[x1, y1, z0], [x1, y0, z0], [x0, y0, z0], [x0, y1, z0]];
    case 'south': return [[x0, y1, z1], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1]];
    case 'west': return [[x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]];
    case 'east': return [[x1, y1, z1], [x1, y0, z1], [x1, y0, z0], [x1, y1, z0]];
    case 'up': return [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]];
    default: return [[x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1]];
  }
}
// The part of the texture a face shows when the model doesn't say (from where the face is).
function defaultUv(f, [x0, y0, z0], [x1, y1, z1]) {
  switch (f) {
    case 'north': return [16 - x1, 16 - y1, 16 - x0, 16 - y0];
    case 'south': return [x0, 16 - y1, x1, 16 - y0];
    case 'west': return [z0, 16 - y1, z1, 16 - y0];
    case 'east': return [16 - z1, 16 - y1, 16 - z0, 16 - y0];
    case 'up': return [x0, z0, x1, z1];
    default: return [x0, 16 - z1, x1, 16 - z0];
  }
}

async function draw3d(def) {
  const { THREE, renderer, camera } = await setup();
  const M4 = THREE.Matrix4, V3 = THREE.Vector3;

  // slot <- how the model sits in it <- the model's own corner at the middle
  const g = def.gui || {};
  const [rx, ry, rz] = g.rotation || [0, 0, 0];
  const gui = new M4().makeTranslation(...(g.translation || [0, 0, 0]))
    .multiply(new M4().makeRotationFromEuler(new THREE.Euler(rad(rx), rad(ry), rad(rz), 'XYZ')))
    .multiply(new M4().makeScale(...(g.scale || [1, 1, 1])))
    .multiply(new M4().makeTranslation(-8, -8, -8));
  // an item definition's own transformation: translation (in blocks), a rotation, a scale, another rotation
  const transformation = (t) => {
    const q = (v) => new M4().makeRotationFromQuaternion(new THREE.Quaternion(...(v || [0, 0, 0, 1])));
    const [tx, ty, tz] = t.translation || [0, 0, 0];
    return new M4().makeTranslation(tx * 16, ty * 16, tz * 16).multiply(q(t.left_rotation))
      .multiply(new M4().makeScale(...(t.scale || [1, 1, 1]))).multiply(q(t.right_rotation));
  };

  const byTexture = new Map(); // texture path -> { pos, uv, color }
  const quad = (texture, corners, uvs, matrix, tint) => {
    if (!byTexture.has(texture)) byTexture.set(texture, { pos: [], uv: [], color: [] });
    const out = byTexture.get(texture);
    const p = corners.map((c) => new V3(...c).applyMatrix4(matrix));
    const n = new V3().subVectors(p[1], p[0]).cross(new V3().subVectors(p[3], p[0])).normalize();
    if (n.z < 0) n.negate(); // whichever side faces the viewer
    const b = shadeOf(n);
    const col = [((tint >> 16) & 255) / 255 * b, ((tint >> 8) & 255) / 255 * b, (tint & 255) / 255 * b];
    for (const i of [0, 1, 2, 0, 2, 3]) {
      out.pos.push(p[i].x, p[i].y, p[i].z);
      out.uv.push(uvs[i][0], 1 - uvs[i][1]);
      out.color.push(...col);
    }
  };

  const addElements = (part, matrix) => {
    for (const e of part.elements || []) {
      let m = matrix;
      const r = e.rotation;
      if (r) {
        const o = r.origin || [8, 8, 8];
        const turn = new M4();
        if (r.axis) {
          turn.makeRotationAxis(new V3(r.axis === 'x' ? 1 : 0, r.axis === 'y' ? 1 : 0, r.axis === 'z' ? 1 : 0), rad(r.angle || 0));
          if (r.rescale) {
            const k = 1 / Math.cos(rad(r.angle || 0));
            turn.multiply(new M4().makeScale(r.axis === 'x' ? 1 : k, r.axis === 'y' ? 1 : k, r.axis === 'z' ? 1 : k));
          }
        } else {
          turn.makeRotationFromEuler(new THREE.Euler(rad(r.x || 0), rad(r.y || 0), rad(r.z || 0), 'XYZ'));
        }
        m = matrix.clone().multiply(new M4().makeTranslation(...o)).multiply(turn).multiply(new M4().makeTranslation(-o[0], -o[1], -o[2]));
      }
      for (const [f, face] of Object.entries(e.faces || {})) {
        const texture = part.textures?.[String(face.texture).replace(/^#/, '')];
        if (!texture) continue;
        const [u0, v0, u1, v1] = (face.uv || defaultUv(f, e.from, e.to)).map((v) => v / 16);
        let uvs = [[u0, v0], [u0, v1], [u1, v1], [u1, v0]];
        const steps = (((face.rotation || 0) / 90) % 4 + 4) % 4;
        uvs = uvs.map((_, i) => uvs[(i + steps) % 4]);
        const tint = face.tintindex != null && part.tints?.[face.tintindex] != null ? part.tints[face.tintindex] : 0xffffff;
        quad(texture, faceCorners(f, e.from, e.to), uvs, m, tint);
      }
    }
  };

  // A box of an entity model, with the game's texture layout for boxes.
  const addBox = (texture, tw, th, [u, v, x, y, z, w, h, d], matrix) => {
    const x1 = x + w, y1 = y + h, z1 = z + d;
    const c = { a: [x, y, z], b: [x1, y, z], c: [x1, y1, z], d: [x, y1, z], e: [x, y, z1], f: [x1, y, z1], g: [x1, y1, z1], h: [x, y1, z1] };
    const face = (corners, ua, va, ub, vb) => quad(texture, corners,
      [[ub / tw, va / th], [ua / tw, va / th], [ua / tw, vb / th], [ub / tw, vb / th]], matrix, 0xffffff);
    face([c.f, c.e, c.a, c.b], u + d, v, u + d + w, v + d); // the face at the smaller y
    face([c.c, c.d, c.h, c.g], u + d + w, v + d, u + d + w + w, v);
    face([c.a, c.e, c.h, c.d], u, v + d, u + d, v + d + h);
    face([c.b, c.a, c.d, c.c], u + d, v + d, u + d + w, v + d + h);
    face([c.f, c.b, c.c, c.g], u + d + w, v + d, u + d + w + d, v + d + h);
    face([c.e, c.f, c.g, c.h], u + d + w + d, v + d, u + d + w + d + w, v + d + h);
  };

  for (const part of def.parts) {
    let m = gui.clone();
    for (const t of part.xf || []) m.multiply(transformation(t));
    if (part.elements) addElements(part, m);
    else if (part.special?.type === 'decorated_pot') addElements(POT, m);
    else if (SPECIAL[part.special?.type]) {
      const [texture, tw, th, pieces] = SPECIAL[part.special.type](part.special);
      for (const piece of pieces) {
        const pm = m.clone().multiply(new M4().makeTranslation(...(piece.at || [0, 0, 0])));
        if (piece.scale) pm.multiply(new M4().makeScale(piece.scale, piece.scale, piece.scale));
        for (const box of piece.boxes) addBox(texture, tw, th, box, pm);
      }
    }
  }
  if (!byTexture.size) return null;

  const scene = new THREE.Scene();
  const used = [];
  for (const [path, data] of byTexture) {
    const img = await loadImage(path);
    if (!img) continue;
    const map = new THREE.CanvasTexture(frame(img, null, path.startsWith('entity/')));
    map.magFilter = THREE.NearestFilter;
    map.minFilter = THREE.NearestFilter;
    map.generateMipmaps = false;
    map.colorSpace = THREE.SRGBColorSpace;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(data.pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(data.uv, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(data.color, 3));
    const mat = new THREE.MeshBasicMaterial({ map, vertexColors: true, side: THREE.DoubleSide, transparent: true, alphaTest: 0.02 });
    scene.add(new THREE.Mesh(geo, mat));
    used.push(map, geo, mat);
  }
  renderer.setClearColor(0x000000, 0);
  renderer.render(scene, camera);
  const out = canvas(SIZE, SIZE);
  out.getContext('2d').drawImage(renderer.domElement, 0, 0);
  for (const u of used) u.dispose();
  return out;
}

/* ---------- flat items ---------- */

async function drawFlat(def) {
  const out = canvas(SIZE, SIZE);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  let drawn = false;
  for (const part of def.parts) {
    for (const [i, path] of (part.layers || []).entries()) {
      const img = await loadImage(path);
      if (!img) continue;
      ctx.drawImage(frame(img, part.tints?.[i]), 0, 0, SIZE, SIZE);
      drawn = true;
    }
  }
  return drawn ? out : null;
}

const icons = new Map();
let queue = Promise.resolve(); // one 3D picture at a time: they share a renderer

// The item as its inventory icon: a data URL, or null if it can't be drawn.
export function itemIcon(id) {
  id = String(id).replace(/^minecraft:/, '');
  if (!ID_RE.test(id)) return Promise.resolve(null);
  if (!icons.has(id)) {
    icons.set(id, itemDef(id).then((def) => {
      if (!def?.parts?.length) return null;
      if (def.parts.every((p) => p.layers)) return drawFlat(def);
      const job = queue.then(() => draw3d(def));
      queue = job.catch(() => null);
      return job;
    }).then((c) => (c ? c.toDataURL() : null)).catch((err) => {
      console.error(`icon ${id}:`, err);
      return null;
    }));
  }
  return icons.get(id);
}
