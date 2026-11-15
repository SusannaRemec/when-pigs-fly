import * as THREE from 'three';
import { GLTFLoader } from '../vendor/loaders/GLTFLoader.js';
import { DRACOLoader } from '../vendor/loaders/DRACOLoader.js';
import { EffectComposer } from '../vendor/postprocessing/EffectComposer.js';
import { RenderPass } from '../vendor/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '../vendor/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '../vendor/postprocessing/OutputPass.js';
import { P, SUN_DIR, WATER_Y, groundY, standY, makeRnd, buildColliders, CLOVERS, FAIRY_RINGS, PLATES, CAT_STARTS, HEN_STARTS, COW_STARTS, TREES, SPOTS, HEADLAND, CAUSEWAY, BRIDGE, offshore } from './layout.js';
import { loadCritters, pose } from './critters.js';
import { createPig } from './pig.js';
import { Sfx } from './audio.js';
import { HEAT_R, slipChance, slipWords, meltSeconds, makeDice } from './odds.js';
import { createRecorder } from './telemetry.js';
import { steer, fall, contain, collide, land } from './move.js';

// ---------------------------------------------------------------- setup
const $ = (id) => document.getElementById(id);
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xffdccb, 110, 460);
const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 1500);
const sfx = new Sfx();

// Everything is drawn through a soft bloom, so the sun, the lava, the beams and (later) the stars glow.
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
composer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.3, 0.7, 1.0);
composer.addPass(bloom);
composer.addPass(new OutputPass());

function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  composer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// The island's shape and contents live in layout.js, shared with the Blender bake.
const rnd = makeRnd(99); // cosmetic scatter only
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const MOON_POS = new THREE.Vector3(...P.moon);
const SUN = new THREE.Vector3(...SUN_DIR).normalize();

// ---------------------------------------------------------------- this game's draw
// Twelve impossible things live on the island; each game asks for five of them. The seed also
// decides where the clovers are, what the dog wants to learn and how the barn opens.
// play.html?seed=7 replays a draw; ?feats=stone,hens,dog,cats,pot picks the list by hand.
const params = new URLSearchParams(location.search);
const seed = params.has('seed') ? parseInt(params.get('seed'), 10) || 1 : (Math.random() * 2 ** 31) | 0;
const draw = makeRnd(seed);
const dice = makeDice(makeRnd(seed ^ 0x5eed)); // its own stream, so rolling it never changes the draw
const shuffled = (list) => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) { const j = (draw() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};
const FEATS = {
  needle: 'Find a needle in a haystack',
  clover: 'Four four-leaf clovers <small id="cloverN">0/4</small>',
  lightning: 'Lightning strikes twice',
  hell: "A snowball's chance in hell",
  cows: 'Wait till the cows come home <small id="cowN">0/2</small>',
  stone: 'Get blood from a stone',
  hens: "Find hen's teeth",
  dog: 'Teach an old dog new tricks',
  cats: 'Herd cats <small id="catN">0/3</small>',
  rainbow: 'Reach the end of the rainbow',
  pot: 'Watch a pot until it boils',
  peg: 'Fit a square peg in a round hole',
};
let active = (params.get('feats') || '').split(',').filter((k, i, a) => FEATS[k] && a.indexOf(k) === i).slice(0, 5);
if (active.length < 5) {
  const last = (localStorage.getItem('wpf-last') || '').split(',');
  for (let tries = 0; tries < 6; tries++) { // not the same list as last time
    active = shuffled(Object.keys(FEATS)).slice(0, 5);
    if (active.filter((k) => last.includes(k)).length <= 3) break;
  }
  if (!params.has('seed')) localStorage.setItem('wpf-last', active.join(','));
}
active = Object.keys(FEATS).filter((k) => active.includes(k));
const isActive = (k) => active.includes(k);
$('feats').innerHTML = active.map((k) => `<li data-k="${k}">${FEATS[k]}</li>`).join('')
  + '<li data-k="moon" class="locked">Once in a blue moon…</li><li class="secrets">Secrets found <small id="secretN">0/15</small></li>';
// counters for jobs that are not on today's list still need somewhere to write
for (const id of ['cloverN', 'cowN', 'catN']) if (!$(id)) { const e = document.createElement('i'); e.id = id; e.hidden = true; document.body.append(e); }

// ---------------------------------------------------------------- sky, light
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(1000, 32, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      top: { value: new THREE.Color(0x4f9ff0) },
      mid: { value: new THREE.Color(0xa9d8ff) },
      bot: { value: new THREE.Color(0xffdccb) },
    },
    vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform vec3 top; uniform vec3 mid; uniform vec3 bot; varying vec3 vP;
      void main(){ float h = normalize(vP).y;
        vec3 c = mix(bot, mid, smoothstep(-0.02, 0.22, h));
        c = mix(c, top, smoothstep(0.18, 0.85, h));
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
  }),
);
scene.add(sky);

// The island itself is drawn with lighting baked in Blender. These lights are for the
// things that move (pig, cows, snowball, haystacks) and point the same way as the baked sun.
const hemi = new THREE.HemisphereLight(0xd6e8ff, 0xb3ad90, 1.3);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffe2bd, 2.5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -38, right: 38, top: 38, bottom: -38, near: 1, far: 260 });
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.05;
scene.add(sun, sun.target);

// ---------------------------------------------------------------- helpers
const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...extra });
function mesh(geo, mat, x = 0, y = 0, z = 0, parent = scene) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}
const colliders = buildColliders(); // {x,z,r,top} circles or {x,z,hx,hz,top} boxes
const cowColliders = [...colliders];  // the barn door stays shut to cows even once it is open

const signs = {}; // by first line, so a job can repaint its sign when it is done
function makeSign(lines, x, z, rotY = 0) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const g = c.getContext('2d');
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const paint = (text) => {
    g.fillStyle = '#d7a364'; g.fillRect(0, 0, 512, 256);
    g.strokeStyle = '#6b4423'; g.lineWidth = 14; g.strokeRect(7, 7, 498, 242);
    g.fillStyle = '#3b1d3a'; g.textAlign = 'center'; g.textBaseline = 'middle';
    text.forEach((l, i) => {
      let size = i === 0 ? 58 : 34;
      const font = () => (g.font = `${i === 0 ? 900 : 700} ${size}px Georgia, serif`);
      font();
      while (g.measureText(l).width > 456 && size > 18) { size -= 2; font(); }
      g.fillText(l, 256, text.length === 1 ? 128 : 84 + i * 62 - (text.length - 2) * 22);
    });
    tex.needsUpdate = true;
  };
  paint(lines);
  const grp = new THREE.Group();
  const y = groundY(x, z);
  mesh(new THREE.CylinderGeometry(0.14, 0.14, 2.4, 8), std(0x6b4423), 0, 1.2, 0, grp);
  mesh(new THREE.BoxGeometry(3.6, 1.8, 0.14), std(0x6b4423), 0, 2.9, 0, grp);
  const face = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 });
  const f = mesh(new THREE.PlaneGeometry(3.5, 1.7), face, 0, 2.9, 0.08, grp);
  const b = mesh(new THREE.PlaneGeometry(3.5, 1.7), face, 0, 2.9, -0.08, grp);
  f.castShadow = b.castShadow = false;
  b.rotation.y = Math.PI;
  grp.position.set(x, y, z);
  grp.rotation.y = rotY;
  scene.add(grp);
  grp.wobble = 0;
  grp.repaint = (text) => { paint(text); grp.wobble = 1; };
  signs[lines[0]] = grp;
  return grp;
}
const SIGN_AFTER = {
  needle: [['NEEDLE', ['NEEDLE', 'Found. Please stop digging.']]],
  lightning: [['LIGHTNING ROD', ['LIGHTNING ROD', 'Struck: twice. We apologise.']]],
  hell: [['HELL', ['HELL', 'pop. 1 snowball  ·  skating daily']], ['SNOWBALL', ['SNOWBALL', 'Gone somewhere warmer']]],
  cows: [['HOME', ['HOME', '(cows in. Finally.)']]],
  stone: [['THE STONE', ['THE STONE', 'Contains slightly less blood']]],
  hens: [["HEN'S TEETH", ["HEN'S TEETH", 'Less rare than advertised']]],
  dog: [['OLD DOG', ['OLD DOG', 'Knows three new tricks']]],
  cats: [['HERD CATS', ['CATS', 'Herded. Do not make eye contact.']]],
  pot: [['A WATCHED POT', ['A WATCHED POT', 'Boils, if stared at hard enough']]],
  peg: [['ROUND HOLE', ['SQUARE-ISH HOLE', 'Standards have slipped']]],
  barn: [['BARN', ['BARN', 'Open. Nothing large in here.']], ['THE HORSE', ['THE HORSE', 'Has said too much']]],
};
const resign = (key) => (SIGN_AFTER[key] || []).forEach(([name, text]) => signs[name] && signs[name].repaint(text));

// A beam of light over a job, shown only if the job is on today's list.
const beacon = (key, ...args) => { const b = makeBeacon(...args); b.visible = isActive(key); return b; };
function makeBeacon(color, x, z, h = 70) {
  const m = new THREE.Mesh(
    new THREE.CylinderGeometry(0.7, 0.7, h, 12, 1, true),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.15, depthWrite: false, side: THREE.DoubleSide, fog: false, blending: THREE.AdditiveBlending }),
  );
  m.position.set(x, groundY(x, z) + h / 2, z);
  scene.add(m);
  return m;
}

// particles
const particles = [];
const pGeo = new THREE.IcosahedronGeometry(0.16, 0);
for (let i = 0; i < 140; i++) {
  const m = new THREE.Mesh(pGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }));
  m.visible = false;
  scene.add(m);
  particles.push({ m, v: new THREE.Vector3(), life: 0, g: 9 });
}
let pIdx = 0;
function burst(pos, color, n = 14, speed = 5, grav = 9, size = 1) {
  for (let i = 0; i < n; i++) {
    const p = particles[pIdx++ % particles.length];
    p.m.visible = true;
    p.m.position.copy(pos);
    p.m.material.color.set(color);
    p.m.scale.setScalar(size * (0.6 + Math.random() * 0.9));
    p.v.set(Math.random() - 0.5, Math.random() * 0.9 + 0.2, Math.random() - 0.5).normalize().multiplyScalar(speed * (0.4 + Math.random()));
    p.life = 0.7 + Math.random() * 0.7;
    p.g = grav;
  }
}

// ---------------------------------------------------------------- the island (baked in Blender)
// assets/world.glb comes from blender/world_bake.py: terrain and barn with their lighting in a
// texture, everything else with it in vertex colours. All of it is drawn unlit.
const world = { blades: null, doorN: null, doorS: null }; // plus every baked object, by name
const worldMats = []; // tinted together as the afternoon turns to dusk
function grainTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#808080'; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 5200; i++) {
    const x = rnd() * 256, y = rnd() * 256, len = 3 + rnd() * 9, lean = (rnd() - 0.5) * 4, v = (40 + rnd() * 175) | 0;
    g.strokeStyle = `rgba(${v},${v},${v},0.55)`;
    g.lineWidth = 1 + rnd();
    for (const ox of [-256, 0, 256]) for (const oy of [-256, 0, 256]) { // wrap, so it tiles
      g.beginPath(); g.moveTo(x + ox, y + oy); g.lineTo(x + ox + lean, y + oy - len); g.stroke();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}
{
  const loader = new GLTFLoader().setDRACOLoader(new DRACOLoader().setDecoderPath('./vendor/draco/'));
  const gltf = await loader.loadAsync('./assets/world.glb');
  {
    let terrain = null;
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      const map = o.material.map;
      if (map) map.anisotropy = renderer.capabilities.getMaxAnisotropy();
      o.material = map ? new THREE.MeshBasicMaterial({ map }) : new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
      world[o.name] = o;
      if (o.name === 'bucket') { // it tumbles, so the game lights it rather than the bake
        o.material = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.55, roughness: 0.4, side: THREE.DoubleSide });
        o.castShadow = true;
        return;
      }
      if (['crate', 'gold', 'poke'].includes(o.name)) o.castShadow = true; // baked without a shadow of their own, since they move
      worldMats.push(o.material);
      if (o.name === 'terrain') {
        terrain = o;
        // The bake is about 5 cm a texel; a tiling grain on top keeps the ground crisp under the pig's nose.
        o.material.onBeforeCompile = (sh) => {
          sh.uniforms.detailMap = { value: grainTexture() };
          sh.fragmentShader = sh.fragmentShader
            .replace('void main() {', 'uniform sampler2D detailMap;\nvoid main() {')
            .replace('#include <map_fragment>', `#include <map_fragment>
              diffuseColor.rgb *= 0.77 + 0.32 * texture2D(detailMap, vMapUv * 52.0).r + 0.14 * texture2D(detailMap, vMapUv * 13.0 + 0.37).r;`);
        };
      }
      if (o.name === 'blades') world.blades = o;
      if (o.name === 'door_n') world.doorN = o;
      if (o.name === 'door_s') world.doorS = o;
    });
    scene.add(gltf.scene);
    // Baked ground cannot take real-time shadows, so a second copy of it draws only
    // the shadows of whatever moves.
    terrain.geometry.computeVertexNormals();
    const catcher = new THREE.Mesh(terrain.geometry, new THREE.ShadowMaterial({
      color: 0x16224a, opacity: 0.44, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
    }));
    catcher.receiveShadow = true;
    terrain.add(catcher);
  }
}

// sea: turquoise shallows, deeper blue further out, foam lapping at the real shoreline
const waterMat = new THREE.ShaderMaterial({
  transparent: true, fog: true,
  uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { time: { value: 0 }, waterY: { value: WATER_Y }, tint: { value: new THREE.Color(1, 1, 1) } }]),
  vertexShader: `varying vec3 vW;
    #include <fog_pars_vertex>
    void main(){ vec4 wp = modelMatrix * vec4(position, 1.0); vW = wp.xyz; vec4 mvPosition = viewMatrix * wp; gl_Position = projectionMatrix * mvPosition;
      #include <fog_vertex>
    }`,
  defines: {
    POND: `vec2(${P.pond.x.toFixed(2)}, ${P.pond.z.toFixed(2)})`, POND_D: P.pond.depth.toFixed(2), POND_S: P.pond.s.toFixed(2),
    ISLET: `vec3(${P.islet.x.toFixed(2)}, ${P.islet.z.toFixed(2)}, ${P.islet.r.toFixed(2)})`,
    CW_A: `vec2(${CAUSEWAY.ax.toFixed(2)}, ${CAUSEWAY.az.toFixed(2)})`, CW_B: `vec2(${CAUSEWAY.bx.toFixed(2)}, ${CAUSEWAY.bz.toFixed(2)})`, CW_HW: CAUSEWAY.hw.toFixed(2),
    HL_OUT: HEADLAND.out.toFixed(2), HL_N: HEADLAND.n.toFixed(2), HL_PHASE: HEADLAND.phase.toFixed(3),
  },
  fragmentShader: `uniform float time; uniform float waterY; uniform vec3 tint; varying vec3 vW;
    #include <fog_pars_fragment>
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
    void main(){
      float x = vW.x, z = vW.z, r = length(vW.xz);
      // the island's own height formula (layout.js), near enough at the coast
      float h = 1.3 * sin(x * 0.07) * cos(z * 0.06) + 0.7 * sin(x * 0.13 + 1.7) * sin(z * 0.11 + 0.5) + 1.3;
      h -= POND_D * exp(-dot(vW.xz - POND, vW.xz - POND) / (POND_S * POND_S));
      vec2 ab = CW_B - CW_A; float ct = clamp(dot(vW.xz - CW_A, ab) / dot(ab, ab), 0.0, 1.0);
      float off = min(min(r - (82.0 + HL_OUT * pow(max(0.0, sin(HL_N * atan(z, x) + HL_PHASE)), 1.5)), distance(vW.xz, ISLET.xy) - ISLET.z), distance(vW.xz, CW_A + ab * ct) - CW_HW);
      float e = max(off, 0.0) / 10.0; h -= e * e * 5.0;
      float depth = max(waterY - h, 0.0);
      float n = noise(vW.xz * 0.3 + time * 0.2);
      float deep = smoothstep(0.0, 11.0, depth + n * 2.0);
      vec3 c = mix(vec3(0.30, 0.78, 0.74), vec3(0.07, 0.36, 0.66), deep);
      float w = noise(vW.xz * 0.8 + vec2(time * 0.5, time * 0.3)) * noise(vW.xz * 1.5 - vec2(time * 0.4, time * 0.25));
      c += vec3(1.0, 0.94, 0.82) * smoothstep(0.42, 0.62, w) * 0.22 * smoothstep(240.0, 30.0, distance(cameraPosition, vW));
      float lap = 0.35 * sin(time * 0.9 + n * 5.0);
      float foam = smoothstep(0.85, 0.0, depth + n * 0.5 - lap);
      foam += smoothstep(0.16, 0.0, abs(depth - 1.7 - 0.5 * sin(time * 0.6 + n * 6.0))) * 0.3 * n;
      foam = clamp(foam, 0.0, 1.0) * mix(0.18, 1.0, smoothstep(6.0, 12.0, distance(vW.xz, POND))); // the pond is still water
      c = mix(c, vec3(1.0), foam * 0.9);
      gl_FragColor = vec4(c * tint, max(mix(0.55, 0.96, deep), foam));
      #include <colorspace_fragment>
      #include <fog_fragment>
    }`,
});
{
  const water = new THREE.Mesh(new THREE.CircleGeometry(900, 64), waterMat);
  water.rotation.x = -Math.PI / 2;
  water.position.y = WATER_Y;
  scene.add(water);
}

// a low sun, where the baked light comes from
const glowTex = (stops) => {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d'), grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  stops.forEach(([o, col]) => grad.addColorStop(o, col));
  g.fillStyle = grad; g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
};
const sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({
  map: glowTex([[0, 'rgba(255,250,230,1)'], [0.07, 'rgba(255,244,205,1)'], [0.11, 'rgba(255,214,150,0.5)'], [0.4, 'rgba(255,190,140,0.14)'], [1, 'rgba(255,180,140,0)']]),
  blending: THREE.AdditiveBlending, depthWrite: false, fog: false, transparent: true,
}));
sunGlow.scale.setScalar(560);
scene.add(sunGlow);

// ---------------------------------------------------------------- scenery
makeSign(['HOME', '(cows only)'], P.pen.x + 1, P.pen.z + 7.5, Math.PI);

const clouds = [];
let cloudMat = null;
{
  const cm = cloudMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.3, roughness: 1, flatShading: true, fog: false });
  for (let i = 0; i < 18; i++) {
    const g = new THREE.Group();
    const n = 4 + (rnd() * 4 | 0);
    for (let j = 0; j < n; j++) {
      const m = new THREE.Mesh(new THREE.IcosahedronGeometry(3 + rnd() * 4, 1), cm);
      m.position.set((j - n / 2) * 4.2, rnd() * 2.2, rnd() * 4 - 2);
      m.scale.y = 0.6;
      g.add(m);
    }
    g.position.set(rnd() * 440 - 220, 34 + rnd() * 60, rnd() * 440 - 220);
    scene.add(g);
    clouds.push(g);
  }
}

// moon
const moonMat = new THREE.MeshBasicMaterial({ color: 0xfff7e0, fog: false });
const moon = new THREE.Mesh(new THREE.SphereGeometry(10, 32, 20), moonMat);
moon.position.copy(MOON_POS);
scene.add(moon);
{
  const craterM = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.08, fog: false });
  for (let i = 0; i < 9; i++) {
    const v = new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize().multiplyScalar(9.7);
    const cr = new THREE.Mesh(new THREE.SphereGeometry(1 + rnd() * 1.6, 12, 8), craterM);
    cr.position.copy(v);
    moon.add(cr);
  }
}

// ---------------------------------------------------------------- the pig
const critters = await loadCritters();
const pig = createPig(critters);
scene.add(pig.group);
const pos = new THREE.Vector3(0, groundY(0, 0), 0);
let yaw = 0.5, speed = 0, vy = 0, grounded = true, flaps = 0, soot = 0;
let wingScale = 0.22, autoFlapT = 0;
const shore = { x: 0, z: 0 }; // the last spot the sea allowed
// move.js works on a plain body; these copy the pig into one and back.
const body = {};
const pack = () => Object.assign(body, { x: pos.x, y: pos.y, z: pos.z, yaw, speed, vy, grounded });
const unpack = () => { pos.set(body.x, body.y, body.z); ({ yaw, speed, vy, grounded } = body); };
pig.setWingScale(wingScale);

// ---------------------------------------------------------------- game state
const feats = Object.fromEntries(Object.keys(FEATS).map((k) => [k, false]));
let slowT = 0, shake = 0, squash = 0;
const jolt = (a) => { shake = Math.max(shake, a); };
const ev = { hop: false, oink: false }; // things the pig did this frame, for anyone watching
let count = 0, started = false, won = false, finale = false, time = 0, firstPerson = false;

const toastEl = $('toast');
let toastT = 0;
// Things that happen a little later happen in game time, not by the wall clock, so slow motion,
// a hidden tab and a test stepping the game by hand all see them at the same moment.
const pending = [];
const later = (sec, fn) => pending.push({ at: clock + sec, fn });
let clock = 0;
function runPending(dt) {
  clock += dt;
  for (let i = pending.length - 1; i >= 0; i--) if (pending[i].at <= clock) pending.splice(i, 1)[0].fn();
}
function say(text, dur = 4.5) {
  toastEl.textContent = text;
  toastEl.classList.add('show');
  toastT = dur;
}
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

const luckEl = $('luck'); // missing on a page cached from before it existed
function refreshHud() {
  const pct = count * 20;
  $('fill').style.width = pct + '%';
  $('pct').textContent = pct + '%';
  const odds = [3720000, 172000, 8100, 370, 19, 1][count];
  $('oddsN').textContent = won ? 'certain' : '1 in ' + odds.toLocaleString('en-US');
  $('oddsNote').textContent = won ? 'Physics has left the building.' : ['About as likely as a polite seagull.', 'Slightly likelier than matching socks.', 'Roughly a cat coming when called.', 'On a par with a short meeting.', 'Bookmakers have stopped answering the phone.', 'There is a moon in the way. Go over it.'][count];
  if (luckEl) luckEl.textContent = finale ? '' : count >= 4 ? 'Nothing goes wrong any more.' : `Things go wrong ${slipWords(count)}.`;
  sfx.setProgress(count, finale, won);
  if (count) { $('meter').classList.remove('pop'); void $('meter').offsetWidth; $('meter').classList.add('pop'); }
  document.querySelectorAll('#feats li').forEach((li) => {
    const k = li.dataset.k;
    if (k === 'moon') { li.classList.toggle('locked', !finale); li.classList.toggle('done', won); } else if (k) li.classList.toggle('done', !!feats[k]);
  });
}

const WING_NOTES = [
  '', 'Your wings twitched. You can flap once in mid-air.', 'Bigger wings. Two flaps, and you can glide.',
  'Three flaps. The barn roof is looking reachable.', 'Four flaps. Physics is filing a complaint.',
];
function complete(key, line) {
  if (feats[key]) return;
  feats[key] = true;
  tele.note('done', key);
  sfx.feat();
  burst(pos.clone().add(new THREE.Vector3(0, 2, 0)), 0xffc93c, 26, 7, 6);
  resign(key);
  for (const c of [0xff9db5, 0x6dff8e, 0x7fd0ff, 0xffffff]) burst(pos.clone().add(new THREE.Vector3(0, 2.5, 0)), c, 9, 8, 7, 0.9);
  slowT = 0.55; jolt(0.3);
  if (!isActive(key)) { say(`${line} (Not on today's list. Nobody can take it from you.)`, 5.5); return; }
  count++;
  if (count < 5) {
    say(line, 4);
    const note = WING_NOTES[count];
    later(4.2, () => say(note, 4));
  } else {
    say(line, 3.5);
    later(3.6, startFinale);
  }
  refreshHud();
}

// Something went wrong because the odds are still long. The first time, say what shortens them.
function mishap(kind, line) {
  stats[kind]++;
  tele.note('mishap', kind);
  say(stats.slips + stats.melts === 1 ? `${line} Finish any job and the dice get kinder.` : line, 4.2);
  if (luckEl) { luckEl.classList.remove('pop'); void luckEl.offsetWidth; luckEl.classList.add('pop'); }
}

// ---------------------------------------------------------------- feat 1: needle in a haystack
const stacks = [];
let needle = null;
{
  const hayM = std(0xe9c558, { flatShading: true });
  const spots = [[0, 0], [7, 3], [-6, 5], [4, -7], [-7, -5], [11, -5]];
  for (const [dx, dz] of spots) {
    const x = P.hay.x + dx, z = P.hay.z + dz, y = groundY(x, z);
    const g = new THREE.Group();
    g.position.set(x, y, z);
    scene.add(g);
    const m = mesh(new THREE.IcosahedronGeometry(2, 1), hayM, 0, 1.3, 0, g);
    m.scale.set(1, 0.95, 1);
    mesh(new THREE.ConeGeometry(1.5, 1.2, 9), hayM, 0, 3.2, 0, g);
    stacks.push({ g, x, z, checked: false, squash: 1 });
  }
  makeSign(['NEEDLE', 'in here. Somewhere.'], P.hay.x - 2, P.hay.z + 11, 0);
}
const hayBeacon = beacon('needle', 0xffe27a, P.hay.x + 1, P.hay.z - 1);
const HAY_LINES = ['Just hay.', 'Hay. Also hay.', 'More hay.', 'Hay, with notes of hay.', "It's always in the last place you look."];

// ---------------------------------------------------------------- feat 2: four-leaf clovers
const clovers = [];
let cloverCount = 0;
{
  const leafM = std(0x2fbf5a, { emissive: 0x1c7a35, emissiveIntensity: 0.6 });
  for (const { x, z } of shuffled(CLOVERS).slice(0, 4)) {
    const g = new THREE.Group();
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const leaf = mesh(new THREE.SphereGeometry(0.42, 12, 8), leafM, Math.cos(a) * 0.42, 0, Math.sin(a) * 0.42, g);
      leaf.scale.y = 0.25;
    }
    mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.9, 6), leafM, 0, -0.45, 0, g);
    g.position.set(x, groundY(x, z) + 1.4, z);
    g.rotation.x = 0.5;
    scene.add(g);
    clovers.push({ g, x, z, got: false, beacon: beacon('clover', 0x6dff8e, x, z) });
  }
}

// ---------------------------------------------------------------- feat 3: lightning strikes twice
const rod = { x: P.hill.x, z: P.hill.z, y: groundY(P.hill.x, P.hill.z), strikes: 0, timer: 0 };
mesh(new THREE.CylinderGeometry(0.08, 0.12, 7, 8), std(0x9aa3ad, { metalness: 0.8, roughness: 0.3 }), rod.x, rod.y + 3.5, rod.z);
mesh(new THREE.SphereGeometry(0.28, 12, 8), std(0xffc93c, { metalness: 0.8, roughness: 0.3 }), rod.x, rod.y + 7.1, rod.z);
makeSign(['LIGHTNING ROD', 'Struck: never twice'], rod.x + 5, rod.z + 5, 0.8);
const rodBeacon = beacon('lightning', 0xfff27a, rod.x, rod.z);
const stormCloud = new THREE.Group();
{
  const dm = new THREE.MeshStandardMaterial({ color: 0x5b6070, roughness: 1, flatShading: true });
  for (let j = 0; j < 6; j++) {
    const m = new THREE.Mesh(new THREE.IcosahedronGeometry(3.2 + rnd() * 2, 1), dm);
    m.position.set((j - 2.5) * 3.2, rnd() * 1.5, rnd() * 4 - 2);
    m.scale.y = 0.6;
    stormCloud.add(m);
  }
  stormCloud.position.set(rod.x, rod.y + 26, rod.z);
  scene.add(stormCloud);
}
let bolt = null, boltT = 0;
function strike() {
  const pts = [];
  const top = stormCloud.position.clone();
  const end = new THREE.Vector3(rod.x, rod.y + 7, rod.z);
  for (let i = 0; i <= 9; i++) {
    const p = top.clone().lerp(end, i / 9);
    if (i > 0 && i < 9) { p.x += (Math.random() - 0.5) * 3.5; p.z += (Math.random() - 0.5) * 3.5; }
    pts.push(p);
  }
  if (bolt) { scene.remove(bolt); bolt.geometry.dispose(); }
  bolt = new THREE.Mesh(
    new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.05), 48, 0.22, 6),
    new THREE.MeshBasicMaterial({ color: 0xfffbd0, fog: false }),
  );
  scene.add(bolt);
  boltT = 0.28;
  $('flash').style.transition = 'none';
  $('flash').style.opacity = 0.85;
  requestAnimationFrame(() => { $('flash').style.transition = 'opacity .6s'; $('flash').style.opacity = 0; });
  sfx.thunder();
  soot = 1; jolt(1);
  tele.note('lightning', rod.strikes);
  vy = 9; grounded = false; speed = 0;
  burst(pos.clone().add(new THREE.Vector3(0, 1.5, 0)), 0x444444, 18, 4, 2, 1.6);
}

// ---------------------------------------------------------------- feat 4: a snowball's chance in hell
const pit = { ...P.pit, y: groundY(P.pit.x, P.pit.z), frozen: false, cool: 0 };
const lavaMat = new THREE.MeshStandardMaterial({ color: 0xff5a1f, emissive: 0xff3b00, emissiveIntensity: 1.6, roughness: 0.6 });
const lava = new THREE.Mesh(new THREE.CircleGeometry(pit.r + 0.3, 28), lavaMat);
lava.rotation.x = -Math.PI / 2;
lava.position.set(pit.x, pit.y + 0.12, pit.z);
scene.add(lava);
// the baked ground cannot be lit by the lava, so its glow is painted on top
const pitGlow = new THREE.Mesh(new THREE.CircleGeometry(12, 40), new THREE.MeshBasicMaterial({
  map: glowTex([[0, 'rgba(255,255,255,0.9)'], [0.3, 'rgba(255,255,255,0.75)'], [0.55, 'rgba(255,255,255,0.28)'], [1, 'rgba(255,255,255,0)']]),
  color: 0xff4a12, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
}));
pitGlow.rotation.x = -Math.PI / 2;
pitGlow.position.set(pit.x, pit.y + 0.05, pit.z);
scene.add(pitGlow);
const pitLight = new THREE.PointLight(0xff5a1f, 60, 26);
pitLight.position.set(pit.x, pit.y + 2.5, pit.z);
scene.add(pitLight);
for (let i = 0; i < 15; i++) {
  const a = (i / 15) * Math.PI * 2;
  const r = mesh(new THREE.DodecahedronGeometry(0.8 + rnd() * 0.6, 0), std(0x3d3236, { flatShading: true }), pit.x + Math.cos(a) * (pit.r + 0.9), pit.y + 0.3, pit.z + Math.sin(a) * (pit.r + 0.9));
  r.rotation.set(rnd() * 3, rnd() * 3, rnd() * 3);
}
makeSign(['HELL', 'pop. 0  ·  no snowballs'], pit.x - 8, pit.z - 4, -1.1);
const pitBeacon = beacon('hell', 0xff7a3a, pit.x, pit.z);
const ball = { x: P.snow.x, z: P.snow.z, vx: 0, vz: 0, r: 1.3, gone: false, sink: 0, melt: 0 };
const ballMesh = mesh(new THREE.IcosahedronGeometry(ball.r, 2), std(0xffffff, { roughness: 0.6, flatShading: true }));
makeSign(['SNOWBALL', 'Chance: slim'], P.snow.x + 4, P.snow.z - 5, -0.6);
const ballBeacon = beacon('hell', 0xcfefff, ball.x, ball.z);

// ---------------------------------------------------------------- feat 5: till the cows come home
const cows = [];
let cowsHome = 0;
function makeCow(x, z) {
  const cr = critters.make('cow');
  scene.add(cr.group);
  cows.push({ g: cr.group, cr, x, z, home: false, heading: rnd() * 6.28, wanderT: 0, phase: rnd() * 6, moving: 0, beacon: beacon('cows', 0xffffff, x, z, 40) });
}
COW_STARTS.forEach((c) => makeCow(c.x, c.z));
const penBeacon = beacon('cows', 0xffb7cf, P.pen.x, P.pen.z, 40);

// ---------------------------------------------------------------- feat: blood from a stone
const stone = { ...P.stone, y: groundY(P.stone.x, P.stone.z), hits: 0, cool: 0 };
makeSign(['THE STONE', 'Contains no blood'], P.stone.x - 5, P.stone.z + 4, -0.7);
const stoneBeacon = beacon('stone', 0xff7a7a, stone.x, stone.z);
const bloodDrop = mesh(new THREE.SphereGeometry(0.2, 12, 10), std(0xc0182a, { emissive: 0x7a0010, emissiveIntensity: 0.7, roughness: 0.2 }));
bloodDrop.scale.y = 1.4;
bloodDrop.visible = false;
const STONE_LINES = ['Nothing. It is a stone.', 'A hairline crack. Again.'];
// Is the pig running into something at (x, z)? 0 no, 1 at a walk, 2 at a trot.
function ramming(x, z, r, head = 0.6) {
  const dx = x - pos.x, dz = z - pos.z, d = Math.hypot(dx, dz);
  if (d > r + 1.25 || !nearGround()) return 0;
  if ((Math.sin(yaw) * dx + Math.cos(yaw) * dz) / d < head) return 0;
  return speed > 11.5 ? 2 : speed > 5 ? 1 : 0;
}
function bounceOff() {
  speed = -6; vy = 5.5; grounded = false; jolt(0.45);
  sfx.thud();
  burst(pos.clone().add(new THREE.Vector3(Math.sin(yaw), 1.4, Math.cos(yaw))), 0xb8b2aa, 10, 4, 9);
}

// ---------------------------------------------------------------- feat: hen's teeth
const hens = HEN_STARTS.map((s, i) => {
  const cr = critters.make('hen');
  scene.add(cr.group);
  return { cr, x: s.x, z: s.z, heading: draw() * 6.28, phase: i * 2.1, moving: 0, wanderT: 0, idle: true, caught: false, hop: 0, slips: 0, dash: 0 };
});
const toothy = 2 + ((draw() * 2) | 0); // the second or the third hen caught is the one
let hensCaught = 0;
makeSign(["HEN'S TEETH", 'Rare. Check every hen.'], P.coop.x + 5.5, P.coop.z - 1, 0.5);
const coopBeacon = beacon('hens', 0xfff3c0, P.coop.x, P.coop.z + 3.5, 40);

// ---------------------------------------------------------------- feat: teach an old dog new tricks
const TRICK = { hop: 'HOP', oink: 'OINK (press E)', spin: 'SPIN (turn all the way round)' };
const dog = {
  cr: critters.make('dog'), x: P.kennel.x + 0.3, z: P.kennel.z + 3.2, tricks: shuffled(['hop', 'oink', 'spin']),
  step: 0, near: false, spin: 0, lastYaw: 0, act: null, actT: 0, heading: 0.4, nag: 0,
};
scene.add(dog.cr.group);
makeSign(['OLD DOG', 'Knows no new tricks'], P.kennel.x + 4.5, P.kennel.z - 3, -0.4);
const dogBeacon = beacon('dog', 0xd9b38c, dog.x, dog.z, 40);

// ---------------------------------------------------------------- feat: herding cats
const cats = CAT_STARTS.map((s, i) => {
  const cr = critters.make('cat');
  scene.add(cr.group);
  return { cr, x: s.x, z: s.z, home: false, heading: draw() * 6.28, phase: i * 2.3, moving: 0, wanderT: 0, idle: true, beacon: beacon('cats', 0xffd9a8, s.x, s.z, 40) };
});
let catsHome = 0;
makeSign(['HERD CATS', 'Onto the cushion. Good luck.'], P.cats.x + 4, P.cats.z - 4, -0.5);
const catBeacon = beacon('cats', 0xff9db5, P.cats.x, P.cats.z, 40);

// ---------------------------------------------------------------- feat: the end of the rainbow
const rainbow = { order: shuffled([0, 1, 2]), stage: 0, fade: 1, moving: false, g: new THREE.Group(), mats: [] };
{
  const R = 60;
  [0xff4d4d, 0xff9a3d, 0xffe14d, 0x5fd66a, 0x4db8ff, 0x6a6aff, 0xb36aff].forEach((color, i) => {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, fog: false, depthWrite: false, side: THREE.DoubleSide });
    const m = new THREE.Mesh(new THREE.TorusGeometry(R - i * 0.62, 0.34, 6, 72, Math.PI), mat);
    m.position.x = -R; // the near foot stands on the group's origin
    rainbow.g.add(m);
    rainbow.mats.push(mat);
  });
  scene.add(rainbow.g);
}
const rainbowEnd = () => FAIRY_RINGS[rainbow.order[rainbow.stage]];
const rainbowBeacon = beacon('rainbow', 0xffe14d, 0, 0);
function placeRainbow() {
  const e = rainbowEnd();
  rainbow.g.position.set(e.x, groundY(e.x, e.z) - 1.5, e.z);
  rainbow.g.rotation.y = Math.atan2(-e.z, e.x) + Math.PI / 2; // side-on to the middle of the island, far foot out at sea
  rainbowBeacon.position.x = e.x; rainbowBeacon.position.z = e.z;
}
placeRainbow();
const gold = world.gold; // baked; parked out of sight until the rainbow holds still
gold.visible = false;

// ---------------------------------------------------------------- feat: a watched pot
const pot = { ...P.camp, y: groundY(P.camp.x, P.camp.z), t: 0, said: 0, boiled: false };
const flames = [];
{
  const fm = new THREE.MeshBasicMaterial({ color: 0xff9a2e, transparent: true, opacity: 0.9 });
  const fm2 = new THREE.MeshBasicMaterial({ color: 0xffe07a, transparent: true, opacity: 0.9 });
  for (let i = 0; i < 5; i++) {
    const f = new THREE.Mesh(new THREE.ConeGeometry(0.22 + (i % 2) * 0.1, 0.75, 6), i % 2 ? fm : fm2);
    f.position.set(pot.x + Math.cos(i * 1.3) * 0.32 * (i > 0), pot.y + 0.42, pot.z + Math.sin(i * 1.3) * 0.32 * (i > 0));
    scene.add(f);
    flames.push(f);
  }
  const glow = new THREE.Mesh(new THREE.CircleGeometry(4.2, 28), new THREE.MeshBasicMaterial({
    map: glowTex([[0, 'rgba(255,255,255,0.8)'], [0.4, 'rgba(255,255,255,0.3)'], [1, 'rgba(255,255,255,0)']]),
    color: 0xff7a2a, blending: THREE.AdditiveBlending, transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  }));
  glow.rotation.x = -Math.PI / 2;
  glow.position.set(pot.x, pot.y + 0.06, pot.z);
  scene.add(glow);
  flames.glow = glow;
}
const fireLight = new THREE.PointLight(0xff8a3a, 22, 16);
fireLight.position.set(pot.x, pot.y + 0.9, pot.z);
scene.add(fireLight);
makeSign(['A WATCHED POT', 'Never boils. Go on, watch.'], P.camp.x + 6, P.camp.z + 3, -1.0);
const potBeacon = beacon('pot', 0xffa060, pot.x, pot.z);

// ---------------------------------------------------------------- feat: a square peg in a round hole
const hole = { ...P.hole, y: groundY(P.hole.x, P.hole.z) };
const crate = { x: P.crate.x, z: P.crate.z, vx: 0, vz: 0, r: 1.25, gone: false, sink: 0, rot: 0 };
const crateMesh = world.crate;
makeSign(['ROUND HOLE', 'Square pegs need not apply'], P.hole.x - 4.5, P.hole.z - 3, 0.6);
const holeBeacon = beacon('peg', 0xc9b8ff, hole.x, hole.z);
const crateBeacon = beacon('peg', 0xe8c890, crate.x, crate.z);

// ---------------------------------------------------------------- the barn door, and other secrets
const SECRET_COUNT = 15;
const HINTS = {
  elephant: 'whatever is in the barn', herring: 'something fishy on the west beach', worms: 'a can best left shut', ducks: 'a tidy row offshore',
  mill: 'a fight with a building', cheese: 'what the moon tastes of', cloud9: 'a pink cloud with a number on it', poke: 'a sack that oinks back',
  bucket: 'something to kick by the well', pearls: 'jewellery on the north beach', road: 'a hen with somewhere to be', field: 'standing about among the cabbages',
  wash: 'a bath', fish: 'who rules the pond', tree: 'an argument with a tree, at speed',
};
const found = {};
let foundN = 0;
function secret(key, line) {
  if (found[key]) return;
  found[key] = true;
  foundN++;
  sfx.chime();
  burst(pos.clone().add(new THREE.Vector3(0, 2, 0)), 0xb9a8ff, 18, 6, 5);
  $('secretN').textContent = `${foundN}/${SECRET_COUNT}`;
  say(`${line}  (Secret ${foundN} of ${SECRET_COUNT}.)`, 5.5);
}
// The horse statue gives the order to stomp the three plates in; it changes every game.
const puzzle = { code: shuffled(PLATES.map((p) => p.sym)), step: 0, on: null, open: false, swing: 0, heard: false };
const plateGlow = PLATES.map((p) => {
  const m = new THREE.Mesh(new THREE.RingGeometry(0.82, 1.04, 28), new THREE.MeshBasicMaterial({ color: { sun: 0xffd23f, moon: 0xbfe0ff, star: 0xff8fb3 }[p.sym], transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
  m.rotation.x = -Math.PI / 2;
  m.position.set(p.x, groundY(p.x, p.z) + 0.2, p.z);
  scene.add(m);
  return m;
});
makeSign(['BARN', 'Locked. Ask the horse.'], P.barn.x + 6.6, P.barn.z - 5.2, Math.PI / 2);
makeSign(['THE HORSE', 'Go on. Ask.'], P.horse.x - 4.5, P.horse.z + 3, -0.9);
function openBarn() {
  if (puzzle.open) return;
  puzzle.open = true;
  const i = colliders.findIndex((c) => c.kind === 'door');
  if (i >= 0) colliders.splice(i, 1);
  sfx.creak();
  resign('barn');
  say('The barn doors creak open.', 4);
}
const barnBase = groundY(P.barn.x, P.barn.z);
const inBarn = () => Math.abs(pos.x - P.barn.x) < 4.9 && Math.abs(pos.z - P.barn.z) < 3.9 && pos.y < barnBase + 5.2;
const barnLight = new THREE.PointLight(0xffc98a, 0, 14);
barnLight.position.set(P.barn.x + 0.6, barnBase + 4.2, P.barn.z);
scene.add(barnLight);

// rubber ducks, in a row, just offshore
const ducks = [world.duck_0, world.duck_1, world.duck_2];

// ---------------------------------------------------------------- more secrets, built from odds and ends
// on cloud nine: one pink cloud that stays put, with its number on it
const cloud9 = world.cloud9;
{
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.font = '900 110px Georgia, serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 10; g.strokeStyle = '#3b1d3a'; g.strokeText('9', 64, 70);
  g.fillStyle = '#fff6e9'; g.fillText('9', 64, 70);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const nine = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, fog: false }));
  nine.scale.setScalar(7);
  nine.position.y = 6.5;
  cloud9.add(nine);
}
// a pig in a poke
const poke = { ...SPOTS.poke, t: 0, hop: 0, g: world.poke };
// a bucket to kick, by the well
const bucket = { ...SPOTS.bucket, vx: 0, vz: 0, spin: 0, g: world.bucket, cool: 0 };
// pearls before swine, on the north beach
const pearls = SPOTS.pearls;
// a big fish in a small pond, and the lighthouse lamp
const fish = { g: world.fish, t: 0, side: 1 };
const lamp = new THREE.Group();
{
  const y = groundY(P.islet.x, P.islet.z) + 13.75;
  const bm = new THREE.MeshBasicMaterial({ color: 0xfff0c0, transparent: true, opacity: 0.05, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide });
  for (const s of [-1, 1]) {
    const c = new THREE.Mesh(new THREE.ConeGeometry(7, 90, 20, 1, true), bm);
    c.rotation.z = s * Math.PI / 2; // apex at the lamp, widening outward
    c.position.x = -s * 45;
    lamp.add(c);
  }
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex([[0, 'rgba(255,255,255,1)'], [0.3, 'rgba(255,255,255,0.5)'], [1, 'rgba(255,255,255,0)']]), color: 0xffe9a8, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, transparent: true }));
  glow.scale.setScalar(6);
  lamp.add(glow);
  lamp.beam = bm; lamp.glow = glow;
  lamp.position.set(P.islet.x, y, P.islet.z);
  scene.add(lamp);
}
// why did the chicken cross the road
const roadHen = { cr: critters.make('hen'), side: -1, x: -8.5, z: 9, phase: 0, moving: 0, crossed: 0 };
scene.add(roadHen.cr.group);
// the hen with teeth gets a grin; the others get a ride
const grinTex = (() => {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#3b1d3a'; g.beginPath(); g.roundRect(4, 4, 120, 56, 26); g.fill();
  g.fillStyle = '#ffffff';
  for (let i = 0; i < 6; i++) { g.fillRect(14 + i * 17.5, 12, 14, 18); g.fillRect(14 + i * 17.5, 34, 14, 18); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();
// and the cow jumped over the moon (once somebody has shown her it can be done)
const moonCow = { cr: null, a: -0.6 };

// ---------------------------------------------------------------- oinking at things
const stats = { oinks: 0, trees: 0, rides: 0, slips: 0, melts: 0 };
const quip = (text, dur = 3.2) => { if (toastT <= 0.3) say(text, dur); };
const hopOf = (o, dt, h = 1) => { o.hop = Math.max(0, (o.hop || 0) - dt * 1.9); return Math.sin(o.hop * Math.PI) * h; };
function oinkReact() {
  stats.oinks++;
  const near = (x, z, d) => hd(x, z) < d;
  let line = null;
  for (const c of cows) if (near(c.x, c.z, 13)) { c.hop = 1; later(0.35, () => sfx.moo()); line = 'The cow has no comment. Actually, one comment.'; }
  for (const h of [...hens, roadHen]) if (near(h.x, h.z, 9)) { h.hop = 1; sfx.cluck(); line = 'The hens consider this an emergency.'; }
  for (const c of cats) if (!c.home && near(c.x, c.z, 10)) { c.hop = 1; c.heading = Math.atan2(c.x - pos.x, c.z - pos.z); sfx.meow(); line = 'The cat pretends that was beneath its notice. It was not.'; }
  if (feats.dog && near(dog.x, dog.z, 10)) { dog.hop = 1; later(0.25, () => sfx.bark()); line = 'He oinks back, in dog.'; }
  if (near(poke.x, poke.z, 12)) { poke.hop = 1; later(0.4, () => sfx.muffled()); line = line || 'Something in that sack agrees with you.'; }
  if (inBarn()) { later(0.3, () => { sfx.trumpet(); jolt(0.5); }); line = 'The elephant never forgets a rude noise.'; }
  else if (near(P.horse.x, P.horse.z, 8)) line = 'The horse does not dignify that with a reply.';
  else if (near(P.stone.x, P.stone.z, 7)) line = 'The stone has heard worse.';
  else if (near(P.field.x, P.field.z, 9)) line = 'The scarecrow is outstanding in his field. He says nothing.';
  else if (near(62, 17.5, 6)) line = 'The snowman gives you a frosty reception.';
  else if (near(P.camp.x, P.camp.z, 7) && !feats.pot) line = 'A watched pot does not respond to heckling.';
  else if (near(P.hill.x, P.hill.z, 9)) { later(0.7, () => sfx.muffled()); line = line || '…oink. Nice echo up here.'; }
  if (line) quip(line);
}
const IDLE_LINES = ['The pig is waiting for the cows to come home.', 'Somewhere, a pot is not being watched.', 'The odds are not improving on their own.', 'A lovely spot to do nothing. Carry on.', 'The pig considers its options. There are five.'];
const TREE_LINES = ['The tree wins again.', 'Trees do not move. This is well documented.', 'That one was not the right tree either.'];
let idleT = 0, idleN = 0, fieldT = 0, dustT = 0, hoofT = 0, hoofB = false, wasWading = false;

// ---------------------------------------------------------------- dusk, and small living things
// The afternoon wears on with every job done; the last one brings the blue moon up over twilight.
const K = (h) => new THREE.Color(h);
const DUSK = {
  top: [K(0x4f9ff0), K(0x5670cc), K(0x10163f)], mid: [K(0xa9d8ff), K(0xf0a98f), K(0x41387d)], bot: [K(0xffdccb), K(0xffb07a), K(0xe88462)],
  tint: [K(0xffffff), K(0xffd6bd), K(0x7684c4)], fog: [K(0xffdccb), K(0xffb990), K(0x5d5290)],
  sun: [K(0xffe2bd), K(0xffc8a0), K(0x8f9be6)], hemi: [K(0xd6e8ff), K(0xffcdb5), K(0x8792dd)], cloud: [K(0xffffff), K(0xffb9a0), K(0x6a6aa8)],
};
const dusk = (k, m, out) => (m < 0.6 ? out.copy(DUSK[k][0]).lerp(DUSK[k][1], m / 0.6) : out.copy(DUSK[k][1]).lerp(DUSK[k][2], (m - 0.6) / 0.4));
let mood = 0, sunBase = 2.5, hemiBase = 1.3;
const tintNow = new THREE.Color(1, 1, 1);
const stars = (() => {
  const p = [];
  for (let i = 0; i < 900; i++) {
    const v = new THREE.Vector3(rnd() - 0.5, rnd() * 0.5 + 0.03, rnd() - 0.5).normalize().multiplyScalar(940);
    p.push(v.x, v.y, v.z);
  }
  const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  const m = new THREE.Points(g, new THREE.PointsMaterial({ color: new THREE.Color(2.2, 2.2, 2.6), size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false }));
  scene.add(m);
  return m;
})();
const dot = glowTex([[0, 'rgba(255,255,255,1)'], [0.35, 'rgba(255,255,255,0.55)'], [1, 'rgba(255,255,255,0)']]);
const moonGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: dot, color: 0xfff0d0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, transparent: true, opacity: 0.2 }));
moonGlow.scale.setScalar(64);
moonGlow.position.copy(MOON_POS);
scene.add(moonGlow);
const meadowSpot = () => { for (;;) { const a = rnd() * 6.28, r = 8 + rnd() * 66, x = Math.cos(a) * r, z = Math.sin(a) * r; if (groundY(x, z) > 0.6) return { x, z }; } };
const fireflies = (() => {
  const list = Array.from({ length: 150 }, () => ({ ...meadowSpot(), ph: rnd() * 60, h: 0.6 + rnd() * 2.2 }));
  const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(450), 3));
  const m = new THREE.Points(g, new THREE.PointsMaterial({ map: dot, color: new THREE.Color(2.6, 2.8, 0.9), size: 0.55, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
  m.frustumCulled = false;
  scene.add(m);
  return { list, m };
})();
const petals = (() => {
  const trees = TREES.filter((t) => t.kind === 'blossom');
  const list = Array.from({ length: trees.length ? 110 : 0 }, (_, i) => ({ t: trees[i % trees.length], k: rnd(), a: rnd() * 6.28, r: 0.5 + rnd() * 2.4, sp: 0.07 + rnd() * 0.07 }));
  const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(list.length * 3), 3));
  const m = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffc9da, size: 0.17, transparent: true, opacity: 0.95, depthWrite: false }));
  m.frustumCulled = false;
  scene.add(m);
  return { list, m };
})();
const wingGeo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.08, 0.2, 0, -0.16, 0.18, 0, 0.11, 0, 0, -0.08, 0.18, 0, 0.11, 0, 0, 0.07], 3));
const flutter = [0xffd23f, 0xff8fb3, 0x7fd0ff, 0xffffff, 0xf08a24, 0xb58cff].flatMap((color) => [0, 1, 2].map(() => {
  const g = new THREE.Group(), mat = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide });
  const l = new THREE.Mesh(wingGeo, mat), r = new THREE.Mesh(wingGeo, mat);
  r.scale.x = -1;
  g.add(l, r);
  scene.add(g);
  return { g, l, r, mat, base: new THREE.Color(color), ...meadowSpot(), ph: rnd() * 40 };
}));
const birds = Array.from({ length: 7 }, (_, i) => {
  const g = new THREE.Group(), mat = new THREE.MeshBasicMaterial({ color: 0x3b2f4a, side: THREE.DoubleSide, fog: false });
  const l = new THREE.Mesh(wingGeo, mat), r = new THREE.Mesh(wingGeo, mat);
  r.scale.x = -1;
  g.add(l, r);
  g.scale.setScalar(7.5);
  scene.add(g);
  const row = Math.ceil(i / 2), side = i % 2 ? 1 : -1;
  return { g, l, r, back: row * 0.055, out: row * side * 2.6, ph: i };
});

function updateWorldLife(dt) {
  // time of day
  const target = finale ? 1 : count * 0.15;
  mood += clamp(target - mood, -dt * 0.1, dt * 0.1);
  const u = sky.material.uniforms;
  dusk('top', mood, u.top.value); dusk('mid', mood, u.mid.value); dusk('bot', mood, u.bot.value);
  dusk('fog', mood, scene.fog.color);
  dusk('tint', mood, tintNow);
  for (const m of worldMats) m.color.copy(tintNow);
  waterMat.uniforms.tint.value.copy(tintNow);
  dusk('sun', mood, sun.color); dusk('hemi', mood, hemi.color);
  sunBase = 2.5 - mood * 1.35; hemiBase = 1.3 - mood * 0.4;
  if (cloudMat) { dusk('cloud', mood, cloudMat.color); cloudMat.emissive.copy(cloudMat.color); }
  const night = clamp((mood - 0.55) / 0.45, 0, 1);
  stars.material.opacity = night * 0.95;
  stars.position.copy(camera.position);
  sunGlow.material.opacity = 1 - night * 0.85;
  moonGlow.material.opacity = 0.18 + night * 0.55;
  moonGlow.material.color.copy(moonMat.color);
  bloom.strength = 0.3 + night * 0.4;
  // fireflies come out as the light goes
  fireflies.m.material.opacity = clamp((mood - 0.4) / 0.4, 0, 1) * 0.95;
  if (fireflies.m.material.opacity > 0) {
    const p = fireflies.m.geometry.attributes.position;
    fireflies.list.forEach((f, i) => {
      const t = time * 0.5 + f.ph, x = f.x + Math.sin(t * 0.9) * 2.2 + Math.sin(t * 2.3) * 0.6, z = f.z + Math.cos(t * 0.7) * 2.2;
      p.setXYZ(i, x, groundY(f.x, f.z) + f.h + Math.sin(t * 1.7) * 0.5 - (Math.sin(t * 3.1 + f.ph) > 0.86 ? 50 : 0), z); // a blink is a trip underground
    });
    p.needsUpdate = true;
  }
  // blossom drifting down
  {
    const p = petals.m.geometry.attributes.position;
    petals.list.forEach((q, i) => {
      q.k = (q.k + dt * q.sp) % 1;
      const top = groundY(q.t.x, q.t.z) + 5.4 * q.t.s, a = q.a + q.k * 5;
      p.setXYZ(i, q.t.x + Math.cos(a) * q.r * (0.5 + q.k) + q.k * 2.5, top - q.k * (5.2 * q.t.s), q.t.z + Math.sin(a) * q.r * (0.5 + q.k));
    });
    p.needsUpdate = true;
    petals.m.material.color.copy(tintNow).multiply(K(0xffc9da));
  }
  // butterflies by day
  for (const b of flutter) {
    b.g.visible = mood < 0.7;
    if (!b.g.visible) continue;
    b.ph += dt;
    const x = b.x + Math.sin(b.ph * 0.5) * 4 + Math.sin(b.ph * 1.3) * 1.4, z = b.z + Math.cos(b.ph * 0.4) * 4 + Math.cos(b.ph * 1.1) * 1.4;
    b.g.position.set(x, groundY(x, z) + 1.1 + Math.sin(b.ph * 2.1) * 0.45, z);
    b.g.rotation.y = Math.atan2(Math.cos(b.ph * 0.5) * 2 + Math.cos(b.ph * 1.3) * 1.8, -Math.sin(b.ph * 0.4) * 1.6 - Math.sin(b.ph * 1.1) * 1.5);
    b.l.rotation.z = Math.sin(b.ph * 19) * 1.1; b.r.rotation.z = -b.l.rotation.z;
    b.mat.color.copy(b.base).multiply(tintNow);
  }
  // a skein of birds going round
  for (const b of birds) {
    const a = time * 0.07 - b.back, R = 62 + b.out;
    b.g.position.set(Math.cos(a) * R, 50 + Math.sin(time * 0.3 + b.ph) * 1.5, Math.sin(a) * R);
    b.g.rotation.y = -a;
    b.l.rotation.z = Math.sin(time * 5 + b.ph) * 0.6; b.r.rotation.z = -b.l.rotation.z;
  }
  cloud9.position.y = 44 + Math.sin(time * 0.4) * 0.8;
}

// ---------------------------------------------------------------- finale: blue moon and rings
const rings = [];
let ringIdx = 0;
{
  const pts = [[16, 9, -6], [40, 18, 16], [46, 30, 50], [22, 42, 80], [-12, 52, 97], [-34, 64, 112], [MOON_POS.x, MOON_POS.y + 15.5, MOON_POS.z]];
  pts.forEach((p, i) => {
    const mat = new THREE.MeshStandardMaterial({ color: 0xffc93c, emissive: 0xffa800, emissiveIntensity: 0.4, roughness: 0.4, transparent: true, opacity: 0.45, fog: false });
    const m = new THREE.Mesh(new THREE.TorusGeometry(4.6, 0.38, 10, 36), mat);
    m.position.set(...p);
    const prev = i === 0 ? new THREE.Vector3(0, 2, -20) : new THREE.Vector3(...pts[i - 1]);
    m.lookAt(prev);
    m.visible = false;
    scene.add(m);
    rings.push(m);
  });
}
const MOON_WHITE = new THREE.Color(0xfff7e0), MOON_BLUE = new THREE.Color(0x3d8bff);
let moonBlue = 0;

function startFinale() {
  finale = true;
  rings.forEach((r) => (r.visible = true));
  say('Once in a blue moon… is right now. HOLD SPACE to fly. Follow the rings and get over the moon.', 9);
  sfx.chime();
  refreshHud();
}

// raining cats and dogs
const rain = [];
function startRain() {
  for (let i = 0; i < 44; i++) {
    const g = critters.make(i % 2 ? 'dog' : 'cat').group;
    scene.add(g);
    const o = { g, v: 9 + Math.random() * 7, spin: new THREE.Vector3(Math.random() * 2, Math.random() * 2, Math.random() * 2) };
    resetRain(o, true);
    rain.push(o);
  }
}
function resetRain(o, first) {
  const a = Math.random() * Math.PI * 2, r = 6 + Math.random() * 45;
  o.g.position.set(pos.x + Math.cos(a) * r, pos.y + (first ? 10 + Math.random() * 70 : 45 + Math.random() * 25), pos.z + Math.sin(a) * r);
}

function win() {
  won = true;
  sfx.win();
  const best = parseFloat(localStorage.getItem('wpf-best') || '0');
  const isBest = !best || time < best;
  if (isBest) localStorage.setItem('wpf-best', String(time));
  localStorage.setItem('wpf-wins', String(parseInt(localStorage.getItem('wpf-wins') || '0', 10) + 1));
  $('winTime').textContent = fmtTime(time);
  $('winBest').textContent = isBest ? 'A new personal best.' : `Your best is ${fmtTime(best)}.`;
  startRain();
  moonCow.cr = critters.make('cow');
  scene.add(moonCow.cr.group);
  later(9, () => say('And the cow jumped over the moon. Show-off.', 5));
  const rank = foundN >= SECRET_COUNT ? 'The whole hog' : foundN >= 10 ? 'High on the hog' : foundN >= 6 ? 'Hog wild' : foundN >= 3 ? 'Swine of the times' : 'Ham-ateur';
  const missing = Object.keys(HINTS).filter((k) => !found[k]);
  $('winStats').innerHTML = `Rank: <b>${rank}</b> · Oinks ${stats.oinks} · Trees headbutted ${stats.trees} · Hens given a lift ${stats.rides} · Secrets ${foundN}/${SECRET_COUNT}`
    + (missing.length ? `<br><small>Still out there: ${shuffled(missing).slice(0, 2).map((k) => HINTS[k]).join(', and ')}.</small>` : '<br><small>You found everything. The island has no secrets from you.</small>');
  jolt(0.6);
  refreshHud();
  say('Pigs fly.', 3);
  later(2.2, () => $('win').classList.remove('hidden'));
}

// ---------------------------------------------------------------- input
const keys = {};
let flapQueued = false, holdFlap = false;
const touch = { id: null, ox: 0, oy: 0, turn: 0, fwd: 0 };

// Flight recorder: the last ten seconds of the pig, kept in this browser, for working out how
// someone got stuck. The "stuck?" button frees the pig and offers the report to share.
const BUILD = '2026-11-14d';
const stuckBtn = $('stuckBtn'); // absent if a phone is still holding an older copy of the page
const tele = createRecorder({
  build: BUILD,
  context: () => ({
    seed, active: active.join(), done: Object.keys(feats).filter((k) => feats[k]).join(), count, finale, won, time: Math.round(time),
    pig: { x: +pos.x.toFixed(2), y: +pos.y.toFixed(2), z: +pos.z.toFixed(2), yaw: +yaw.toFixed(2), speed: +speed.toFixed(2), vy: +vy.toFixed(2), grounded, ground: +standY(pos.x, pos.z).toFixed(2), inBarn: inBarn(), offshore: +offshore(pos.x, pos.z).toFixed(1) },
    input: { touch: { ...touch }, keys: Object.keys(keys).filter((k) => keys[k]).join(), holdFlap, firstPerson },
    screen: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio, slowStep, pictureLost, pictureGone: renderer.getContext().isContextLost(), ua: navigator.userAgent },
  }),
  onStuck() { stuckBtn?.classList.add('on'); },
});
addEventListener('error', (e) => { if (tele.error('page', e.error || e.message)) stuckBtn?.classList.add('on'); });
addEventListener('unhandledrejection', (e) => tele.error('promise', e.reason));
document.addEventListener('visibilitychange', () => tele.note(document.hidden ? 'hidden' : 'shown'));
// A phone short of graphics memory takes the picture away; the game carries on unseen, which
// looks like being stuck. Say so, since nothing in the game can bring it back but the browser.
let pictureLost = 0;
canvas.addEventListener('webglcontextlost', () => {
  pictureLost++; tele.note('picture lost');
  stuckBtn?.classList.add('on');
  toastEl.textContent = 'The picture has stopped: this device ran short of graphics memory. Tap "stuck?" to save a report, then reload the page.';
  toastEl.classList.add('show'); toastT = 600;
});
canvas.addEventListener('webglcontextrestored', () => { tele.note('picture restored'); say('The picture is back.', 3); });
stuckBtn?.addEventListener('click', (e) => {
  e.preventDefault();
  const rep = tele.manual();
  const to = tele.escape(pos.x, pos.z) || { x: 0, z: 0 };
  pos.set(to.x, standY(to.x, to.z), to.z); vy = 0; speed = 0; grounded = true;
  for (const k in keys) keys[k] = false;
  touch.id = null; touch.turn = 0; touch.fwd = 0; holdFlap = false;
  tele.clear(); tele.note('freed');
  stuckBtn.classList.remove('on');
  const text = JSON.stringify(rep);
  say('Freed. A report of what happened is saved. Send it to the maker if you like.', 5);
  // Sharing is the player's choice: the share sheet on a phone, the clipboard elsewhere.
  if (navigator.share) navigator.share({ title: 'When Pigs Fly: stuck report', text }).catch(() => {});
  else if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
});

function begin() {
  if (started) return;
  started = true;
  $('start').classList.add('hidden');
  sfx.init();
  sfx.startMusic();
  sfx.oink();
  say("Today's five impossible things are on the list. Follow the beams of light. Start anywhere.", 6);
}
$('go').addEventListener('click', begin);
$('go').disabled = false;
$('go').textContent = 'Start oinking';
$('keep').addEventListener('click', () => $('win').classList.add('hidden'));

function oink() { sfx.oink(); ev.oink = true; if (started) oinkReact(); }
$('oinkBtn').addEventListener('pointerdown', (e) => { e.preventDefault(); oink(); });
window.addEventListener('keydown', (e) => {
  if (!started) { if ((e.code === 'Enter' || e.code === 'Space') && !e.repeat) { e.preventDefault(); begin(); } return; }
  if (!e.repeat) tele.note('key+', e.code);
  keys[e.code] = true;
  if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) flapQueued = true; holdFlap = true; }
  if (e.code === 'KeyE' && !e.repeat) oink();
  if (e.code === 'KeyV' && !e.repeat) firstPerson = !firstPerson;
  if (e.code === 'KeyM' && !e.repeat) say(sfx.toggleMute() ? 'Sound off.' : 'Sound on.', 1.5);
  if (e.code.startsWith('Arrow')) e.preventDefault();
});
window.addEventListener('keyup', (e) => { tele.note('key-', e.code); keys[e.code] = false; if (e.code === 'Space') holdFlap = false; });
window.addEventListener('blur', () => { tele.note('blur'); for (const k in keys) keys[k] = false; holdFlap = false; });

canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse') return;
  tele.note('touch+', `${e.pointerId}${touch.id === null ? '' : ' ignored, steering with ' + touch.id}`);
  if (touch.id === null) { touch.id = e.pointerId; touch.ox = e.clientX; touch.oy = e.clientY; }
});
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerId !== touch.id) return;
  touch.turn = clamp((e.clientX - touch.ox) / 55, -1, 1);
  touch.fwd = clamp(-(e.clientY - touch.oy) / 55, -1, 1);
});
const endTouch = (e) => { tele.note(e.type === 'pointercancel' ? 'touch cancelled' : 'touch-', e.pointerId); if (e.pointerId === touch.id) { touch.id = null; touch.turn = 0; touch.fwd = 0; } };
canvas.addEventListener('pointerup', endTouch);
canvas.addEventListener('pointercancel', endTouch);
// The flap button is held for as long as a finger that went down on it is still down. The lift is
// listened for on the whole window and checked against the phone's own list of touches, because a
// phone that takes a touch away (a long press, one finger too many) does not always tell the button.
const fb = $('flapBtn');
const flapTouches = new Set();
const dropFlap = (why) => { if (flapTouches.size) tele.note('flap let go', why); flapTouches.clear(); holdFlap = false; };
fb.addEventListener('pointerdown', (e) => { e.preventDefault(); flapTouches.add(e.pointerId); flapQueued = true; holdFlap = true; });
for (const type of ['pointerup', 'pointercancel']) {
  window.addEventListener(type, (e) => { if (flapTouches.delete(e.pointerId) && !flapTouches.size) holdFlap = false; });
}
for (const type of ['touchend', 'touchcancel']) {
  window.addEventListener(type, (e) => { if (flapTouches.size && ![...e.touches].some((t) => t.target === fb)) dropFlap(type); }, { passive: true });
}
document.addEventListener('visibilitychange', () => dropFlap('page hidden'));
// A long press must not open the phone's menu over the controls: the menu swallows the lift.
for (const el of [fb, $('oinkBtn'), canvas]) el.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('selectstart', (e) => e.preventDefault());

// ---------------------------------------------------------------- update
function doFlap() {
  if (grounded) {
    vy = 7.5; grounded = false; sfx.hop(); ev.hop = true; squash = -0.22;
    return;
  }
  if (count >= 5 || flaps > 0) {
    if (count < 5) flaps--;
    vy = Math.max(vy, 0) * 0.35 + 7.2;
    pig.kick();
    sfx.flap();
    burst(pos.clone().add(new THREE.Vector3(0, 1.6, 0)), 0xffffff, 3, 2, 3, 0.7);
  }
}

function updatePig(dt) {
  const turn = (keys.KeyA || keys.ArrowLeft ? 1 : 0) - (keys.KeyD || keys.ArrowRight ? 1 : 0) - touch.turn;
  const fwd = clamp((keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0) + touch.fwd, -1, 1);
  const sprint = keys.ShiftLeft || keys.ShiftRight || touch.fwd > 0.95;

  // The body's own motion lives in move.js, which the tests run too.
  pack();
  steer(body, { turn, fwd, sprint, airSpeed: 10 + count * 1.7 }, dt);
  unpack();

  if (flapQueued) { doFlap(); autoFlapT = 0.34; }
  flapQueued = false;
  if (holdFlap && !grounded && count >= 5) {
    autoFlapT -= dt;
    if (autoFlapT <= 0) { doFlap(); autoFlapT = 0.34; }
  }

  pack();
  fall(body, holdFlap && count >= 2 ? -(8 - count * 1.2) : null, dt); // held wings glide
  unpack();
  if (!grounded) {
    if (pos.y > 135) { pos.y = 135; vy = Math.min(vy, 0); }
    if (inBarn() && pos.y > barnBase + 3.4) { pos.y = barnBase + 3.4; vy = Math.min(vy, 0); } // rafters
  }

  pack();
  contain(body, shore, offshore);
  collide(body, dt, colliders, (c) => tele.hit(c.kind));
  const landedAt = land(body, standY);
  unpack();
  if (landedAt !== null) {
    if (landedAt < -11) { sfx.thud(); burst(pos.clone(), 0xd8c9a0, 8, 3, 6); jolt(0.25); }
    squash = Math.min(0.42, -landedAt * 0.03);
  }
  if (grounded) flaps = count;

  // wings grow toward their earned size
  const targetWing = 0.22 + count * 0.156;
  if (Math.abs(targetWing - wingScale) > 0.001) {
    wingScale += (targetWing - wingScale) * Math.min(1, dt * 2.5);
    pig.setWingScale(wingScale);
  }

  soot = Math.max(0, soot - dt * 0.25);
  pig.setSoot(soot);

  squash += (0 - squash) * Math.min(1, dt * 9);
  pig.group.scale.set(1 + squash * 0.55, 1 - squash, 1 + squash * 0.55);
  pig.group.position.copy(pos);
  pig.group.rotation.y = yaw;
  const pitch = grounded ? 0 : clamp(-vy * 0.035, -0.5, 0.45);
  pig.group.rotation.x += (pitch - pig.group.rotation.x) * Math.min(1, dt * 6);
  const bank = grounded ? 0 : -turn * 0.35;
  pig.group.rotation.z += (bank - pig.group.rotation.z) * Math.min(1, dt * 5);
  pig.update(dt, { speed: Math.abs(speed), airborne: !grounded, t: time });
  tele.tick(dt, { x: pos.x, y: pos.y, z: pos.z, yaw, speed, vy, grounded, ground: Math.max(standY(pos.x, pos.z), -1), fwd, turn });
  if (!tele.stuck && !pictureLost && !tele.faults) stuckBtn?.classList.remove('on');
}

const nearGround = () => pos.y - standY(pos.x, pos.z) < 2.5;
const hd = (x, z) => Math.hypot(pos.x - x, pos.z - z);

function updateFeats(dt) {
  // needle in a haystack
  for (const s of stacks) {
    if (!s.checked && nearGround() && hd(s.x, s.z) < 2.6) {
      s.checked = true;
      sfx.rustle();
      burst(new THREE.Vector3(s.x, pos.y + 1.5, s.z), 0xe9c558, 22, 6, 9, 1.2);
      const left = stacks.filter((k) => !k.checked).length;
      if (left === 0) {
        needle = mesh(new THREE.CylinderGeometry(0.05, 0.01, 1.6, 6), std(0xe8f0ff, { metalness: 1, roughness: 0.15, emissive: 0x88aaff, emissiveIntensity: 0.8 }), s.x, pos.y + 3, s.z);
        needle.userData.t = 0;
        sfx.chime();
        hayBeacon.visible = false;
        complete('needle', 'A needle in a haystack. Found. It was in the last place you looked.');
      } else {
        say(HAY_LINES[(stacks.length - left - 1) % HAY_LINES.length], 2);
      }
    }
    const tgt = s.checked ? 0.3 : 1;
    s.squash += (tgt - s.squash) * Math.min(1, dt * 8);
    s.g.scale.set(1 + (1 - s.squash) * 0.4, s.squash, 1 + (1 - s.squash) * 0.4);
  }
  if (needle) { needle.userData.t += dt; needle.rotation.z = 0.5; needle.rotation.y += dt * 3; needle.position.y += Math.sin(needle.userData.t * 3) * 0.004; }

  // clovers
  for (const c of clovers) {
    if (c.got) continue;
    c.g.rotation.y += dt * 1.6;
    if (hd(c.x, c.z) < 2.2 && Math.abs(pos.y - c.g.position.y) < 4) {
      c.got = true; c.g.visible = false; c.beacon.visible = false;
      cloverCount++;
      $('cloverN').textContent = `${cloverCount}/4`;
      sfx.chime();
      burst(c.g.position, 0x6dff8e, 14, 5, 6);
      if (cloverCount === 4) complete('clover', 'Four four-leaf clovers. Luck is now on the payroll.');
      else say(`A four-leaf clover. ${4 - cloverCount} to go.`, 2.2);
    }
  }

  // lightning
  if (!feats.lightning) {
    if (hd(rod.x, rod.z) < 4.5 && pos.y < rod.y + 12) {
      rod.timer += dt;
      if (rod.strikes === 0 && rod.timer > 0.7) {
        rod.strikes = 1; rod.timer = 0; strike();
        say('Struck by lightning. It never strikes twice, so you are safe here. Stay put.', 3.2);
      } else if (rod.strikes === 1 && rod.timer > 3.4) {
        rod.strikes = 2; strike();
        rodBeacon.visible = false;
        complete('lightning', 'Lightning struck twice. Same pig. Same spot.');
      }
    } else if (rod.strikes === 1 && rod.timer > 0) {
      rod.timer = Math.max(0, rod.timer - dt * 2);
    } else if (rod.strikes === 0) rod.timer = 0;
  }
  if (bolt) { boltT -= dt; bolt.visible = boltT > 0 && Math.floor(boltT * 40) % 2 === 0; }

  // snowball and hell
  if (!ball.gone) {
    // Near the pit it melts, quickly while the odds are long. Out in the cold it grows back.
    const heat = Math.hypot(ball.x - pit.x, ball.z - pit.z) < HEAT_R;
    ball.melt = clamp(ball.melt + (heat ? dt / meltSeconds(count) : -dt * 0.25), 0, 1);
    if (heat && Math.random() < dt * (4 + ball.melt * 14)) burst(new THREE.Vector3(ball.x, ballMesh.position.y + 0.6, ball.z), 0xffffff, 1, 1.2, -2.5, 0.8);
    if (ball.melt >= 1) {
      sfx.hiss();
      burst(ballMesh.position, 0xffffff, 26, 4, -3, 1.6);
      Object.assign(ball, { x: P.snow.x, z: P.snow.z, vx: 0, vz: 0, melt: 0 });
      mishap('melts', count ? 'The snowball melted. There is another back in the snow, and it will last longer now.' : "The snowball melted. A snowball's chance, exactly as advertised. There is another back in the snow.");
    }
    const r = ball.r * (1 - ball.melt * 0.6);
    ballMesh.scale.setScalar(r / ball.r);
    const dx = ball.x - pos.x, dz = ball.z - pos.z, d = Math.hypot(dx, dz), min = r + 1.0;
    if (d < min && nearGround() && d > 0.001) {
      const push = Math.max(Math.abs(speed), 3) * 1.25;
      ball.vx = (dx / d) * push; ball.vz = (dz / d) * push;
      ball.x = pos.x + (dx / d) * min; ball.z = pos.z + (dz / d) * min;
    }
    const sp = Math.hypot(ball.vx, ball.vz);
    if (sp > 0.01) {
      ball.x += ball.vx * dt; ball.z += ball.vz * dt;
      const axis = new THREE.Vector3(ball.vz, 0, -ball.vx).normalize();
      ballMesh.rotateOnWorldAxis(axis, (sp * dt) / r);
      const k = Math.exp(-1.1 * dt);
      ball.vx *= k; ball.vz *= k;
    }
    const br = Math.hypot(ball.x, ball.z);
    if (br > 78) { ball.x *= 78 / br; ball.z *= 78 / br; ball.vx *= -0.6; ball.vz *= -0.6; }
    ballMesh.position.set(ball.x, groundY(ball.x, ball.z) + r, ball.z);
    ballBeacon.position.x = ball.x; ballBeacon.position.z = ball.z;
    if (Math.hypot(ball.x - pit.x, ball.z - pit.z) < pit.r - 0.3) {
      ball.gone = true; pit.frozen = true;
      ballBeacon.visible = pitBeacon.visible = false;
      sfx.hiss();
      burst(new THREE.Vector3(pit.x, pit.y + 1, pit.z), 0xffffff, 40, 6, -2, 2.2);
      complete('hell', 'Hell has frozen over. The snowball had a chance after all.');
    }
  } else if (ball.sink < 1) {
    ball.sink = Math.min(1, ball.sink + dt * 0.8);
    ballMesh.position.y -= dt * 1.6;
    ballMesh.scale.setScalar((1 - ball.sink) * (1 - ball.melt * 0.6));
  }
  if (pit.frozen) {
    lavaMat.color.lerp(new THREE.Color(0xc9efff), dt * 2);
    lavaMat.emissive.lerp(new THREE.Color(0x4aa8e8), dt * 2);
    lavaMat.emissiveIntensity += (0.25 - lavaMat.emissiveIntensity) * dt * 2;
    lavaMat.roughness = 0.1;
    pitLight.color.lerp(new THREE.Color(0x9fdcff), dt * 2);
    pitLight.intensity += (15 - pitLight.intensity) * dt * 2;
    pitGlow.material.color.lerp(new THREE.Color(0x3f8fd0), dt * 2);
    pitGlow.material.opacity += (0.3 - pitGlow.material.opacity) * dt * 2;
  } else {
    lavaMat.emissiveIntensity = 1.5 + Math.sin(time * 3) * 0.35;
    pitGlow.material.opacity = 0.62 + Math.sin(time * 3) * 0.1;
    if (Math.random() < dt * 5) burst(new THREE.Vector3(pit.x + (Math.random() - 0.5) * 6, pit.y + 0.3, pit.z + (Math.random() - 0.5) * 6), 0xff8a3a, 1, 2, -1.5, 1);
    pit.cool -= dt;
    if (grounded && hd(pit.x, pit.z) < pit.r && pit.cool <= 0) {
      pit.cool = 1;
      vy = 10; grounded = false; speed = -6; soot = Math.max(soot, 0.5);
      sfx.oink();
      say('Hot. Hot. Hot. Hell is not frozen yet.', 2.5);
    }
  }

  // cows
  for (const c of cows) {
    let mv = 0;
    if (!c.home) {
      const dx = c.x - pos.x, dz = c.z - pos.z, d = Math.hypot(dx, dz);
      const hx = P.pen.x - c.x, hz = P.pen.z - c.z;
      if (Math.hypot(hx, hz) < 12) {
        // close enough to smell the hay: she walks herself in
        const want = Math.atan2(hx, hz);
        const diff = ((want - c.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        c.heading += diff * Math.min(1, dt * 5);
        mv = 4.5;
      } else if (d < 11 && d > 0.01) {
        const want = Math.atan2(dx, dz);
        let diff = ((want - c.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        c.heading += diff * Math.min(1, dt * 6);
        mv = 5.6 * (1.3 - d / 11 * 0.5);
      } else {
        c.wanderT -= dt;
        if (c.wanderT < 0) { c.wanderT = 2 + Math.random() * 4; c.heading += (Math.random() - 0.5) * 2; c.idle = Math.random() < 0.5; }
        mv = c.idle ? 0 : 0.8;
      }
      c.x += Math.sin(c.heading) * mv * dt;
      c.z += Math.cos(c.heading) * mv * dt;
      for (const k of cowColliders) {
        if (k.bottom !== undefined) continue;
        if (k.r !== undefined) {
          if (k.r < 1.5) continue; // cows shoulder past trees
          const ox = c.x - k.x, oz = c.z - k.z, od = Math.hypot(ox, oz), min = k.r + 1.6;
          if (od < min && od > 0.001) { c.x = k.x + (ox / od) * min; c.z = k.z + (oz / od) * min; }
        } else {
          const ox = c.x - k.x, oz = c.z - k.z, bx = k.hx + 1.6, bz = k.hz + 1.6;
          if (Math.abs(ox) < bx && Math.abs(oz) < bz) {
            if (bx - Math.abs(ox) < bz - Math.abs(oz)) c.x = k.x + Math.sign(ox || 1) * bx;
            else c.z = k.z + Math.sign(oz || 1) * bz;
          }
        }
      }
      const cr = Math.hypot(c.x, c.z);
      if (cr > 76) { c.x *= 76 / cr; c.z *= 76 / cr; c.heading += dt * 1.5; }
      if (Math.hypot(c.x - P.pen.x, c.z - P.pen.z) < P.pen.r) {
        c.home = true; cowsHome++;
        c.beacon.visible = false;
        c.x = P.pen.x + (cowsHome === 1 ? -1.6 : 1.6); c.z = P.pen.z + 0.5; c.heading = Math.PI;
        $('cowN').textContent = `${cowsHome}/2`;
        sfx.moo();
        burst(new THREE.Vector3(c.x, groundY(c.x, c.z) + 3, c.z), 0xffb7cf, 12, 4, 4);
        if (cowsHome === 2) { penBeacon.visible = false; complete('cows', 'The cows came home. Nobody expected to still be waiting.'); }
        else say('One cow home. Moo.', 2.2);
      }
    }
    c.moving += (mv - c.moving) * Math.min(1, dt * 5);
    c.phase += dt * (2 + c.moving * 1.6);
    pose(c.cr, c.phase, Math.min(0.6, c.moving * 0.12), time);
    c.g.position.set(c.x, groundY(c.x, c.z) + hopOf(c, dt, 0.8), c.z);
    c.g.rotation.y = c.heading;
    c.beacon.position.x = c.x; c.beacon.position.z = c.z;
  }

  // blood from a stone
  stone.cool -= dt;
  if (!feats.stone && stone.cool <= 0) {
    const hit = ramming(stone.x, stone.z, 1.45);
    if (hit === 2) {
      stone.cool = 1.1; stone.hits++;
      const dx = pos.x - stone.x, dz = pos.z - stone.z, d = Math.hypot(dx, dz);
      bounceOff();
      if (stone.hits >= 3) {
        bloodDrop.position.set(stone.x + (dx / d) * 1.15, stone.y + 1.7, stone.z + (dz / d) * 1.15);
        bloodDrop.visible = true;
        burst(bloodDrop.position, 0xc0182a, 10, 2.5, 9, 0.8);
        stoneBeacon.visible = false;
        complete('stone', 'Blood from a stone. One drop. The stone looks embarrassed.');
      } else say(STONE_LINES[stone.hits - 1], 2.4);
    } else if (hit === 1) {
      stone.cool = 3;
      say('The stone did not notice. Take a run at it: hold SHIFT.', 3);
    }
  }
  if (!found.mill && ramming(P.mill.x, P.mill.z, 3.1) === 2) { bounceOff(); secret('mill', 'Tilting at windmills. The windmill wins.'); }

  // hens
  for (const h of hens) {
    let mv = 0;
    const dx = h.x - pos.x, dz = h.z - pos.z, d = Math.hypot(dx, dz);
    h.dash = Math.max(0, h.dash - dt);
    if (!h.caught && !h.dash && d < 1.7 && nearGround() && dice.wrong(slipChance(count), h.slips)) {
      // the odds are still long: she slips free and bolts
      h.slips++; h.dash = 1.3; h.hop = 1; h.heading = Math.atan2(dx, dz);
      sfx.cluck();
      burst(new THREE.Vector3(h.x, pos.y + 1, h.z), 0xfff3c0, 16, 6, 8, 0.8);
      mishap('slips', `She slipped free. Right now that happens ${slipWords(count)}.`);
    } else if (h.dash) {
      mv = 15;
    } else if (!h.caught && d < 1.7 && nearGround()) {
      h.caught = true; h.hop = 1; hensCaught++;
      sfx.cluck();
      burst(new THREE.Vector3(h.x, pos.y + 1, h.z), 0xffffff, 10, 4, 7, 0.7);
      if (hensCaught === toothy) {
        const grin = new THREE.Sprite(new THREE.SpriteMaterial({ map: grinTex }));
        grin.scale.set(0.42, 0.21, 1); grin.position.set(0, 0.62, 0.5);
        h.cr.group.add(grin);
        coopBeacon.visible = false;
        complete('hens', "Hen's teeth. A full set. She is smiling at you.");
      } else {
        h.ride = 7; stats.rides++;
        if (!feats.hens) say(['A beak. No teeth. She would like a piggyback, though.', 'Gums. Just gums. One hen left.'][hensCaught - 1] || 'No teeth.', 3);
      }
    } else if (!h.caught && d < 7 && d > 0.01) {
      const want = Math.atan2(dx, dz) + Math.sin(time * 5 + h.phase) * 0.9;
      h.heading += (((want - h.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * Math.min(1, dt * 9);
      mv = 8.2;
    } else {
      h.wanderT -= dt;
      if (h.wanderT < 0) { h.wanderT = 1 + Math.random() * 3; h.heading += (Math.random() - 0.5) * 2.4; h.idle = Math.random() < 0.6; }
      mv = h.idle || h.caught ? 0 : 1.2;
    }
    h.x += Math.sin(h.heading) * mv * dt; h.z += Math.cos(h.heading) * mv * dt;
    const cx = h.x - P.coop.x, cz = h.z - (P.coop.z + 2), cd = Math.hypot(cx, cz);
    if (cd > 13) { h.x = P.coop.x + (cx / cd) * 13; h.z = P.coop.z + 2 + (cz / cd) * 13; h.heading += dt * 4; } // the yard has an edge, so a hen can be cornered
    const kx = h.x - P.coop.x, kz = h.z - P.coop.z, kd = Math.hypot(kx, kz);
    if (kd < 2.3 && kd > 0.001) { h.x = P.coop.x + (kx / kd) * 2.3; h.z = P.coop.z + (kz / kd) * 2.3; }
    h.moving += (mv - h.moving) * Math.min(1, dt * 6);
    h.phase += dt * (2 + h.moving * 3);
    h.hop = Math.max(0, h.hop - dt * 1.6);
    h.cr.group.position.set(h.x, groundY(h.x, h.z) + Math.sin(h.hop * Math.PI) * 1.1, h.z);
    h.cr.group.rotation.y = h.heading;
    if (h.ride > 0) { // piggyback
      h.ride -= dt;
      h.x = pos.x - Math.sin(yaw) * 0.25; h.z = pos.z - Math.cos(yaw) * 0.25; h.heading = yaw;
      h.cr.group.position.set(h.x, pos.y + 2.12 * (1 - squash) + pig.body.position.y, h.z);
      h.cr.group.rotation.y = yaw;
      if (h.ride <= 0) { h.hop = 1; h.x += Math.cos(yaw) * 2.2; h.z -= Math.sin(yaw) * 2.2; sfx.cluck(); }
    }
    h.cr.legs.forEach((l, i) => (l.rotation.x = Math.sin(h.phase * 2 + i * Math.PI) * Math.min(0.7, h.moving * 0.12)));
    if (h.cr.head) h.cr.head.rotation.x = h.moving < 0.3 ? Math.max(0, Math.sin(time * 2.2 + h.phase * 0.3)) * 0.7 : 0;
  }

  // old dog, new tricks
  {
    const near = hd(dog.x, dog.z) < 7 && nearGround();
    const dYaw = yaw - dog.lastYaw;
    dog.lastYaw = yaw;
    dog.nag -= dt;
    if (!feats.dog && !dog.act) {
      if (near && !dog.near) { dog.spin = 0; say(`The old dog is watching. Show him a trick: ${TRICK[dog.tricks[dog.step]]}.`, 5); }
      if (near) {
        dog.spin += Math.abs(dYaw);
        const want = dog.tricks[dog.step];
        const did = ev.hop ? 'hop' : ev.oink ? 'oink' : dog.spin > 5.9 ? 'spin' : null;
        if (did === want) {
          dog.act = want; dog.actT = 0; dog.step++; dog.spin = 0;
          if (want === 'oink') later(0.25, () => sfx.bark());
        } else if (did === 'spin') dog.spin = 0;
        else if (did && dog.nag <= 0) { dog.nag = 2.5; say(`He tilts his head. Not that one: ${TRICK[want]}.`, 3); }
      }
    }
    dog.near = near;
    const g = dog.cr.group;
    let y = groundY(dog.x, dog.z), spin = 0;
    if (near && !dog.act) {
      const want = Math.atan2(pos.x - dog.x, pos.z - dog.z);
      dog.heading += (((want - dog.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * Math.min(1, dt * 4);
    }
    y += hopOf(dog, dt, 1.2);
    if (dog.act) {
      dog.actT += dt;
      const t = Math.min(1, dog.actT / 0.9);
      if (dog.act === 'hop') y += Math.sin(t * Math.PI) * 1.5;
      if (dog.act === 'spin') spin = t * Math.PI * 2;
      if (dog.cr.head) dog.cr.head.rotation.x = dog.act === 'oink' ? -Math.sin(t * Math.PI) * 0.7 : 0;
      if (t >= 1) {
        dog.act = null;
        if (dog.step >= 3) { dogBeacon.visible = false; complete('dog', 'You taught an old dog three new tricks. He would like a biscuit.'); }
        else say(`He did it. Next trick: ${TRICK[dog.tricks[dog.step]]}.`, 4.5);
      }
    }
    g.position.set(dog.x, y, dog.z);
    g.rotation.y = dog.heading + spin;
    pose(dog.cr, time * 2, dog.act === 'hop' ? 0.5 : 0, time * (near ? 2.4 : 0.6));
  }

  // cats
  for (const c of cats) {
    let mv = 0;
    if (!c.home) {
      const dx = c.x - pos.x, dz = c.z - pos.z, d = Math.hypot(dx, dz);
      const hx = P.cats.x - c.x, hz = P.cats.z - c.z, hdist = Math.hypot(hx, hz);
      let want = null;
      if (hdist < 6.5) { want = Math.atan2(hx, hz); mv = 5; } // close enough to fancy the cushion
      else if (d < 9 && d > 0.01) {
        // away from the pig, but never in a straight line
        want = Math.atan2(dx, dz) + Math.sin(time * 3.1 + c.phase) * 0.75 + (Math.sin(time * 0.9 + c.phase * 3) > 0.8 ? 1.1 : 0);
        mv = 7.4 * (1.25 - (d / 9) * 0.4);
      } else {
        c.wanderT -= dt;
        if (c.wanderT < 0) { c.wanderT = 2 + Math.random() * 4; c.heading += (Math.random() - 0.5) * 2.5; c.idle = Math.random() < 0.7; }
        mv = c.idle ? 0 : 1;
      }
      if (want !== null) c.heading += (((want - c.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * Math.min(1, dt * 7);
      c.x += Math.sin(c.heading) * mv * dt; c.z += Math.cos(c.heading) * mv * dt;
      const cr = Math.hypot(c.x, c.z);
      if (cr > 74) { c.x *= 74 / cr; c.z *= 74 / cr; c.heading += dt * 2; }
      if (hdist < P.cats.r - 0.5) {
        c.home = true; catsHome++;
        c.beacon.visible = false;
        const a = catsHome * 2.1;
        c.x = P.cats.x + Math.cos(a) * 1.0; c.z = P.cats.z + Math.sin(a) * 1.0; c.heading = a + 1.2;
        $('catN').textContent = `${catsHome}/3`;
        sfx.meow();
        burst(new THREE.Vector3(c.x, groundY(c.x, c.z) + 1.5, c.z), 0xff9db5, 10, 3, 4);
        if (catsHome === 3) { catBeacon.visible = false; complete('cats', 'Three cats, herded. Nobody will believe you.'); }
        else say(`${catsHome === 1 ? 'One cat' : 'Two cats'} on the cushion. For now.`, 2.4);
      }
    }
    c.moving += (mv - c.moving) * Math.min(1, dt * 6);
    c.phase += dt * (2 + c.moving * 2.2);
    pose(c.cr, c.phase, Math.min(0.7, c.moving * 0.11), time);
    c.cr.group.position.set(c.x, groundY(c.x, c.z) + (c.home ? 0.28 : 0) + hopOf(c, dt, 1.3), c.z);
    c.cr.group.rotation.y = c.heading;
    c.beacon.position.x = c.x; c.beacon.position.z = c.z;
  }

  // the end of the rainbow
  if (rainbow.moving) {
    rainbow.fade -= dt * 2;
    if (rainbow.fade <= 0) { rainbow.moving = false; rainbow.stage++; placeRainbow(); }
  } else {
    rainbow.fade = Math.min(1, rainbow.fade + dt * 1.2);
    const e = rainbowEnd();
    if (!feats.rainbow && hd(e.x, e.z) < 3.4 && nearGround()) {
      if (rainbow.stage < 2) {
        rainbow.moving = true;
        sfx.chime();
        say(rainbow.stage === 0 ? 'The end of the rainbow has moved. Of course it has.' : 'It moved again. Once more. It cannot do this forever.', 4);
      } else {
        gold.position.set(e.x, groundY(e.x, e.z), e.z);
        gold.visible = true;
        rainbowBeacon.visible = false;
        complete('rainbow', 'The end of the rainbow held still. There is a pot. There is gold in it.');
      }
    }
  }
  rainbow.mats.forEach((m) => (m.opacity = 0.5 * Math.max(0, rainbow.fade)));
  if (gold.visible && Math.random() < dt * 4) burst(gold.position.clone().add(new THREE.Vector3(0, 1.4, 0)), 0xffe27a, 1, 2, 2, 0.6);

  // a watched pot
  {
    const d = hd(pot.x, pot.z);
    const facing = (Math.sin(yaw) * (pot.x - pos.x) + Math.cos(yaw) * (pot.z - pos.z)) / (d || 1);
    const watching = d < 7 && d > 1 && facing > 0.8 && Math.abs(speed) < 0.9 && grounded;
    if (!feats.pot) {
      if (watching) {
        pot.t += dt;
        const lines = [[0.5, 'A watched pot never boils. Keep watching. Do not look away.'], [3.5, 'Nothing. Obviously.'], [6.2, 'Was that a bubble?']];
        if (pot.said < lines.length && pot.t > lines[pot.said][0]) say(lines[pot.said++][1], 2.6);
        if (pot.t > 9) {
          pot.boiled = true;
          potBeacon.visible = false;
          sfx.hiss();
          complete('pot', 'The watched pot boiled. It could not take the pressure.');
        }
      } else {
        if (pot.t > 1.5) say('You looked away. The pot relaxes.', 2.5);
        pot.t = 0; pot.said = 0;
      }
    }
    const top = new THREE.Vector3(pot.x + (Math.random() - 0.5) * 0.9, pot.y + 1.8, pot.z + (Math.random() - 0.5) * 0.9);
    if (pot.boiled) { if (Math.random() < dt * 14) burst(top, 0xffffff, 1, 1.6, -3, 1.5); }
    else if (pot.t > 6 && Math.random() < dt * (pot.t - 5) * 1.5) burst(top, 0xdff5e0, 1, 1, -1, 0.6);
    flames.forEach((f, i) => { f.scale.y = 0.8 + Math.sin(time * (9 + i * 2.3) + i) * 0.3 + (pot.boiled ? 0.3 : 0); f.rotation.y += dt * 3; });
    fireLight.intensity = 20 + Math.sin(time * 11) * 4 + Math.sin(time * 23) * 2;
    flames.glow.material.opacity = 0.5 + Math.sin(time * 11) * 0.07;
  }

  // square peg, round hole
  if (!crate.gone) {
    const dx = crate.x - pos.x, dz = crate.z - pos.z, d = Math.hypot(dx, dz), min = crate.r + 1.0;
    if (d < min && nearGround() && d > 0.001) {
      const push = Math.max(Math.abs(speed), 3) * 1.1;
      crate.vx = (dx / d) * push; crate.vz = (dz / d) * push;
      crate.x = pos.x + (dx / d) * min; crate.z = pos.z + (dz / d) * min;
    }
    const sp = Math.hypot(crate.vx, crate.vz);
    if (sp > 0.01) {
      crate.x += crate.vx * dt; crate.z += crate.vz * dt;
      crate.rot += Math.sin(time * 7) * sp * dt * 0.04;
      const k = Math.exp(-2.4 * dt); // it scrapes rather than rolls
      crate.vx *= k; crate.vz *= k;
    }
    const br = Math.hypot(crate.x, crate.z);
    if (br > 76) { crate.x *= 76 / br; crate.z *= 76 / br; crate.vx *= -0.5; crate.vz *= -0.5; }
    crateMesh.position.set(crate.x, groundY(crate.x, crate.z) + 1, crate.z);
    crateMesh.rotation.y = crate.rot;
    crateBeacon.position.x = crate.x; crateBeacon.position.z = crate.z;
    if (Math.hypot(crate.x - hole.x, crate.z - hole.z) < hole.r - 0.45) {
      crate.gone = true;
      crateBeacon.visible = holeBeacon.visible = false;
      sfx.thud();
      burst(new THREE.Vector3(hole.x, hole.y + 0.5, hole.z), 0xd8c9a0, 16, 4, 8);
      complete('peg', 'A square peg in a round hole. It fits if you stop asking questions.');
    }
  } else if (crate.sink < 1) {
    crate.sink = Math.min(1, crate.sink + dt * 1.3);
    const e = crate.sink * crate.sink * (3 - 2 * crate.sink);
    crateMesh.position.set(crate.x + (hole.x - crate.x) * e, hole.y + 1 - e * 1.25, crate.z + (hole.z - crate.z) * e);
    crateMesh.rotation.y = crate.rot + e * 0.6;
  }

  // the barn door
  {
    const near = hd(P.horse.x, P.horse.z) < 6;
    if (near && !puzzle.heard) {
      say(puzzle.open ? 'The horse has said its piece.' : `Straight from the horse's mouth: "${puzzle.code.map((s) => s.toUpperCase()).join(', then ')}."`, 7);
      if (!puzzle.open) sfx.neigh();
    }
    puzzle.heard = near;
    if (!puzzle.open) {
      let on = null;
      if (grounded) for (const p of PLATES) if (hd(p.x, p.z) < 1.1) on = p.sym;
      if (on && on !== puzzle.on) {
        if (on === puzzle.code[puzzle.step]) {
          puzzle.step++;
          sfx.ring(puzzle.step * 2);
          if (puzzle.step === 3) openBarn();
        } else {
          puzzle.step = on === puzzle.code[0] ? 1 : 0;
          sfx.thud();
          say('Wrong order. The plates go dark. Somewhere, a horse knows the right one.', 3.5);
        }
      }
      puzzle.on = on;
    } else if (puzzle.swing < 1 && world.doorN) {
      puzzle.swing = Math.min(1, puzzle.swing + dt * 0.6);
      const a = puzzle.swing * puzzle.swing * (3 - 2 * puzzle.swing) * 1.95;
      world.doorN.rotation.y = a; world.doorS.rotation.y = -a;
    }
    plateGlow.forEach((m, i) => {
      const lit = puzzle.open || puzzle.code.indexOf(PLATES[i].sym) < puzzle.step;
      m.material.opacity += ((lit ? 0.85 : 0) - m.material.opacity) * Math.min(1, dt * 6);
    });
    const inside = inBarn();
    if (inside && pos.x < P.barn.x + 2.5) {
      if (!found.elephant) pig.setGoldWings(true);
      secret('elephant', 'The elephant in the room. Everyone has agreed not to mention it. Your wings have turned gold.');
    }
    // lamplight indoors instead of sunshine
    const k = Math.min(1, dt * 5);
    sun.intensity += ((inside ? 0.25 : sunBase) - sun.intensity) * k;
    hemi.intensity += ((inside ? 0.55 : hemiBase) - hemi.intensity) * k;
    barnLight.intensity += ((inside ? 40 : 0) - barnLight.intensity) * k;
  }

  // ---- small comedy
  // a pig in a poke
  {
    poke.t += dt;
    const d = hd(poke.x, poke.z);
    if (d < 14 && poke.t > 4.5) { poke.t = 0; poke.hop = 1; if (d < 9) sfx.muffled(); }
    if (d < 2.6 && nearGround()) { if (!found.poke) { poke.hop = 1; sfx.muffled(); } secret('poke', 'A pig in a poke. Never buy one. It oinked first.'); }
    const w = Math.sin(time * 9) * 0.04 * (d < 14 ? 1 : 0);
    poke.g.scale.set(1 + w, 1 - w, 1 - w);
    poke.g.position.y = groundY(poke.x, poke.z) + hopOf(poke, dt, 0.7);
  }
  // kick the bucket
  {
    const dx = bucket.x - pos.x, dz = bucket.z - pos.z, d = Math.hypot(dx, dz);
    bucket.cool -= dt;
    if (d < 1.5 && nearGround() && d > 0.001 && bucket.cool <= 0) {
      const push = Math.max(Math.abs(speed), 4) * 1.6;
      bucket.vx = (dx / d) * push; bucket.vz = (dz / d) * push; bucket.cool = 0.4;
      sfx.clank();
      secret('bucket', 'You kicked the bucket. You feel fine, which is unusual.');
    }
    const sp = Math.hypot(bucket.vx, bucket.vz);
    if (sp > 0.05) {
      bucket.x += bucket.vx * dt; bucket.z += bucket.vz * dt; bucket.spin += sp * dt * 2.2;
      const k = Math.exp(-1.6 * dt);
      bucket.vx *= k; bucket.vz *= k;
      const br = Math.hypot(bucket.x, bucket.z);
      if (br > 80) { bucket.vx *= -0.6; bucket.vz *= -0.6; bucket.x *= 80 / br; bucket.z *= 80 / br; }
    }
    const rolling = Math.min(1, sp / 2);
    bucket.g.position.set(bucket.x, groundY(bucket.x, bucket.z) + 0.4 + rolling * 0.1, bucket.z);
    bucket.g.rotation.set(0, Math.atan2(bucket.vx, bucket.vz), 0);
    bucket.g.rotateX(rolling * Math.PI / 2); bucket.g.rotateY(bucket.spin);
  }
  // why did the chicken cross the road
  {
    const h = roadHen, tx = h.side * 8.5 - 0.5, d = hd(h.x, h.z);
    let mv = 0;
    if (Math.abs(h.x - tx) > 0.3) mv = 5.5;
    else if (d < 6.5) {
      h.side = -h.side; h.crossed++;
      if (h.crossed === 1) secret('road', 'Why did the chicken cross the road? To get away from you.');
      else quip(['She crossed back. Nobody knows why.', 'To get to the other side. Again.', 'She has a busy schedule of crossing.'][h.crossed % 3]);
      sfx.cluck();
    }
    const dir = Math.sign(tx - h.x) || 1;
    h.x += dir * mv * dt;
    h.moving += (mv - h.moving) * Math.min(1, dt * 8);
    h.phase += dt * (2 + h.moving * 3);
    h.cr.group.position.set(h.x, groundY(h.x, h.z) + hopOf(h, dt, 0.9), h.z);
    h.cr.group.rotation.y = mv ? dir * Math.PI / 2 : Math.atan2(pos.x - h.x, pos.z - h.z);
    h.cr.legs.forEach((l, i) => (l.rotation.x = Math.sin(h.phase * 2 + i * Math.PI) * Math.min(0.7, h.moving * 0.14)));
    if (h.cr.head) h.cr.head.rotation.x = mv ? 0 : Math.max(0, Math.sin(time * 2.2)) * 0.6;
  }
  // trees, at speed
  if (speed > 11.5 && grounded) {
    for (const c of colliders) {
      if (c.kind !== 'tree' || !ramming(c.x, c.z, c.r, 0.9)) continue;
      bounceOff(); stats.trees++;
      burst(new THREE.Vector3(c.x, pos.y + 4, c.z), 0x6fbf5a, 12, 3, 5);
      if (!found.tree) secret('tree', 'Barking up the wrong tree. Wrong animal, too.');
      else quip(stats.trees % 4 === 0 ? `Trees ${stats.trees}, pig 0.` : TREE_LINES[stats.trees % TREE_LINES.length]);
      break;
    }
  }
  // standing about
  {
    const still = grounded && Math.abs(speed) < 0.4;
    const inField = Math.abs(pos.x - P.field.x) < P.field.hx && Math.abs(pos.z - P.field.z) < P.field.hz;
    fieldT = still && inField ? fieldT + dt : 0;
    if (fieldT > 1.6) secret('field', 'A pig, out standing in its field.');
    idleT = still && !won ? idleT + dt : 0;
    if (idleT > 22) { idleT = 0; quip(IDLE_LINES[idleN++ % IDLE_LINES.length], 4); }
    // trotting kicks up dust; the sea is a bath
    dustT -= dt;
    const wading = pos.y < WATER_Y - 0.05;
    if (wading !== wasWading) { wasWading = wading; sfx.splash(); }
    if (grounded && Math.abs(speed) > 1.5 && !wading) { // clip-clop
      hoofT -= Math.abs(speed) * dt;
      if (hoofT <= 0) { hoofT += speed > 10 ? 2.1 : 1.5; hoofB = !hoofB; sfx.hoof(hoofB, speed > 10); }
    }
    sfx.ambience(dt, {
      shore: clamp(1 - Math.abs(offshore(pos.x, pos.z) + 2) / 16, 0, 1) * clamp(1 - (pos.y - 4) / 40, 0.25, 1),
      wind: grounded ? 0 : clamp(Math.abs(speed) / 22 + Math.abs(vy) / 30 + pos.y / 160, 0, 1),
      fire: clamp(1 - hd(P.camp.x, P.camp.z) / 13, 0, 1),
      lava: pit.frozen ? 0 : clamp(1 - hd(pit.x, pit.z) / 16, 0, 1),
      night: clamp((mood - 0.5) / 0.4, 0, 1),
      meadow: clamp(1 - pos.y / 30, 0, 1) * (inBarn() ? 0.2 : 1),
    });
    if (wading && Math.abs(speed) > 1 && dustT <= 0) { dustT = 0.1; burst(new THREE.Vector3(pos.x, WATER_Y + 0.1, pos.z), 0xffffff, 2, 3, 9, 0.8); }
    else if (grounded && speed > 10.5 && dustT <= 0) { dustT = 0.11; burst(new THREE.Vector3(pos.x - Math.sin(yaw) * 1.1, pos.y + 0.15, pos.z - Math.cos(yaw) * 1.1), 0xe0d2ae, 1, 1.2, 1.5, 1.1); }
    if (wading) { if (!found.wash) soot = 0; secret('wash', 'Hogwash. You are now a slightly cleaner pig.'); }
  }
  // the fish shows off whenever there is an audience
  {
    const d = hd(P.pond.x, P.pond.z);
    fish.t += dt;
    if (fish.t > 4.2 && d < 18) { fish.t = 0; fish.side = -fish.side; }
    const k = fish.t / 0.95, px = BRIDGE.dz * 3.1 * fish.side, pz = -BRIDGE.dx * 3.1 * fish.side;
    if (k < 1) {
      const at = (q) => new THREE.Vector3(P.pond.x + px + BRIDGE.dx * (q - 0.5) * 3.4, WATER_Y - 0.3 + Math.sin(q * Math.PI) * 2.6, P.pond.z + pz + BRIDGE.dz * (q - 0.5) * 3.4);
      fish.g.position.copy(at(k));
      fish.g.lookAt(at(k + 0.05));
      if ((k < 0.08 || k > 0.92) && Math.random() < 0.7) burst(new THREE.Vector3(fish.g.position.x, WATER_Y + 0.1, fish.g.position.z), 0xffffff, 2, 3, 9, 0.7);
    } else fish.g.position.y = WATER_Y - 1.5;
    if (d < 4.6 && nearGround()) secret('fish', 'A big fish in a small pond. It knows.');
  }
  lamp.rotation.y += dt * 0.55;
  { const night = clamp((mood - 0.45) / 0.55, 0, 1); lamp.beam.opacity = 0.035 + night * 0.2; lamp.glow.material.opacity = 0.12 + night * 0.88; }
  if (pos.distanceTo(cloud9.position) < 8) secret('cloud9', 'You are on cloud nine. The view is smug.');
  if (hd(pearls.x, pearls.z) < 3) secret('pearls', 'Pearls before swine. You are unimpressed, as is traditional.');
  if (moonCow.cr) {
    // round and round, over the top of the moon
    moonCow.a += dt * 0.8;
    const tx = -MOON_POS.z, tz = MOON_POS.x, tl = Math.hypot(tx, tz), R = 16.5;
    const at = (a) => new THREE.Vector3(MOON_POS.x + (tx / tl) * Math.cos(a) * R, MOON_POS.y + Math.sin(a) * R, MOON_POS.z + (tz / tl) * Math.cos(a) * R);
    moonCow.cr.group.position.copy(at(moonCow.a));
    moonCow.cr.group.lookAt(at(moonCow.a + 0.2));
    pose(moonCow.cr, time * 9, 0.7, time);
  }

  // other secrets
  if (hd(P.herring.x, P.herring.z) < 3.4) secret('herring', 'A red herring. It has nothing to do with anything.');
  if (hd(P.worms.x, P.worms.z) < 3.2) secret('worms', 'You have opened a can of worms. It will not close again.');
  if (hd(P.ducks.x, P.ducks.z) < 7.5 && pos.y < 6) secret('ducks', 'All your ducks, in a row. Somebody on this island is organised.');
  if (pos.distanceTo(MOON_POS) < 12.5) secret('cheese', 'The moon is made of green cheese. Confirmed by snout.');
  ducks.forEach((d, i) => { d.position.y = WATER_Y - 0.12 + Math.sin(time * 1.7 + i * 1.3) * 0.09; d.rotation.z = Math.sin(time * 1.3 + i) * 0.08; });
  ev.hop = ev.oink = false;

  // finale
  if (finale) {
    moonBlue = Math.min(1, moonBlue + dt * 0.5);
    moonMat.color.copy(MOON_WHITE).lerp(MOON_BLUE, moonBlue);
    rings.forEach((r, i) => {
      if (i < ringIdx) { r.scale.multiplyScalar(1 + dt * 2); r.material.opacity = Math.max(0, r.material.opacity - dt * 1.5); if (r.material.opacity <= 0) r.visible = false; return; }
      const next = i === ringIdx;
      r.material.opacity = next ? 1 : 0.35;
      r.material.emissiveIntensity = next ? 1.2 + Math.sin(time * 6) * 0.6 : 0.3;
      if (next) r.scale.setScalar(1 + Math.sin(time * 4) * 0.05);
    });
    if (!won && ringIdx < rings.length) {
      const r = rings[ringIdx];
      if (pos.clone().add(new THREE.Vector3(0, 1.3, 0)).distanceTo(r.position) < 5) {
        sfx.ring(ringIdx);
        burst(r.position, 0xffc93c, 24, 8, 3, 1.3);
        ringIdx++;
        if (ringIdx === rings.length) win();
        else if (ringIdx === rings.length - 1) say('Last one. Over the moon.', 3);
        else say(`Ring ${ringIdx} of ${rings.length}.`, 1.6);
      }
    }
  }

  for (const o of rain) {
    o.g.position.y -= o.v * dt;
    o.g.rotation.x += o.spin.x * dt; o.g.rotation.y += o.spin.y * dt; o.g.rotation.z += o.spin.z * dt;
    if (o.g.position.y < groundY(o.g.position.x, o.g.position.z) - 1 || o.g.position.y < -1) resetRain(o, false);
  }
}

const camPos = new THREE.Vector3(0, 8, -14), camLook = new THREE.Vector3();
let orbit = 0;
let debugCam = null;
function updateCamera(dt) {
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  if (debugCam) {
    camera.position.set(...debugCam.slice(0, 3));
    camera.lookAt(...debugCam.slice(3));
  } else if (!started) {
    orbit += dt * 0.25;
    camPos.set(pos.x + Math.sin(orbit) * 9, pos.y + 3.2, pos.z + Math.cos(orbit) * 9);
    camera.position.copy(camPos);
    camera.lookAt(pos.x, pos.y + 1.5, pos.z);
  } else if (firstPerson) {
    camera.position.set(pos.x + fx * 1.0, pos.y + 2.75, pos.z + fz * 1.0);
    camLook.set(pos.x + fx * 12, pos.y + 2.0 + clamp(vy * 0.25, -4, 4), pos.z + fz * 12);
    camera.lookAt(camLook);
    camPos.copy(camera.position);
  } else {
    const inside = inBarn();
    const dist = inside ? 4.6 : grounded ? 10.5 : 12.5;
    const want = new THREE.Vector3(pos.x - fx * dist, pos.y + (inside ? 2.7 : 5.2), pos.z - fz * dist);
    const bx = P.barn.x, bz = P.barn.z;
    if (inside) {
      // stay in the room with the pig, or look in through the doorway
      want.z = clamp(want.z, bz - 3.3, bz + 3.3);
      want.x = clamp(want.x, bx - 4.3, Math.abs(want.z - bz) < 1.2 && Math.abs(pos.z - bz) < 1.2 ? bx + 14 : bx + 4.3);
      want.y = Math.min(want.y, barnBase + 4.9);
    } else {
      // and never end up inside the barn looking out through a wall
      for (let i = 0; i < 10 && Math.abs(want.x - bx) < 5.5 && Math.abs(want.z - bz) < 4.5 && want.y < barnBase + 9.5; i++) want.lerp(new THREE.Vector3(pos.x, want.y + 1.2, pos.z), 0.18);
    }
    if (!inside) {
      // nor inside a tree: come in closer to the pig until the leaves are out of the way
      const leafy = (v) => colliders.some((c) => c.kind === 'tree' && v.y < c.top && Math.hypot(v.x - c.x, v.z - c.z) < c.r * 3.6);
      for (let i = 0; i < 6 && leafy(want); i++) want.lerp(new THREE.Vector3(pos.x, pos.y + 3.4, pos.z), 0.2);
    }
    camPos.lerp(want, 1 - Math.exp(-dt * (inside ? 7 : 4.5)));
    const minY = (inside ? standY(camPos.x, camPos.z) : groundY(camPos.x, camPos.z)) + 1.2;
    if (camPos.y < minY) camPos.y = minY;
    camera.position.copy(camPos);
    camera.lookAt(pos.x + fx * (inside ? 1.5 : 4), pos.y + (inside ? 2.0 : 2.6), pos.z + fz * (inside ? 1.5 : 4));
  }
  if (shake > 0.001) {
    camera.position.x += (Math.random() - 0.5) * shake; camera.position.y += (Math.random() - 0.5) * shake; camera.position.z += (Math.random() - 0.5) * shake;
    shake *= Math.exp(-dt * 7);
  }
  const fov = 62 + (grounded ? clamp((speed - 9) * 1.3, 0, 6) : clamp(Math.abs(speed) * 0.35 + Math.max(0, -vy) * 0.25, 0, 9));
  if (Math.abs(fov - camera.fov) > 0.05) { camera.fov += (fov - camera.fov) * Math.min(1, dt * 4); camera.updateProjectionMatrix(); }
  sky.position.copy(camera.position);
  sun.position.copy(pos).addScaledVector(SUN, 110);
  sun.target.position.copy(pos);
  sunGlow.position.copy(camera.position).addScaledVector(new THREE.Vector3(SUN.x, SUN.y * (1 - mood * 0.85), SUN.z).normalize(), 900);
}

// ---------------------------------------------------------------- loop
let last = performance.now(), slowAvg = 1 / 60, slowSince = performance.now() + 3000, slowStep = 0;
function frame(now) {
  let dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  // A machine that cannot keep up gets a lighter picture: fewer pixels first, then no bloom.
  slowAvg += (dt - slowAvg) * 0.02;
  if (slowAvg > 1 / 28 && now - slowSince > 4000 && slowStep < 2) {
    slowSince = now; slowAvg = 1 / 60;
    if (slowStep++ === 0) { renderer.setPixelRatio(1); composer.setPixelRatio(1); resize(); } else bloom.enabled = false;
  }
  if (slowT > 0) { slowT -= dt; dt *= 0.35; } // a held breath when something impossible happens
  // One bad frame must not stop every frame after it: note it, light the stuck button, carry on.
  try { step(dt); composer.render(); } catch (e) { if (tele.error('frame', e)) { console.error(e); stuckBtn?.classList.add('on'); } }
  requestAnimationFrame(frame);
}
function step(dt) {
  runPending(dt);
  if (started) {
    if (!won) time += dt;
    updatePig(dt);
    updateFeats(dt);
    $('timer').textContent = fmtTime(time);
  } else {
    time += 0;
    pig.group.position.copy(pos);
    pig.group.rotation.y = yaw;
    pig.update(dt, { speed: 0, airborne: false, t: now() });
  }
  for (const p of particles) {
    if (!p.m.visible) continue;
    p.life -= dt;
    if (p.life <= 0) { p.m.visible = false; continue; }
    p.v.y -= p.g * dt;
    p.m.position.addScaledVector(p.v, dt);
  }
  for (const k in signs) { const g = signs[k]; if (g.wobble > 0) { g.wobble = Math.max(0, g.wobble - dt * 1.4); g.rotation.z = Math.sin(g.wobble * 22) * 0.14 * g.wobble; } }
  updateWorldLife(dt);
  waterMat.uniforms.time.value += dt;
  if (world.blades) world.blades.rotation.x += dt * 0.45;
  for (const c of clouds) { c.position.x += dt * 1.2; if (c.position.x > 240) c.position.x = -240; }
  if (toastT > 0) { toastT -= dt; if (toastT <= 0) toastEl.classList.remove('show'); }
  updateCamera(dt);
}
const now = () => performance.now() / 1000;

refreshHud();
requestAnimationFrame(frame);

// Hooks for automated play-testing.
window.__wpf = {
  // Render one frame at a given size and hand it back as a JPEG data URL (used to make the launcher's poster).
  shot(w, h) {
    const pr = renderer.getPixelRatio();
    renderer.setPixelRatio(1); composer.setPixelRatio(1);
    renderer.setSize(w, h, false); composer.setSize(w, h);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    updateCamera(0); composer.render();
    const url = canvas.toDataURL('image/jpeg', 0.92);
    renderer.setPixelRatio(pr); composer.setPixelRatio(pr); resize();
    return url;
  },
  active, seed, puzzle, fish, offshore, poke, bucket, pearls, roadHen, cloud9, stats, get mood() { return mood; }, setMood(v) { mood = v; },
  rainbow, dog, hens, cats, crate, stone, pot, found, openBarn, secret, inBarn, FAIRY_RINGS, PLATES,
  get toothy() { return toothy; },
  get state() { return { x: pos.x, y: pos.y, z: pos.z, yaw, speed, vy, grounded, flaps, count, feats: { ...feats }, cloverCount, cowsHome, catsHome, hensCaught, foundN, barnOpen: puzzle.open, finale, ringIdx, won, time, started, ball: { x: ball.x, z: ball.z }, cows: cows.map((c) => ({ x: c.x, z: c.z, home: c.home })) }; },
  places: { P, rod, pit, clovers: clovers.map((c) => ({ x: c.x, z: c.z })), stacks: stacks.map((s) => ({ x: s.x, z: s.z })), rings: rings.map((r) => r.position.toArray()) },
  teleport(x, y, z) { pos.set(x, y === null ? standY(x, z) : y, z); vy = 0; grounded = y === null; },
  face(a) { yaw = a; },
  view(...v) { debugCam = v.length === 6 ? v : null; },
  keys, begin, step, groundY, tele, touch, ball, MOON_POS, dice,
  get holdFlap() { return holdFlap; },
  press(code, on) { keys[code] = on; if (code === 'Space') { holdFlap = on; if (on) flapQueued = true; } },
};
