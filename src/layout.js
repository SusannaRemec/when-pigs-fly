// Where everything on the island is. Pure data and maths, no Three.js, so that the
// game (collisions) and the Blender bake (tools/dump-layout.mjs -> blender/world_bake.py)
// read the same island. Coordinates are game coordinates: x east, z south, y up.

export function makeRnd(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

export const P = {
  barn: { x: -24, z: 30 },
  pen: { x: -8, z: 32, r: 4.6 },
  hay: { x: 22, z: -30 },
  hill: { x: -48, z: -38 },
  pit: { x: 36, z: 30, r: 4.4 },
  snow: { x: 57, z: 13 },
  mill: { x: -58, z: 20 },
  field: { x: -37, z: 45, hx: 6.5, hz: 5 },
  moon: [-50, 72, 125],
  // the newer jobs
  stone: { x: 48, z: -48 },                 // blood from a stone
  coop: { x: -2, z: 52 },                   // hen's teeth
  kennel: { x: -32, z: 6 },                 // old dog, new tricks
  cats: { x: 34, z: -6, r: 2.1 },           // herding cats, into this basket
  camp: { x: -8, z: -34 },                  // a watched pot
  hole: { x: 18, z: 46, r: 1.7 },           // square peg, round hole
  crate: { x: 40, z: 50 },
  horse: { x: 60, z: -38 },                 // knows the way into the barn
  pond: { x: 17, z: 14, depth: 3.4, s: 6 },   // a dip that fills with sea-level water; the pit path crosses it by bridge
  islet: { x: -79, z: 79, r: 8 },            // the lighthouse rock, joined to the south-west headland by a causeway
  herring: { x: -72, z: 30 }, worms: { x: -70, z: -30 }, ducks: { x: 64, z: 65 },
};
// The three places the end of the rainbow might be.
export const FAIRY_RINGS = [{ x: -20, z: -55 }, { x: 60, z: -2 }, { x: 10, z: 66 }];
// Stomp these in the order the horse gives to open the barn.
export const PLATES = [{ x: -16.5, z: 35.5, sym: 'sun' }, { x: -13.9, z: 37.6, sym: 'moon' }, { x: -17, z: 39.4, sym: 'star' }];
export const CAT_STARTS = [{ x: 48, z: -15 }, { x: 21, z: -12 }, { x: 41, z: 9 }];
export const HEN_STARTS = [{ x: 1.5, z: 49 }, { x: -5, z: 48.5 }, { x: -1, z: 56 }];
export const FLATS = [
  { x: P.pit.x, z: P.pit.z, r: 9 },
  { x: -17, z: 31, r: 15 },
  { x: P.hay.x, z: P.hay.z, r: 13 },
  { x: P.snow.x, z: P.snow.z, r: 5 },
  { x: P.mill.x, z: P.mill.z, r: 6 },
  { x: P.stone.x, z: P.stone.z, r: 4 }, { x: P.coop.x, z: P.coop.z, r: 5 }, { x: P.kennel.x, z: P.kennel.z, r: 4 },
  { x: P.cats.x, z: P.cats.z, r: 4 }, { x: P.camp.x, z: P.camp.z, r: 6.5 }, { x: P.hole.x, z: P.hole.z, r: 4 },
  { x: P.horse.x, z: P.horse.z, r: 4 }, { x: P.islet.x, z: P.islet.z, r: 4.5 },
];
export const ISLAND_R = 82;
// The coast is not a circle: three headlands push out from it, and one has an islet off its tip.
export const HEADLAND = { n: 3, phase: 0.785, out: 13 };
export const CAUSEWAY = { ax: -60, az: 60, bx: P.islet.x, bz: P.islet.z, hw: 2.6 };
export const coastR = (x, z) => ISLAND_R + HEADLAND.out * Math.max(0, Math.sin(HEADLAND.n * Math.atan2(z, x) + HEADLAND.phase)) ** 1.5;
// How far out to sea (x, z) is; zero or less on land.
export function offshore(x, z) {
  const c = CAUSEWAY, dx = c.bx - c.ax, dz = c.bz - c.az;
  const t = clamp(((x - c.ax) * dx + (z - c.az) * dz) / (dx * dx + dz * dz), 0, 1);
  return Math.min(Math.hypot(x, z) - coastR(x, z), Math.hypot(x - P.islet.x, z - P.islet.z) - P.islet.r, Math.hypot(x - c.ax - dx * t, z - c.az - dz * t) - c.hw);
}
// The bridge over the pond: a deck along the path, arched in the middle.
export const BRIDGE = { x: P.pond.x, z: P.pond.z, dx: 0.64, dz: 0.768, half: 7, hw: 1.5, rise: 1.0 };
export const WATER_Y = -0.55;
// Direction to the sun. The bake and the real-time light both use it.
export const SUN_DIR = [0.64, 0.5, 0.36];

function rawY(x, z) {
  let y = 1.3 * Math.sin(x * 0.07) * Math.cos(z * 0.06) + 0.7 * Math.sin(x * 0.13 + 1.7) * Math.sin(z * 0.11 + 0.5) + 1.3;
  y += 11 * Math.exp(-((x - P.hill.x) ** 2 + (z - P.hill.z) ** 2) / (13 * 13));
  y += 4.5 * Math.exp(-((x - P.stone.x) ** 2 + (z - P.stone.z) ** 2) / (9 * 9));           // the stone stands on a knoll
  y -= P.pond.depth * Math.exp(-((x - P.pond.x) ** 2 + (z - P.pond.z) ** 2) / (P.pond.s * P.pond.s));
  return y;
}
export function groundY(x, z) {
  let y = rawY(x, z);
  for (const f of FLATS) {
    const t = 1 - smooth(f.r, f.r * 1.7, Math.hypot(x - f.x, z - f.z));
    if (t > 0) y += (rawY(f.x, f.z) - y) * t;
  }
  const off = offshore(x, z);
  if (off > 0) y -= (off / 10) ** 2 * 5;
  return y;
}

// Dirt paths from the middle of the island out to each job.
export const PATHS = [
  [[0, 0], [-4, 12], [-9, 22], [-8, 26.5]],
  [[-9, 22], [-15, 27], [-19, 30]],
  [[0, 0], [8, -10], [15, -19], [20, -25]],
  [[0, 0], [12, 8], [22, 20], [29, 26]],
  [[40, 24], [48, 18], [54, 14]],
  [[0, 0], [-14, -8], [-28, -20], [-38, -30], [-45, -36]],
  [[-9, 22], [-20, 17.5], [-34, 17], [-47, 19], [-54, 20]],
  [[12, 8], [24, 2], [31, -4]],
  [[-14, -8], [-12, -20], [-9, -30]],
  [[-20, 17.5], [-27, 12], [-30.5, 8.5]],
];
export function pathDist(x, z) {
  let best = Infinity;
  for (const p of PATHS) {
    for (let i = 0; i < p.length - 1; i++) {
      const [ax, az] = p[i], [bx, bz] = p[i + 1];
      const dx = bx - ax, dz = bz - az;
      const t = clamp(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz), 0, 1);
      best = Math.min(best, Math.hypot(x - ax - dx * t, z - az - dz * t));
    }
  }
  return best;
}

export const HAY_SPOTS = [[0, 0], [7, 3], [-6, 5], [4, -7], [-7, -5], [11, -5]].map(([dx, dz]) => ({ x: P.hay.x + dx, z: P.hay.z + dz }));
// Nine places a four-leaf clover can turn up; each game uses four.
export const CLOVERS = [[4, -66], [-69, -4], [64, -24], [-30, 66], [-52, -55], [70, 30], [30, 70], [-66, 40], [-75, 85]].map(([x, z]) => ({ x, z }));
export const SIGNS = [
  { x: P.pen.x + 1, z: P.pen.z + 7.5 }, { x: P.hay.x - 2, z: P.hay.z + 11 }, { x: P.hill.x + 5, z: P.hill.z + 5 },
  { x: P.pit.x - 8, z: P.pit.z - 4 }, { x: P.snow.x + 4, z: P.snow.z - 5 },
  { x: P.stone.x - 5, z: P.stone.z + 4 }, { x: P.coop.x + 5.5, z: P.coop.z - 1 }, { x: P.kennel.x + 4.5, z: P.kennel.z - 3 },
  { x: P.cats.x + 4, z: P.cats.z - 4 }, { x: P.camp.x + 6, z: P.camp.z + 3 }, { x: P.hole.x - 4.5, z: P.hole.z - 3 },
  { x: P.horse.x - 4.5, z: P.horse.z + 3 }, { x: P.barn.x + 6.6, z: P.barn.z - 5.2 },
];
export const COW_STARTS = [{ x: -34, z: -10 }, { x: 14, z: 58 }];

// Things the pig bumps into, apart from trees. Circles: {x, z, r, h}. Boxes: {x, z, hx, hz, h}.
// h is height above the ground there; a pig above it passes over.
export const SOLIDS = [
  // The barn can be walked into once its doors are open, so the game gives it walls
  // (BARN_WALLS) and uses this box only from lid upward, to keep a flying pig off the rafters.
  { kind: 'barn', x: P.barn.x, z: P.barn.z, hx: 5, hz: 4, h: 7.1, lid: 5.2 },
  { kind: 'elephant', x: P.barn.x - 2.4, z: P.barn.z, r: 1.9, h: 5 },
  { kind: 'stone', x: P.stone.x, z: P.stone.z, r: 1.45, h: 5.2 },
  { kind: 'coop', x: P.coop.x, z: P.coop.z, hx: 1.5, hz: 1.2, h: 3.2 },
  { kind: 'kennel', x: P.kennel.x, z: P.kennel.z, hx: 1.0, hz: 1.2, h: 2.1 },
  { kind: 'tent', x: P.camp.x - 4.6, z: P.camp.z - 1.5, r: 1.7, h: 2.6 },
  { kind: 'pot', x: P.camp.x, z: P.camp.z, r: 0.95, h: 1.7 },
  { kind: 'horse', x: P.horse.x, z: P.horse.z, r: 1.5, h: 4.6 },
  { kind: 'lighthouse', x: P.islet.x, z: P.islet.z, r: 2.4, h: 17 },
  { kind: 'silo', x: P.barn.x - 3, z: P.barn.z - 8, r: 2.2, h: 10.1 },
  { kind: 'mill', x: P.mill.x, z: P.mill.z, r: 3.1, h: 15 },
  { kind: 'well', x: -14, z: 15.5, r: 1.25, h: 3.2 },
  { kind: 'scarecrow', x: P.field.x + 1, z: P.field.z - 0.6, r: 0.35, h: 3 },
  { kind: 'cart', x: 10.5, z: -27, r: 1.4, h: 2 },
  { kind: 'bales', x: -21, z: 37.8, r: 1.3, h: 1.9 },
  { kind: 'snowman', x: 62, z: 17.5, r: 0.9, h: 2.8 },
  // two sides of the crop-field fence; low enough to hop
  { kind: 'fence', x: P.field.x - P.field.hx - 0.6, z: P.field.z, hx: 0.15, hz: P.field.hz + 0.6, h: 1.15 },
  { kind: 'fence', x: P.field.x, z: P.field.z + P.field.hz + 0.6, hx: P.field.hx + 0.6, hz: 0.15, h: 1.15 },
];

// Barn floor is 0.8 above the ground, with a ramp up to the doors on the east side.
export const BARN_FLOOR = 0.8, BARN_RAMP = 2.8, DOOR_HW = 1.7;
export const BARN_WALLS = [
  { x: P.barn.x - 4.9, z: P.barn.z, hx: 0.12, hz: 4 },
  { x: P.barn.x, z: P.barn.z - 3.9, hx: 5, hz: 0.12 },
  { x: P.barn.x, z: P.barn.z + 3.9, hx: 5, hz: 0.12 },
  { x: P.barn.x + 4.9, z: P.barn.z - 2.85, hx: 0.12, hz: 1.15 },
  { x: P.barn.x + 4.9, z: P.barn.z + 2.85, hx: 0.12, hz: 1.15 },
  { x: P.barn.x + 4.9, z: P.barn.z, hx: 0.12, hz: DOOR_HW, door: true },
];
// Height of whatever the pig would stand on at (x, z): the ground, the barn floor or its ramp.
export function standY(x, z) {
  const dx = x - P.barn.x, dz = z - P.barn.z;
  if (Math.abs(dz) < 4 && Math.abs(dx) < 5) return groundY(P.barn.x, P.barn.z) + BARN_FLOOR;
  if (Math.abs(dz) < DOOR_HW + 0.3 && dx >= 5 && dx < 5 + BARN_RAMP) return Math.max(groundY(x, z), groundY(P.barn.x, P.barn.z) + BARN_FLOOR * (1 - (dx - 5) / BARN_RAMP));
  const b = BRIDGE, along = (x - b.x) * b.dx + (z - b.z) * b.dz, across = (x - b.x) * b.dz - (z - b.z) * b.dx;
  if (Math.abs(along) < b.half && Math.abs(across) < b.hw) return Math.max(groundY(x, z), bridgeY(along));
  return groundY(x, z);
}
export function bridgeY(along) {
  const b = BRIDGE, end = (groundY(b.x + b.dx * b.half, b.z + b.dz * b.half) + groundY(b.x - b.dx * b.half, b.z - b.dz * b.half)) / 2;
  return end + 0.12 + b.rise * (1 - (along / b.half) ** 2);
}

// Trees, and boulders too big to walk through.
export const TREES = [];
export const BOULDERS = [];
{
  const rnd = makeRnd(20261114);
  const keepOut = [
    [P.barn.x, P.barn.z, 15], [P.pen.x, P.pen.z, 13], [P.hay.x, P.hay.z, 15], [P.pit.x, P.pit.z, 14], [P.snow.x, P.snow.z, 13],
    [0, 0, 13], [P.hill.x, P.hill.z, 15], [P.mill.x, P.mill.z, 10], [P.field.x, P.field.z, 10.5],
    [P.stone.x, P.stone.z, 7], [P.coop.x, P.coop.z, 9], [P.kennel.x, P.kennel.z, 7], [P.cats.x, P.cats.z, 7], [P.camp.x, P.camp.z, 10],
    [P.hole.x, P.hole.z, 6.5], [P.crate.x, P.crate.z, 5], [P.horse.x, P.horse.z, 7], [P.herring.x, P.herring.z, 4], [P.worms.x, P.worms.z, 4],
    [P.pond.x, P.pond.z, 9.5], ...FAIRY_RINGS.map((f) => [f.x, f.z, 6]), ...CAT_STARTS.map((c) => [c.x, c.z, 4]),
    ...SOLIDS.filter((s) => s.r && s.r < 2 && s.kind !== 'elephant').map((s) => [s.x, s.z, 4]),
    ...CLOVERS.map((c) => [c.x, c.z, 4]), ...SIGNS.map((s) => [s.x, s.z, 4]), ...COW_STARTS.map((c) => [c.x, c.z, 5]),
  ];
  const free = (x, z, pad = 0) => keepOut.every(([px, pz, r]) => Math.hypot(x - px, z - pz) > r + pad) && pathDist(x, z) > 3.2 + pad;
  const far = (list, x, z, d) => list.every((t) => Math.hypot(x - t.x, z - t.z) > d);

  let guard = 0;
  while (TREES.length < 74 && guard++ < 4000) {
    const a = rnd() * Math.PI * 2, r = 12 + rnd() * 66;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (!free(x, z) || !far(TREES, x, z, 4.2)) continue;
    const k = rnd();
    TREES.push({ x, z, s: 0.8 + rnd() * 0.9, kind: k < 0.16 ? 'blossom' : k < 0.36 ? 'round' : 'pine', seed: (rnd() * 1e6) | 0 });
  }
  // a few set pieces: frosted pines by the snowball, dead trees by the pit
  TREES.push({ x: 65, z: 20, s: 0.95, kind: 'snowpine', seed: 1 }, { x: 66.5, z: 9.5, s: 1.25, kind: 'snowpine', seed: 2 }, { x: 62.5, z: 2.5, s: 0.8, kind: 'snowpine', seed: 3 });
  TREES.push({ x: 46, z: 36.5, s: 1.0, kind: 'dead', seed: 4 }, { x: 32.5, z: 41.5, s: 1.2, kind: 'dead', seed: 5 }, { x: 43, z: 20.5, s: 0.85, kind: 'dead', seed: 6 });

  for (let i = 0; i < 7; i++) { // tumbled down the hill
    const a = 0.6 + (i / 7) * Math.PI * 2 + rnd() * 0.5, r = 9.5 + rnd() * 6;
    const x = P.hill.x + Math.cos(a) * r, z = P.hill.z + Math.sin(a) * r;
    if (pathDist(x, z) < 3 || SIGNS.some((s) => Math.hypot(x - s.x, z - s.z) < 4)) continue;
    BOULDERS.push({ x, z, r: 0.95 + rnd() * 0.45, seed: (rnd() * 1e6) | 0 });
  }
  guard = 0;
  while (BOULDERS.length < 15 && guard++ < 2000) {
    const a = rnd() * Math.PI * 2, r = 14 + rnd() * 62;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (!free(x, z, -4) || pathDist(x, z) < 4 || !far(TREES, x, z, 3) || !far(BOULDERS, x, z, 6)) continue;
    BOULDERS.push({ x, z, r: 0.8 + rnd() * 0.6, seed: (rnd() * 1e6) | 0 });
  }
}

// Everything in one list, in the form the game's collision loop wants.
export function buildColliders() {
  const out = [];
  for (const s of SOLIDS) {
    const base = groundY(s.x, s.z), top = base + s.h;
    const c = s.r ? { x: s.x, z: s.z, r: s.r, top, kind: s.kind } : { x: s.x, z: s.z, hx: s.hx, hz: s.hz, top, kind: s.kind };
    if (s.lid) c.bottom = base + s.lid;
    out.push(c);
  }
  const barnBase = groundY(P.barn.x, P.barn.z);
  for (const w of BARN_WALLS) out.push({ ...w, top: barnBase + 5.3, kind: w.door ? 'door' : 'wall' });
  for (const t of TREES) out.push({ x: t.x, z: t.z, r: (t.kind === 'dead' ? 0.4 : 0.5) * t.s, top: groundY(t.x, t.z) + 6 * t.s, kind: 'tree' });
  for (const b of BOULDERS) out.push({ x: b.x, z: b.z, r: b.r * 0.85, top: groundY(b.x, b.z) + b.r * 1.1 });
  return out;
}

// Small props that must not land on a tree: each takes the nearest clear spot to where it would like to be.
function clearSpot(x, z, need = 2.4) {
  const solid = buildColliders();
  for (let i = 0; i < 80; i++) {
    const a = i * 2.4, r = i * 0.3, px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
    if (solid.every((c) => (c.r !== undefined ? Math.hypot(px - c.x, pz - c.z) > c.r + need : Math.abs(px - c.x) > c.hx + need || Math.abs(pz - c.z) > c.hz + need))) return { x: px, z: pz };
  }
  return { x, z };
}
export const SPOTS = { poke: clearSpot(-20, -24), bucket: clearSpot(-11.4, 17.2, 1.2), pearls: clearSpot(30, -74) };
export const CLOUD9 = [26, 44, -44];
// three ducks in a row, just offshore
export const DUCKS = [-1, 0, 1].map((i) => { const a = Math.atan2(P.ducks.z, P.ducks.x); return { x: P.ducks.x - Math.sin(a) * i * 2.1, z: P.ducks.z + Math.cos(a) * i * 2.1, yaw: -a }; });
