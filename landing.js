import * as THREE from 'three';
import { createPig } from './src/pig.js';

// ---------- odds counter: nervous at rest, collapses when you reach for Play
const oddsEl = document.getElementById('odds');
const BASE = 3720000;
let shown = BASE, goal = BASE;
const play = document.getElementById('play');
play.addEventListener('pointerenter', () => (goal = 1));
play.addEventListener('pointerleave', () => (goal = BASE));
play.addEventListener('focus', () => (goal = 1));
play.addEventListener('blur', () => (goal = BASE));
setInterval(() => {
  if (goal === BASE && Math.abs(shown - BASE) < 2000) shown = BASE - Math.floor(Math.random() * 900);
  else shown = goal === 1 ? Math.max(1, Math.floor(shown * 0.72)) : Math.min(BASE, Math.ceil(shown * 1.6 + 3));
  oddsEl.textContent = '1 in ' + shown.toLocaleString('en-US');
}, 70);

// ---------- personal best from the game
const best = parseFloat(localStorage.getItem('wpf-best') || '0');
if (best > 0) {
  const el = document.getElementById('best');
  el.hidden = false;
  el.textContent = `Your record: over the moon in ${Math.floor(best / 60)}:${String(Math.floor(best % 60)).padStart(2, '0')}. Beat it.`;
}

// ---------- ticker
const lines = [
  'Odds of a pig flying: <b>1 in 3,720,000</b>', 'Hell: <b>still warm</b>', 'Cows: <b>not home</b>', 'Lightning strikes on this pig: <b>0</b>',
  'Needles located: <b>0</b>', 'Moon colour: <b>the usual</b>', 'Four-leaf clovers: <b>pending</b>', 'Snowball outlook: <b>slim</b>',
];
const track = document.getElementById('ticker');
track.innerHTML = [...lines, ...lines].map((l) => `<span>${l}</span><span>✦</span>`).join('');

// ---------- hero scene
const canvas = document.getElementById('hero');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
camera.position.set(0, 1.4, 13);

scene.add(new THREE.HemisphereLight(0xdff0ff, 0xffc7b0, 1.5));
const sun = new THREE.DirectionalLight(0xfff0d8, 2.4);
sun.position.set(-6, 10, 8);
scene.add(sun);

const pig = createPig();
const rig = new THREE.Group();
rig.add(pig.group);
pig.group.position.y = -1.3;
scene.add(rig);

const cloudMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: true });
const clouds = [];
for (let i = 0; i < 16; i++) {
  const g = new THREE.Group();
  const n = 3 + Math.floor(Math.random() * 4);
  for (let j = 0; j < n; j++) {
    const m = new THREE.Mesh(new THREE.IcosahedronGeometry(0.9 + Math.random() * 1.1, 1), cloudMat);
    m.position.set((j - n / 2) * 1.3, Math.random() * 0.6, Math.random() - 0.5);
    m.scale.y = 0.6;
    g.add(m);
  }
  g.position.set(Math.random() * 70 - 35, Math.random() * 16 - 8, -6 - Math.random() * 30);
  g.userData.v = 2 + Math.random() * 3;
  scene.add(g);
  clouds.push(g);
}

// a few rings in the distance, as a promise
const ringMat = new THREE.MeshStandardMaterial({ color: 0xffc93c, emissive: 0xffa800, emissiveIntensity: 0.7, roughness: 0.4 });
const rings = [];
for (let i = 0; i < 3; i++) {
  const r = new THREE.Mesh(new THREE.TorusGeometry(2.2, 0.16, 10, 40), ringMat);
  r.position.set(30 + i * 26, i * 2 - 2, -10);
  r.rotation.y = Math.PI / 2 - 0.5;
  scene.add(r);
  rings.push(r);
}

let wide = true;
function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  wide = w / h > 1.05;
  // On wide screens the pig sits to the right of the headline; on narrow ones, above it.
  const halfH = Math.tan((camera.fov * Math.PI) / 360) * camera.position.z;
  rig.userData.home = wide ? new THREE.Vector3(halfH * camera.aspect * 0.46, 0.3, 0) : new THREE.Vector3(0, halfH * 0.48, 0);
  rig.scale.setScalar(wide ? Math.min(1.25, 0.75 + camera.aspect * 0.22) : 0.82);
}
window.addEventListener('resize', resize);
resize();

const mouse = { x: 0, y: 0 };
window.addEventListener('pointermove', (e) => {
  mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouse.y = (e.clientY / window.innerHeight) * 2 - 1;
});

const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let last = performance.now(), t = 0;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  t += dt;
  const home = rig.userData.home;
  rig.position.set(home.x + Math.sin(t * 0.7) * 0.25, home.y + Math.sin(t * 1.6) * 0.3, 0);
  // three-quarter view, flying toward screen-left where the headline is
  rig.rotation.y += ((-1.0 + mouse.x * 0.45) - rig.rotation.y) * Math.min(1, dt * 3);
  rig.rotation.x += ((mouse.y * 0.2 + 0.28) - rig.rotation.x) * Math.min(1, dt * 3);
  rig.rotation.z = Math.sin(t * 0.9) * 0.08;
  pig.update(dt, { speed: 0, airborne: true, t });

  for (const c of clouds) {
    c.position.x += c.userData.v * dt;
    if (c.position.x > 40) c.position.x = -40;
  }
  for (const r of rings) {
    r.position.x += 7 * dt;
    if (r.position.x > 60) r.position.x = -60;
  }
  renderer.render(scene, camera);
  if (!reduce) requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
if (reduce) setTimeout(() => frame(performance.now()), 100);
