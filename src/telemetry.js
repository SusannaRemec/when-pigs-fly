// A flight recorder for the pig. It keeps the last ten seconds of what the game was doing and
// notices when the pig is being pushed but is not going anywhere (which is also what leaning on
// a wall looks like, so noticing only lights the button up; it does not interrupt). It also
// keeps any errors the game threw and whether the browser took the picture away. Nothing is sent anywhere: a
// report stays in this browser (localStorage 'wpf-stuck') until the player chooses to share it.
// No three.js in here, so it can be run and tested in Node.

const SAMPLE = 0.1;      // seconds between samples
const KEEP = 100;        // samples kept: ten seconds
const EVENTS = 40;       // recent input and game events kept
const PUSH_FOR = 3;      // pushing this long ...
const MOVED_LESS = 1.2;  // ... and moved less than this far, counts as stuck
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

export function createRecorder({ build = '', context = () => ({}), onStuck = () => {} } = {}) {
  const samples = [], events = [], errors = [];
  let t = 0, acc = 0, hits = new Set(), worstDt = 0;
  let pushT = 0, anchor = null, stuck = false, lastFree = null, onset = null;

  function note(type, detail) {
    events.push(detail === undefined ? [r2(t), type] : [r2(t), type, detail]);
    if (events.length > EVENTS) events.shift();
  }

  // Called once a frame, after the pig has moved. s: { x, y, z, yaw, speed, vy, grounded, ground, fwd, turn }
  function tick(dt, s) {
    t += dt; acc += dt;
    if (dt > worstDt) worstDt = dt;
    const broken = ![s.x, s.y, s.z, s.yaw, s.speed].every(Number.isFinite);

    // Being pushed (stick or key held, on the ground) without getting anywhere.
    const pushing = Math.abs(s.fwd) > 0.3 && s.grounded;
    if (!pushing || !anchor) { pushT = 0; anchor = { x: s.x, z: s.z }; }
    else {
      pushT += dt;
      const moved = Math.hypot(s.x - anchor.x, s.z - anchor.z);
      if (moved > MOVED_LESS) { pushT = 0; anchor = { x: s.x, z: s.z }; if (stuck) { stuck = false; note('free'); } }
    }
    if (s.grounded && Math.abs(s.speed) > 4 && pushT < 0.5 && !broken) lastFree = { x: s.x, z: s.z, t };

    if (acc >= SAMPLE) {
      acc = 0;
      samples.push({
        t: r2(t), x: r1(s.x), y: r2(s.y), z: r1(s.z), yaw: r2(s.yaw), sp: r1(s.speed), vy: r1(s.vy), g: s.grounded ? 1 : 0,
        gy: r2(s.ground), f: r2(s.fwd), tu: r2(s.turn), ms: Math.round(worstDt * 1000), ...(hits.size ? { hit: [...hits].join() } : {}),
      });
      if (samples.length > KEEP) samples.shift();
      hits = new Set(); worstDt = 0;
    }

    if (!stuck && (broken || pushT > PUSH_FOR)) {
      stuck = true;
      note('stuck', broken ? 'bad numbers' : 'pushing, not moving');
      onset = save(report(broken ? 'bad numbers' : 'pushing, not moving')); // taken early, so it still holds the run-up
      onStuck();
    }
  }

  // Something threw. The same message again only raises its count, so a fault in every frame stays one line.
  function error(where, e) {
    const msg = `${where}: ${e && e.message ? e.message : e}`;
    const seen = errors.find((x) => x.msg === msg);
    if (seen) { seen.n++; return false; }
    if (errors.length < 8) errors.push({ t: r2(t), msg, n: 1, stack: String((e && e.stack) || '').split('\n').slice(0, 5).map((l) => l.trim().replace(/https?:\/\/[^/]+\//, '')).join(' < ') });
    note('error', msg);
    return true;
  }

  function report(why) {
    return { why, build, at: new Date().toISOString(), ...context(), lastFree: lastFree && { x: r1(lastFree.x), z: r1(lastFree.z), secondsAgo: r1(t - lastFree.t) }, errors: errors.map((x) => ({ ...x })), events: [...events], samples: [...samples] };
  }

  function save(rep) {
    try {
      const all = JSON.parse(localStorage.getItem('wpf-stuck') || '[]');
      all.push(rep);
      localStorage.setItem('wpf-stuck', JSON.stringify(all.slice(-3)));
    } catch { /* storage full or switched off: the report is still returned to the caller */ }
    return rep;
  }

  return {
    tick, note, report, error,
    hit(kind) { hits.add(kind || 'boulder'); },
    // The player says they are stuck, whether or not the recorder noticed.
    manual() { note('reported'); return save({ ...report(stuck ? 'pushing, not moving (reported)' : 'reported by player'), onset }); },
    get stuck() { return stuck; },
    get faults() { return errors.length; },
    // Somewhere the pig stood a little while ago, at least `far` away from where it is now.
    escape(x, z, far = 6) {
      for (let i = samples.length - 1; i >= 0; i--) { const q = samples[i]; if (q.g && Math.hypot(q.x - x, q.z - z) > far) return { x: q.x, z: q.z }; }
      return null;
    },
    clear() { stuck = false; pushT = 0; anchor = null; onset = null; },
  };
}
