// Checks that need no browser. Run with: node tools/test-node.mjs   (npm test runs this first)
//   1. blender/layout.json is what src/layout.js would write now.
//   2. The pig can always walk away: from every spot on the island, some heading makes headway.
//   3. The flight recorder notices a jam, and only a jam.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as L from '../src/layout.js';
import { steer, fall, contain, collide, land, TROT } from '../src/move.js';
import { createRecorder } from '../src/telemetry.js';
import { slipChance, slipWords, meltSeconds, makeDice, MAX_SLIPS } from '../src/odds.js';

const root = fileURLToPath(new URL('..', import.meta.url));
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); if (!ok) failed++; };

// ---- 1. layout export in step
{
  const before = readFileSync(root + 'blender/layout.json', 'utf8');
  execFileSync('node', [root + 'tools/dump-layout.mjs'], { stdio: 'pipe' });
  const after = readFileSync(root + 'blender/layout.json', 'utf8');
  check('blender/layout.json matches src/layout.js', before === after, before === after ? '' : '(it has been rewritten; bake again and commit)');
}

// ---- 2. nowhere traps the pig
{
  const colliders = L.buildColliders().filter((c) => c.kind !== 'door'); // doors open during play; walls are tested shut and open below
  const walk = (x0, z0, yaw, dt, secs, solids) => {
    const b = { x: x0, y: L.standY(x0, z0), z: z0, yaw, speed: 0, vy: 0, grounded: true }, shore = { x: x0, z: z0 };
    for (let t = 0; t < secs; t += dt) {
      steer(b, { turn: 0, fwd: 1, sprint: true, airSpeed: 10 }, dt);
      fall(b, null, dt);
      contain(b, shore, L.offshore);
      collide(b, dt, solids, null);
      land(b, L.standY);
    }
    return Math.hypot(b.x - x0, b.z - z0);
  };
  const withDoor = L.buildColliders();
  const traps = [];
  let spots = 0;
  for (const dt of [1 / 60, 1 / 20]) for (const solids of [colliders, withDoor]) {
    for (let x = -96; x <= 96; x += 2) for (let z = -96; z <= 96; z += 2) {
      if (L.offshore(x, z) > 5) continue; // out in the sea, where the wading limit is the point
      if (solids === withDoor && Math.abs(x - L.P.barn.x) < 5 && Math.abs(z - L.P.barn.z) < 4) continue; // shut inside the barn: nobody starts there
      spots++;
      let best = 0;
      for (let h = 0; h < 8 && best < 6; h++) best = Math.max(best, walk(x, z, h * Math.PI / 4 + 0.05, dt, 2, solids));
      if (best < 6) traps.push([x, z, +best.toFixed(1), `dt ${dt.toFixed(3)}`]);
    }
  }
  check(`the pig can walk away from all ${spots} spots tried`, traps.length === 0, traps.slice(0, 8).map((t) => t.join(',')).join(' | '));
  // and trotting in a straight line over open ground covers the distance it should
  const open = walk(0, 0, 0.5, 1 / 60, 2, []);
  check('two seconds at a trot covers 23 to 27 units', open > 23 && open < TROT * 2, open.toFixed(1));
}

// ---- 3. the recorder
{
  const store = {};
  globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } };
  let fired = 0;
  const r = createRecorder({ build: 'test', onStuck: () => fired++ });
  const at = (x, fwd, sp) => ({ x, y: 0, z: 0, yaw: 0, speed: sp, vy: 0, grounded: true, ground: 0, fwd, turn: 0 });
  let x = 0;
  for (let i = 0; i < 300; i++) { x += 9 / 60; r.tick(1 / 60, at(x, 1, 9)); }
  check('walking freely is not stuck', !r.stuck && fired === 0);
  for (let i = 0; i < 300; i++) r.tick(1 / 60, at(x, 0, 0));
  check('standing still is not stuck', !r.stuck);
  r.hit('tree');
  for (let i = 0; i < 240; i++) r.tick(1 / 60, at(x + Math.sin(i) * 0.1, 1, 0.5));
  const saved = JSON.parse(store['wpf-stuck'] || '[]');
  check('pushing without moving is stuck, once, and is saved', r.stuck && fired === 1 && saved.length === 1 && saved[0].samples.some((s) => s.hit === 'tree'));
  check('the report offers somewhere to go back to', !!r.escape(x, 0));
  for (let i = 0; i < 60; i++) { x += 9 / 60; r.tick(1 / 60, at(x, 1, 9)); }
  check('walking off clears it', !r.stuck);
  check('an error is recorded once however often it repeats', r.error('frame', new Error('boom')) === true && r.error('frame', new Error('boom')) === false && r.report().errors[0].n === 2);
}

// ---- 4. the odds get kinder with every job, and never trap anyone
{
  const counts = [0, 1, 2, 3, 4];
  check('each job finished makes a slip less likely and a snowball last longer', counts.slice(1).every((c) => slipChance(c) < slipChance(c - 1) && meltSeconds(c) > meltSeconds(c - 1)));
  check('with four jobs done nothing slips', slipChance(4) === 0 && slipWords(4) === 'never' && slipWords(0) === '3 times in 4');
  const dice = makeDice(() => 0); // the unluckiest dice there are
  check('however the dice fall, one animal gets away only so often', dice.wrong(1, 0) && dice.wrong(1, MAX_SLIPS - 1) && !dice.wrong(1, MAX_SLIPS));
  const fair = makeDice(L.makeRnd(7)); let wrong = 0;
  for (let i = 0; i < 4000; i++) if (fair.wrong(slipChance(1))) wrong++;
  check('the dice roll what they say', Math.abs(wrong / 4000 - 0.5) < 0.04, (wrong / 4000).toFixed(3));
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall node checks passed');
process.exit(failed ? 1 : 0);
