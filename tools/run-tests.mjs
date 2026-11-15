// The browser half of `npm test`: plays the game in headless Chrome and fails if anything is off.
// No dependencies: it serves the folder itself and talks to Chrome over its debugging socket.
//   node tools/run-tests.mjs            CHROME=/path/to/chrome overrides where Chrome is looked for
// Screenshots of each run are left in tools/shots/ (not committed) for a person to look at.
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm', '.jpg': 'image/jpeg', '.png': 'image/png' };
const DESKTOP = { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false };
const PHONE = { width: 390, height: 664, deviceScaleFactor: 2, mobile: true };
const NEWER = 'stone,hens,dog,cats,pot', FIRST = 'needle,clover,lightning,hell,cows';
const parts = readFileSync(root + 'tools/playtest.js', 'utf8').split('\n// ---8<---\n');

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); if (!ok) failed++; };

// ---- a static server for this folder
const server = createServer(async (req, res) => {
  try {
    let path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (path.endsWith('/')) path += 'index.html';
    const file = join(root, path);
    if (!file.startsWith(root)) throw new Error('outside');
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// ---- Chrome
const chromePath = [process.env.CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
if (!chromePath) { console.log('FAIL no Chrome found; set CHROME=/path/to/chrome'); process.exit(1); }
const profile = await mkdtemp(join(tmpdir(), 'wpf-test-'));
const chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--mute-audio', '--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((resolve, reject) => {
  let err = '';
  chrome.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) resolve(m[1]); });
  chrome.on('exit', () => reject(new Error('Chrome exited: ' + err.slice(-400))));
  setTimeout(() => reject(new Error('Chrome did not start')), 20000);
});
const ws = new WebSocket(wsUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let nextId = 1;
const waiting = new Map(), faults = [];
ws.onmessage = ({ data }) => {
  const m = JSON.parse(data);
  if (m.id && waiting.has(m.id)) { const { resolve, reject } = waiting.get(m.id); waiting.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
  else if (m.method === 'Runtime.exceptionThrown') faults.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).split('\n').slice(0, 3).join(' < '));
  else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') faults.push('console.error: ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300));
};
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = nextId++; waiting.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params, sessionId })); });
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const cdp = (method, params) => send(method, params, sessionId);
await cdp('Runtime.enable'); await cdp('Page.enable');
const evaluate = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const open = async (path, viewport) => {
  await cdp('Emulation.setDeviceMetricsOverride', viewport);
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: viewport.mobile });
  await cdp('Page.navigate', { url: base + path });
};
const shoot = async (name) => {
  const { data } = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 80 });
  await mkdir(root + 'tools/shots', { recursive: true });
  await writeFile(`${root}tools/shots/${name}.jpg`, Buffer.from(data, 'base64'));
};
// Everything a player can see that pokes out past the edge of the screen.
const OFFSCREEN = `[...document.querySelectorAll('body *')].filter((e) => { const s = getComputedStyle(e), r = e.getBoundingClientRect(); return e.tagName !== 'CANVAS' && s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && e.children.length === 0 && !e.closest('.ticker') && (r.left < -1 || r.right > innerWidth + 1); }).map((e) => e.id || e.className || e.tagName).slice(0, 5).join(', ')`;
const noFaults = (name) => { check(`${name}: no errors on the page`, faults.length === 0, faults.slice(0, 3).join(' || ')); faults.length = 0; };

async function launcher(name, viewport) {
  await open('/index.html', viewport);
  await evaluate(`new Promise((r) => setTimeout(r, 2500))`);
  check(`${name}: nothing runs off the screen`, (await evaluate(OFFSCREEN)) === '', await evaluate(OFFSCREEN));
  const h1 = await evaluate(`(() => { const r = document.querySelector('h1').getBoundingClientRect(); return r.right <= innerWidth && r.left >= 0; })()`);
  check(`${name}: the title fits`, h1);
  await shoot(name);
  noFaults(name);
}

async function game(name, viewport, feats, partNos, expect) {
  await open(`/play.html?feats=${feats}`, viewport);
  const ready = await evaluate(`(async () => { for (let i = 0; i < 300; i++) { if (window.__wpf && !document.getElementById('go').disabled) return true; await new Promise((r) => setTimeout(r, 100)); } return false; })()`);
  check(`${name}: the island loads`, ready);
  if (!ready) { noFaults(name); return; }
  const card = await evaluate(`(() => { const r = document.querySelector('#start .card').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; })()`);
  check(`${name}: the start card fits the screen`, card);
  await shoot(name + '-start');
  await evaluate(`localStorage.clear(); window.__wpf.begin()`);
  // A phone can take a touch off the flap button without telling the button. The pig must still stop flapping.
  const flap = JSON.parse(await evaluate(`(() => {
    const w = window.__wpf, fb = document.getElementById('flapBtn'), out = {};
    const down = (id) => fb.dispatchEvent(new PointerEvent('pointerdown', { pointerId: id, pointerType: 'touch', bubbles: true }));
    down(7); out.held = w.holdFlap;
    window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 7, pointerType: 'touch' })); out.afterCancel = w.holdFlap;
    down(8); window.dispatchEvent(Object.assign(new Event("touchend"), { touches: [] })); out.afterEmptyTouchend = w.holdFlap; // no pointer event at all, and no touches left
    down(9); down(10); window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 9, pointerType: 'touch' })); out.oneOfTwoLeft = w.holdFlap;
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 10, pointerType: 'touch' })); out.bothLifted = w.holdFlap;
    const a = document.getElementById('back').getBoundingClientRect(), b = document.getElementById('stuckBtn').getBoundingClientRect();
    out.gap = Math.round(Math.max(b.left - a.right, a.left - b.right, b.top - a.bottom, a.top - b.bottom));
    return JSON.stringify(out);
  })()`));
  check(`${name}: the flap button lets go when the lift goes missing`, flap.held === true && flap.afterCancel === false && flap.afterEmptyTouchend === false && flap.oneOfTwoLeft === true && flap.bothLifted === false, JSON.stringify(flap));
  if (viewport.mobile) check(`${name}: "stuck?" is well clear of the launcher link`, flap.gap >= 40, `gap ${flap.gap}px`);
  const seen = {};
  for (const n of partNos) Object.assign(seen, JSON.parse(await evaluate(parts[n])));
  for (const [key, want] of Object.entries(expect)) check(`${name}: ${key}`, typeof want === 'function' ? want(seen[key]) : seen[key] === want, `saw ${JSON.stringify(seen[key])}`);
  check(`${name}: the HUD stays on the screen`, (await evaluate(OFFSCREEN)) === '', await evaluate(OFFSCREEN));
  check(`${name}: the game threw nothing while playing`, (await evaluate(`window.__wpf.tele.faults`)) === 0, JSON.stringify(await evaluate(`window.__wpf.tele.report().errors`)));
  await evaluate(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
  await shoot(name + '-end');
  noFaults(name);
}

const NEWER_EXPECT = { stone: true, hens: true, henSlipped: true, dog: true, cats: true, pot: true, finale: true, count: 5, rainbow: true, peg: true, barnOpen: true, inBarn: true, foundN: (n) => n >= 13 };
const FIRST_EXPECT = { luckStart: 'Things go wrong 3 times in 4.', melted: true, melts: 1, luckEnd: '', needle: true, clover: true, lightning: true, hell: true, cows: true, count: 5, finale: true, rings: 7, won: true, winScreen: true, cheese: true, fish: true, errors: 0 };
try {
  await launcher('launcher-desktop', DESKTOP);
  await launcher('launcher-phone', PHONE);
  await game('newer-jobs-desktop', DESKTOP, NEWER, [0, 1], NEWER_EXPECT);
  await game('first-jobs-and-win-desktop', DESKTOP, FIRST, [2], FIRST_EXPECT);
  await game('first-jobs-and-win-phone', PHONE, FIRST, [2], FIRST_EXPECT);
} catch (e) {
  check('the test run itself', false, e.message);
} finally {
  ws.close(); chrome.kill(); server.close();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall browser checks passed');
process.exit(failed ? 1 : 0);
