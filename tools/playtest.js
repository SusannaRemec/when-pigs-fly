// Automated run through the seven newer jobs, the barn puzzle and the secrets. It steers and
// teleports the pig through the game's test hooks, so it checks the rules, not how they feel.
// In the browser console on play.html?feats=stone,hens,dog,cats,pot, after pressing Start:
//   eval(await (await fetch('./tools/playtest.js')).text()).then(console.log)
// It leaves a best time and win count in localStorage.
(async () => {
  const w = window.__wpf, g = w.groundY, P = w.places.P, log = {};
  const run = (sec, each) => { for (let t = 0; t < sec; t += 1 / 60) { if (each) each(); w.step(1 / 60); } };
  const key = (code) => window.dispatchEvent(new KeyboardEvent('keydown', { code }));
  for (const k in w.keys) w.keys[k] = false;
  // stone
  w.teleport(P.stone.x - 12, null, P.stone.z); w.face(Math.PI / 2);
  w.press('ShiftLeft', true); w.press('KeyW', true);
  run(14, () => { const s = w.state; if (Math.hypot(s.x - P.stone.x, s.z - P.stone.z) > 9 || s.speed < 0) w.face(Math.atan2(P.stone.x - s.x, P.stone.z - s.z)); });
  w.press('ShiftLeft', false); w.press('KeyW', false); run(1.5);
  log.stone = w.state.feats.stone; log.stoneHits = w.stone.hits;
  // hens: chase the nearest uncaught one on foot at a trot
  w.press('ShiftLeft', true); w.press('KeyW', true);
  w.teleport(P.coop.x + 6, null, P.coop.z + 6);
  run(40, () => { const s = w.state; const h = w.hens.filter((h) => !h.caught).sort((a, b) => Math.hypot(a.x - s.x, a.z - s.z) - Math.hypot(b.x - s.x, b.z - s.z))[0]; if (h && !s.feats.hens) w.face(Math.atan2(h.x - s.x, h.z - s.z)); });
  w.press('ShiftLeft', false); w.press('KeyW', false); run(1);
  log.hens = w.state.feats.hens; log.hensCaught = w.state.hensCaught; log.toothy = w.toothy;
  // dog
  w.teleport(w.dog.x + 3, null, w.dog.z + 3); run(0.5);
  for (let i = 0; i < 3; i++) {
    const t = w.dog.tricks[i];
    if (t === 'hop') { w.press('Space', true); run(0.1); w.press('Space', false); }
    if (t === 'oink') key('KeyE');
    if (t === 'spin') { w.press('KeyA', true); run(2.6); w.press('KeyA', false); }
    run(2);
  }
  log.dog = w.state.feats.dog; log.tricks = w.dog.tricks.join();
  // cats: walk at each cat from the far side of it
  w.press('KeyW', true);
  for (let n = 0; n < 3; n++) {
    const c = w.cats.find((c) => !c.home); if (!c) break;
    const a0 = Math.atan2(c.x - P.cats.x, c.z - P.cats.z);
    w.teleport(c.x + Math.sin(a0) * 6, null, c.z + Math.cos(a0) * 6);
    run(40, () => { if (c.home) return; const s = w.state; const a = Math.atan2(c.x - P.cats.x, c.z - P.cats.z); const tx = c.x + Math.sin(a) * 3.5, tz = c.z + Math.cos(a) * 3.5; w.face(Math.atan2(tx - s.x, tz - s.z)); });
  }
  w.press('KeyW', false); run(1);
  log.cats = w.state.feats.cats; log.catsHome = w.state.catsHome;
  // pot
  w.teleport(P.camp.x + 4, null, P.camp.z); w.face(-Math.PI / 2); run(11);
  log.pot = w.state.feats.pot;
  run(5);
  log.finale = w.state.finale; log.count = w.state.count;
  // off-list: rainbow, peg
  for (let i = 0; i < 3; i++) { const e = w.FAIRY_RINGS[w.rainbow.order[w.rainbow.stage]]; w.teleport(e.x + 1, null, e.z); run(2.5); }
  log.rainbow = w.state.feats.rainbow;
  w.press('KeyW', true);
  w.teleport(w.crate.x + 5, null, w.crate.z + 1);
  run(60, () => { if (w.crate.gone) return; const s = w.state; const a = Math.atan2(w.crate.x - P.hole.x, w.crate.z - P.hole.z); const tx = w.crate.x + Math.sin(a) * 1.6, tz = w.crate.z + Math.cos(a) * 1.6; const off = Math.hypot(tx - s.x, tz - s.z); w.face(off > 1.2 ? Math.atan2(tx - s.x, tz - s.z) : Math.atan2(P.hole.x - s.x, P.hole.z - s.z)); });
  w.press('KeyW', false); run(1);
  log.peg = w.state.feats.peg;
  // barn puzzle
  w.teleport(P.horse.x + 4, null, P.horse.z); run(0.3);
  for (const sym of w.puzzle.code) { const p = w.PLATES.find((p) => p.sym === sym); w.teleport(p.x, null, p.z); run(0.3); w.teleport(-10, null, 46); run(0.2); } // step well clear, so as not to tread on the next plate
  log.barnOpen = w.state.barnOpen;
  // walk in through the door
  w.teleport(P.barn.x + 9, null, P.barn.z); w.face(-Math.PI / 2); w.press('KeyW', true); run(2.2); w.press('KeyW', false);
  log.inBarn = w.inBarn(); log.barnPos = [w.state.x.toFixed(1), w.state.y.toFixed(2), w.state.z.toFixed(1)]; log.floor = (g(P.barn.x, P.barn.z) + 0.8).toFixed(2);
  // secrets
  w.teleport(P.herring.x + 1, null, P.herring.z); run(0.2);
  w.teleport(P.worms.x + 1, null, P.worms.z); run(0.2);
  w.teleport(P.ducks.x * 0.97, null, P.ducks.z * 0.97); run(0.2);
  w.teleport(P.mill.x + 10, null, P.mill.z); w.face(-Math.PI / 2); w.press('ShiftLeft', true); w.press('KeyW', true); run(2); w.press('ShiftLeft', false); w.press('KeyW', false);
  log.found = Object.keys(w.found).join(); log.foundN = w.state.foundN;
  return JSON.stringify(log);
})()

// The later secrets. Run after the script above, or on its own after pressing Start:
//   eval((await (await fetch('./tools/playtest.js')).text()).split('// ---8<---').pop())
// ---8<---
(async () => {
  const w = window.__wpf, P = w.places.P, log = {};
  const run = (sec, each) => { for (let t = 0; t < sec; t += 1 / 60) { if (each) each(); w.step(1 / 60); } };
  for (const k in w.keys) w.keys[k] = false;
  w.teleport(w.poke.x + 1.5, null, w.poke.z); run(0.3);
  w.teleport(w.bucket.x + 1, null, w.bucket.z); run(0.5); log.bucketMoved = Math.hypot(w.bucket.vx, w.bucket.vz) > 0.5;
  w.teleport(w.pearls.x + 1.5, null, w.pearls.z); run(0.3);
  w.teleport(w.roadHen.x + 4, null, w.roadHen.z + 2); run(4); log.henCrossed = w.roadHen.crossed;
  w.teleport(P.field.x, null, P.field.z); run(2.2);
  w.teleport(86, null, 0); run(0.5);
  w.teleport(w.cloud9.position.x, w.cloud9.position.y, w.cloud9.position.z); run(0.1);
  // find a tree with a clear run-up from the west and trot into it
  w.teleport(0, null, 0); run(0.2);
  w.press('ShiftLeft', true); w.press('KeyW', true);
  for (const dir of [0, 1.57, 3.14, -1.57, 0.8, -0.8, 2.3, -2.3]) { if (w.found.tree) break; w.teleport(0, null, 0); w.face(dir); run(9, () => { if (w.state.speed < 0) w.press('KeyW', false); }); w.press('KeyW', true); }
  w.press('ShiftLeft', false); w.press('KeyW', false);
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE' })); run(0.2);
  log.found = Object.keys(w.found).join(); log.foundN = w.state.foundN; log.stats = JSON.stringify(w.stats);
  return JSON.stringify(log);
})()
