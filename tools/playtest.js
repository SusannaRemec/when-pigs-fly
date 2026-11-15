// Automated play-through. It steers and teleports the pig through the game's test hooks
// (window.__wpf), stepping the simulation by hand, so it checks the rules, not how they feel.
// `npm test` runs all of it in a headless browser (tools/run-tests.mjs) and fails on any false.
//
// Three parts, separated by a scissors line; each returns a JSON string of what it saw.
//   Part 1 and 2 expect play.html?feats=stone,hens,dog,cats,pot   (the seven newer jobs, the barn, the secrets)
//   Part 3 expects       play.html?feats=needle,clover,lightning,hell,cows   (the first five jobs, then the flight to the win)
// By hand, in the console after pressing Start (n is 0, 1 or 2):
//   eval((await (await fetch('./tools/playtest.js')).text()).split('\n// ---8<---\n')[n]).then(console.log)
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
  w.dice.fix = true; // the odds: the first hen touched slips free, and after that the dice are held kind
  run(40, () => { if (w.stats.slips) w.dice.fix = false; const s = w.state; const h = w.hens.filter((h) => !h.caught).sort((a, b) => Math.hypot(a.x - s.x, a.z - s.z) - Math.hypot(b.x - s.x, b.z - s.z))[0]; if (h && !s.feats.hens) w.face(Math.atan2(h.x - s.x, h.z - s.z)); });
  w.press('ShiftLeft', false); w.press('KeyW', false); run(1);
  log.hens = w.state.feats.hens; log.hensCaught = w.state.hensCaught; log.toothy = w.toothy; log.henSlipped = w.stats.slips === 1;
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

// Part 2: the later secrets.
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
// ---8<---
(async () => {
  const w = window.__wpf, P = w.places.P, log = {};
  const run = (sec, each) => { for (let t = 0; t < sec; t += 1 / 60) { if (each && each() === false) return; w.step(1 / 60); } };
  for (const k in w.keys) w.keys[k] = false;
  // the odds: with no job done, a snowball left in the heat of the pit melts, and another turns up in the snow
  log.luckStart = document.getElementById('luck').textContent;
  w.teleport(0, null, 0); w.ball.x = w.places.pit.x + 8; w.ball.z = w.places.pit.z; run(4);
  log.melted = w.stats.melts === 1 && Math.hypot(w.ball.x - P.snow.x, w.ball.z - P.snow.z) < 0.1;
  // needle: root through every haystack
  for (const s of w.places.stacks) { w.teleport(s.x + 1.5, null, s.z); run(0.3); }
  log.needle = w.state.feats.needle;
  // clovers: the four that are out this game
  for (const c of w.places.clovers) { w.teleport(c.x + 0.5, null, c.z); run(0.3); }
  log.clover = w.state.feats.clover;
  // lightning: stand by the rod and stay put
  w.teleport(w.places.rod.x + 1, null, w.places.rod.z); run(7);
  log.lightning = w.state.feats.lightning;
  // snowball: nudge it from the side away from the pit until it rolls in
  for (let i = 0; i < 80 && !w.ball.gone; i++) {
    const pit = w.places.pit, a = Math.atan2(w.ball.x - pit.x, w.ball.z - pit.z);
    w.teleport(w.ball.x + Math.sin(a) * 2, null, w.ball.z + Math.cos(a) * 2); run(0.9);
  }
  log.hell = w.state.feats.hell;
  // cows: stay on the far side of each from the pen, and she walks away from the pig toward it
  for (let i = 0; i < 2; i++) {
    run(90, () => {
      const c = w.state.cows[i]; if (c.home) return false;
      const a = Math.atan2(c.x - P.pen.x, c.z - P.pen.z);
      w.teleport(c.x + Math.sin(a) * 5, null, c.z + Math.cos(a) * 5);
    });
  }
  log.cows = w.state.feats.cows; log.count = w.state.count;
  // the blue moon rises a few seconds after the fifth job
  w.teleport(0, null, 0); run(5);
  log.finale = w.state.finale;
  // fly the rings for real: hold the wings, climb when below the ring, steer at it
  w.press('KeyW', true);
  const rings = w.places.rings;
  run(150, () => {
    const s = w.state; if (s.won) return false;
    const r = rings[s.ringIdx]; if (!r) return false;
    const flat = Math.hypot(r[0] - s.x, r[2] - s.z);
    w.face(Math.atan2(r[0] - s.x, r[2] - s.z));
    w.press('Space', s.y + 1.3 < r[1] + 0.5);
    w.press('KeyW', flat > 2.5 || Math.abs(s.y + 1.3 - r[1]) < 3); // hover under a ring that is still overhead
  });
  w.press('KeyW', false); w.press('Space', false);
  log.rings = w.state.ringIdx; log.won = w.state.won; log.flightSeconds = Math.round(w.state.time);
  run(3);
  log.winScreen = !document.getElementById('win').classList.contains('hidden');
  // two secrets the other parts cannot reach: the moon, and the pond
  w.teleport(w.MOON_POS.x, w.MOON_POS.y + 11, w.MOON_POS.z); run(0.1);
  w.teleport(P.pond.x + 3, null, P.pond.z); run(0.3);
  log.cheese = !!w.found.cheese; log.fish = !!w.found.fish;
  log.luckEnd = document.getElementById('luck').textContent; log.melts = w.stats.melts;
  log.errors = w.tele.faults;
  return JSON.stringify(log);
})()
