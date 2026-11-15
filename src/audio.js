// All sound is synthesised with WebAudio; there are no audio files.
//
// Three buses (effects, music, ambience) run into a compressor so that a thunderclap over the
// band over the sea cannot clip, with a little shared reverb to put everything in one place.
const nf = (semi) => 261.63 * Math.pow(2, semi / 12); // semitones above middle C -> Hz
const vary = (amt = 0.06) => 1 + (Math.random() * 2 - 1) * amt;

// The tune: sixteen bars of eight steps, A A' B A'. Notes are semitones above middle C; -1 rests.
const CHORDS = { C: [0, 4, 7], F: [5, 9, 12], G: [7, 11, 14], Am: [9, 12, 16] };
const A1 = [['C', [0, 4, 7, 4, 9, 7, 4, -1]], ['C', [0, 4, 7, 12, 9, 7, 4, -1]], ['F', [5, 9, 12, 9, 14, 12, 9, -1]], ['G', [7, 11, 14, 11, 7, 5, 2, -1]]];
const A2 = [['C', [12, -1, 9, 7, 4, 7, 9, -1]], ['C', [12, -1, 9, 7, 4, 2, 0, -1]], ['F', [5, 5, 9, 12, 9, 5, 9, -1]], ['G', [7, 7, 11, 14, 11, 7, 2, -1]]];
const B1 = [['Am', [9, 12, 16, 12, 9, -1, 12, -1]], ['F', [5, 9, 12, 9, 5, -1, 9, -1]], ['C', [4, 7, 12, 7, 4, -1, 7, -1]], ['G', [2, 7, 11, 7, 14, 11, 7, -1]]];
const SONG = [...A1, ...A2, ...B1, ...A2];

// Level trims, set by measurement (tools/sound-check.html) so that effects peak within a few
// decibels of one another: the filtered ones lose most of their energy on the way out.
const TRIM = {
  oink: 1.5, muffled: 0.5, flap: 2.8, hop: 2.3, hoof: 3, thud: 1.7, splash: 2.2, moo: 0.65, meow: 1.7, cluck: 1.7, neigh: 1.15,
  creak: 0.75, clank: 2, hiss: 0.8, win: 0.75, ring: 1.6,
};

export class Sfx {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.musicTimer = null;
    this.level = 0;        // jobs done, 0..5: the band fills out as the odds shorten
    this.dream = false;    // the finale: slow and starlit
    this.won = false;
    this.trim = 1;
    for (const [name, gain] of Object.entries(TRIM)) {
      const play = this[name].bind(this);
      this[name] = (...args) => { this.trim = gain; play(...args); this.trim = 1; };
    }
  }

  // Pass an OfflineAudioContext to render sounds for measurement (tools/sound-check.html).
  init(ctx) {
    if (this.ctx) { if (this.ctx.resume) this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!ctx && !AC) return;
    const c = this.ctx = ctx || new AC();
    this.master = c.createGain();
    this.master.gain.value = this.muted ? 0 : 0.9;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 12; comp.ratio.value = 5; comp.attack.value = 0.004; comp.release.value = 0.22;
    this.master.connect(comp); comp.connect(c.destination);

    // a short, dark room
    const len = Math.floor(c.sampleRate * 1.7), ir = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) { lp += (Math.random() * 2 - 1 - lp) * 0.35; d[i] = lp * Math.pow(1 - i / len, 2.6); }
    }
    const verb = c.createConvolver();
    verb.buffer = ir;
    const wet = c.createGain();
    wet.gain.value = 0.5;
    verb.connect(wet); wet.connect(this.master);
    const bus = (gain, send) => {
      const g = c.createGain(), s = c.createGain();
      g.gain.value = gain; s.gain.value = send;
      g.connect(this.master); g.connect(s); s.connect(verb);
      return g;
    };
    this.fx = bus(1, 0.16);
    this.music = bus(0.42, 0.3);
    this.amb = bus(0.8, 0.08);

    const n = c.sampleRate * 2;
    this.noiseBuf = c.createBuffer(1, n, c.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;

    // two beds that are always running, turned up and down by ambience(): the sea, and wind in the ears
    const bed = (type, freq, q) => {
      const s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
      s.buffer = this.noiseBuf; s.loop = true;
      f.type = type; f.frequency.value = freq; f.Q.value = q;
      g.gain.value = 0;
      s.connect(f); f.connect(g); g.connect(this.amb);
      s.start();
      return { f, g };
    };
    this.sea = bed('lowpass', 520, 0.5);
    this.wind = bed('bandpass', 520, 0.7);
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.9;
    return this.muted;
  }

  // One note. slide: glide to a pitch by the end. bend: [[fraction of dur, Hz], ...] for a shaped
  // call (a moo goes up, then down). vib: { rate, depth in Hz }. hold: fraction of dur at full volume.
  tone(freq, dur, { type = 'sine', vol = 0.2, when = 0, slide = null, bend = null, vib = null, filter = null, attack = 0.012, hold = 0, bus = null } = {}) {
    if (!this.ctx) return;
    if (!bus) vol *= this.trim;
    const t = this.ctx.currentTime + when;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (bend) for (const [k, f] of bend) o.frequency.exponentialRampToValueAtTime(f, t + dur * k);
    else if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
    if (vib) {
      const l = this.ctx.createOscillator(), lg = this.ctx.createGain();
      l.frequency.value = vib.rate; lg.gain.value = vib.depth;
      l.connect(lg); lg.connect(o.frequency);
      l.start(t); l.stop(t + dur + 0.05);
    }
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + Math.min(attack, dur * 0.5));
    if (hold) g.gain.setValueAtTime(vol, t + dur * hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = o;
    if (filter) {
      const f = this.ctx.createBiquadFilter();
      f.type = filter.type; f.frequency.value = filter.freq; f.Q.value = filter.q || 1;
      o.connect(f); node = f;
    }
    node.connect(g); g.connect(bus || this.fx);
    o.start(t); o.stop(t + dur + 0.05);
  }

  noise(dur, { vol = 0.2, when = 0, type = 'lowpass', from = 800, to = null, q = 1, attack = 0, bus = null } = {}) {
    if (!this.ctx) return;
    if (!bus) vol *= this.trim;
    const t = this.ctx.currentTime + when;
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.Q.value = q;
    f.frequency.value = from;
    if (to) { f.frequency.setValueAtTime(from, t); f.frequency.exponentialRampToValueAtTime(to, t + dur); }
    const g = this.ctx.createGain();
    g.gain.value = 0; // silent until its moment
    if (attack) { g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + attack); } else g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(bus || this.fx);
    s.start(t, Math.random()); s.stop(t + dur + 0.05);
  }

  // ---------------------------------------------------------------- the pig
  oink() {
    const p = vary(0.09), bp = { type: 'bandpass', freq: 900 * p, q: 3 };
    this.tone(190 * p, 0.11, { type: 'sawtooth', vol: 0.34, slide: 120 * p, filter: bp });
    this.tone(235 * p, 0.17, { type: 'sawtooth', vol: 0.34, bend: [[0.3, 265 * p], [1, 105 * p]], filter: bp, when: 0.13 });
    this.noise(0.09, { vol: 0.07, type: 'bandpass', from: 1500, q: 2, when: 0.13 }); // the snort in it
  }
  muffled() {
    const f = { type: 'lowpass', freq: 380, q: 1 };
    this.tone(190, 0.11, { type: 'sawtooth', vol: 0.3, slide: 120, filter: f });
    this.tone(230, 0.16, { type: 'sawtooth', vol: 0.3, slide: 110, filter: f, when: 0.13 });
  }
  flap() { this.noise(0.2, { vol: 0.2, type: 'bandpass', from: 1000 * vary(0.15), to: 190, q: 0.8, attack: 0.02 }); }
  hop() { this.tone(250 * vary(), 0.13, { type: 'triangle', vol: 0.16, slide: 430 }); }
  // one hoof; the game alternates a and b so a trot goes clip-clop
  hoof(b, hard) {
    const v = hard ? 1 : 0.6;
    this.tone((b ? 150 : 185) * vary(0.05), 0.05, { vol: 0.1 * v, slide: 80, attack: 0.003 });
    this.noise(0.035, { vol: 0.05 * v, type: 'bandpass', from: b ? 1500 : 2100, q: 1.5 });
  }
  thud() {
    this.tone(120, 0.2, { vol: 0.42, slide: 45, attack: 0.004 });
    this.noise(0.09, { vol: 0.12, type: 'lowpass', from: 700 });
  }
  splash() {
    this.noise(0.4, { vol: 0.2, type: 'bandpass', from: 1700, to: 420, q: 0.7, attack: 0.015 });
    this.tone(520, 0.12, { vol: 0.05, slide: 210, when: 0.03 });
  }

  // ---------------------------------------------------------------- the neighbours
  moo() {
    const p = vary(0.07);
    for (const [type, freq, vol] of [['lowpass', 520, 0.3], ['bandpass', 950, 0.1]]) {
      this.tone(98 * p, 1.15, { type: 'sawtooth', vol, bend: [[0.22, 158 * p], [0.7, 150 * p], [1, 104 * p]], vib: { rate: 5.5, depth: 3 }, filter: { type, freq, q: 2.5 }, attack: 0.09, hold: 0.55 });
    }
  }
  bark() {
    const p = vary(0.08), f = { type: 'bandpass', freq: 760, q: 1.8 };
    for (const when of [0, 0.17]) {
      this.tone(330 * p, 0.1, { type: 'sawtooth', vol: 0.36, bend: [[0.25, 390 * p], [1, 160 * p]], filter: f, when, attack: 0.006 });
      this.noise(0.07, { vol: 0.09, type: 'bandpass', from: 1300, q: 1, when });
    }
  }
  meow() {
    const p = vary(0.1);
    this.tone(520 * p, 0.62, { type: 'sawtooth', vol: 0.22, bend: [[0.28, 930 * p], [0.6, 880 * p], [1, 560 * p]], vib: { rate: 6, depth: 9 }, filter: { type: 'bandpass', freq: 1650, q: 3.5 }, attack: 0.06, hold: 0.5 });
  }
  cluck() {
    const p = vary(0.1), f = { type: 'bandpass', freq: 1900, q: 3 };
    [0, 0.09, 0.18].forEach((when) => this.tone(540 * p, 0.05, { type: 'square', vol: 0.15, slide: 400 * p, when, filter: f, attack: 0.004 }));
    this.tone(600 * p, 0.2, { type: 'square', vol: 0.17, bend: [[0.35, 1050 * p], [1, 700 * p]], when: 0.29, filter: f, attack: 0.01 }); // buk buk buk b'KAW
  }
  neigh() {
    this.tone(1250, 0.95, { type: 'sawtooth', vol: 0.2, bend: [[0.12, 1500], [1, 420]], vib: { rate: 13, depth: 95 }, filter: { type: 'bandpass', freq: 1400, q: 1.6 }, attack: 0.03, hold: 0.4 });
    this.noise(0.28, { vol: 0.1, type: 'bandpass', from: 900, to: 300, q: 0.8, when: 0.9, attack: 0.03 }); // and a blow through the lips
  }
  trumpet() {
    for (const [type, vol] of [['sawtooth', 0.26], ['square', 0.1]]) {
      this.tone(290, 1.05, { type, vol, bend: [[0.3, 760], [0.75, 700], [1, 430]], vib: { rate: 19, depth: 34 }, filter: { type: 'bandpass', freq: 1050, q: 1.4 }, attack: 0.05, hold: 0.7 });
    }
    this.noise(0.9, { vol: 0.06, type: 'bandpass', from: 1500, q: 0.8, attack: 0.1 });
  }

  // ---------------------------------------------------------------- things
  chime() { [7, 11, 16].forEach((n, i) => { this.tone(nf(n + 12), 0.5, { vol: 0.13, when: i * 0.07 }); this.tone(nf(n + 24), 0.3, { vol: 0.04, when: i * 0.07 }); }); }
  rustle() { this.noise(0.32, { vol: 0.22, type: 'highpass', from: 2400, attack: 0.02 }); this.noise(0.2, { vol: 0.1, type: 'bandpass', from: 900, q: 0.7, when: 0.05 }); }
  creak() {
    this.tone(88, 1.7, { type: 'sawtooth', vol: 0.3, bend: [[0.4, 150], [0.7, 120], [1, 175]], vib: { rate: 7, depth: 6 }, filter: { type: 'bandpass', freq: 640, q: 6 }, attack: 0.1, hold: 0.8 });
    this.noise(1.5, { vol: 0.07, type: 'bandpass', from: 500, to: 900, q: 5, attack: 0.1 });
    this.tone(70, 0.3, { vol: 0.3, slide: 40, when: 1.7 }); // and they bump the wall
  }
  clank() {
    const p = vary(0.08);
    [1180, 1900, 2750, 3620].forEach((f, i) => this.tone(f * p, 0.32 - i * 0.05, { type: 'square', vol: 0.06, when: i * 0.008, attack: 0.002 }));
    this.noise(0.07, { vol: 0.22, type: 'highpass', from: 2800 });
  }
  hiss() { this.noise(1.9, { vol: 0.3, type: 'highpass', from: 5200, to: 1100, attack: 0.03 }); this.tone(1900, 1.2, { vol: 0.03, slide: 2600, vib: { rate: 9, depth: 60 } }); }
  thunder() {
    this.noise(0.14, { vol: 0.7, type: 'highpass', from: 1800 });                       // the crack
    this.noise(2.4, { vol: 0.6, type: 'lowpass', from: 420, to: 55, when: 0.04 });      // the roll
    this.noise(1.8, { vol: 0.28, type: 'lowpass', from: 240, to: 50, when: 0.7, attack: 0.25 }); // and its echo off the hill
    this.tone(62, 1.4, { vol: 0.3, slide: 34, when: 0.03 });
  }
  bubble() { this.tone(170 * vary(0.3), 0.14, { vol: 0.09, slide: 420, bus: this.amb, attack: 0.02 }); }

  // ---------------------------------------------------------------- jingles (in the key of the tune)
  feat() {
    [0, 4, 7, 12].forEach((n, i) => this.tone(nf(n + 12), 0.4, { type: 'triangle', vol: 0.2, when: i * 0.1 }));
    [12, 16, 19, 24].forEach((n) => this.tone(nf(n), 1.3, { vol: 0.07, when: 0.42, attack: 0.03 })); // a chord to land on
    this.noise(0.5, { vol: 0.04, type: 'highpass', from: 7000, when: 0.42, attack: 0.02 });
  }
  ring(i) {
    const n = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21][Math.max(0, Math.min(9, i))]; // up the pentatonic scale
    this.tone(nf(n + 12), 0.6, { type: 'triangle', vol: 0.2 });
    this.tone(nf(n + 24), 0.5, { vol: 0.09, when: 0.04 });
    this.tone(nf(n + 19), 0.5, { vol: 0.05, when: 0.08 });
  }
  win() {
    const tune = [0, 4, 7, 12, 7, 12, 16, 19];
    tune.forEach((n, i) => {
      this.tone(nf(n + 12), 0.45, { type: 'triangle', vol: 0.2, when: i * 0.14 });
      this.tone(nf(n + 12 - (i % 2 ? 3 : 4)), 0.4, { vol: 0.07, when: i * 0.14 });
    });
    [0, 7, 12, 16, 19, 24].forEach((n) => this.tone(nf(n), 2.4, { type: 'triangle', vol: 0.08, when: 1.15, attack: 0.04, hold: 0.3 }));
    this.tone(nf(-12), 2.4, { vol: 0.2, when: 1.15, hold: 0.3 });
    this.noise(1.2, { vol: 0.05, type: 'highpass', from: 6500, when: 1.15, attack: 0.03 });
  }

  // ---------------------------------------------------------------- music
  // The band grows with the pig's progress: tuba and tune; then off-beat chords; a shaker; a held
  // harmony; sparkles. The finale drops to a slow, starlit version; winning brings everyone back.
  setProgress(level, dream, won) { this.level = level; this.dream = dream && !won; this.won = won; }

  playStep(i, when) {
    const m = this.music, bar = SONG[(i >> 3) % SONG.length], s = i & 7;
    const chord = CHORDS[bar[0]], root = chord[0], note = bar[1][s];
    const lv = this.won ? 5 : this.level;
    if (this.dream) {
      if (s === 0) {
        const len = this.stepLen * 8;
        chord.forEach((n) => this.tone(nf(n), len, { type: 'sawtooth', vol: 0.02, when, attack: 0.5, hold: 0.7, filter: { type: 'lowpass', freq: 850, q: 0.7 }, bus: m }));
        this.tone(nf(root - 12), len * 0.95, { vol: 0.085, when, attack: 0.08, hold: 0.6, bus: m });
      }
      if (note >= 0) this.tone(nf(note + 12), 0.6, { vol: 0.085, when, attack: 0.03, vib: { rate: 5, depth: 3 }, bus: m });
      this.tone(nf(chord[(i * 2) % 3] + 24 + (s % 4 === 3 ? 12 : 0)), 0.3, { vol: 0.017, when: when + this.stepLen * 0.5, bus: m });
      return;
    }
    if (s === 0 || s === 4) { // oom
      const f = nf(s === 0 ? root - 12 : root - 17);
      this.tone(f, 0.2, { type: 'triangle', vol: 0.15, when, bus: m });
      this.tone(f, 0.18, { type: 'sawtooth', vol: 0.045, when, filter: { type: 'lowpass', freq: 420, q: 1 }, bus: m });
    }
    if (lv >= 1 && (s === 2 || s === 6)) chord.forEach((n) => this.tone(nf(n), 0.09, { type: 'triangle', vol: 0.032, when, bus: m })); // pah
    if (lv >= 2 && (s & 1)) this.noise(0.035, { vol: s === 3 || s === 7 ? 0.04 : 0.022, type: 'highpass', from: 6500, when, bus: m });
    if (lv >= 3 && s === 0) this.tone(nf(chord[1] + 12), this.stepLen * 7, { vol: 0.03, when, attack: 0.12, hold: 0.6, bus: m });
    if (lv >= 4) this.tone(nf(chord[i % 3] + 24), 0.1, { vol: 0.016, when, bus: m });
    if (note >= 0) {
      this.tone(nf(note), 0.19, { type: 'triangle', vol: 0.085, when, bus: m });
      if (lv >= 2) this.tone(nf(note + 12), 0.15, { vol: lv >= 5 ? 0.04 : 0.018, when, bus: m });
    }
  }

  startMusic() {
    if (!this.ctx || this.musicTimer) return;
    let i = 0, next = this.ctx.currentTime + 0.15;
    this.musicTimer = setInterval(() => {
      while (next < this.ctx.currentTime + 0.4) {
        this.stepLen = this.dream ? 0.3 : 0.2;
        const swing = !this.dream && (i & 1) ? this.stepLen * 0.14 : 0;
        this.playStep(i, Math.max(0, next + swing - this.ctx.currentTime));
        i++; next += this.stepLen;
      }
    }, 100);
  }

  // ---------------------------------------------------------------- ambience
  // Called every frame with how much of each thing the pig can hear, 0..1.
  ambience(dt, { shore = 0, wind = 0, fire = 0, lava = 0, night = 0, meadow = 0 }) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const swell = 0.6 + 0.4 * Math.sin(t * 0.9) * Math.sin(t * 0.23 + 1);
    this.sea.g.gain.setTargetAtTime(shore * 0.11 * swell, t, 0.25);
    this.sea.f.frequency.setTargetAtTime(380 + swell * 420, t, 0.3);
    this.wind.g.gain.setTargetAtTime(wind * 0.09, t, 0.2);
    this.wind.f.frequency.setTargetAtTime(380 + wind * 700, t, 0.2);
    const chance = (perSec) => Math.random() < perSec * dt;
    if (fire > 0.05 && chance(9 * fire)) this.noise(0.03, { vol: 0.09 * fire * Math.random(), type: 'bandpass', from: 1500 + Math.random() * 3500, q: 2, bus: this.amb });
    if (lava > 0.05 && chance(2.2 * lava)) this.tone(90 * vary(0.35), 0.16, { vol: 0.1 * lava, slide: 260, attack: 0.03, bus: this.amb });
    if (meadow > 0.05 && night < 0.5 && chance(0.35)) { // a bird, somewhere
      const f = 2300 + Math.random() * 1500, n = 2 + (Math.random() * 3 | 0);
      for (let k = 0; k < n; k++) this.tone(f, 0.07, { vol: 0.022 * meadow, bend: [[0.5, f * 1.25], [1, f * 0.9]], when: k * 0.11, bus: this.amb });
    }
    if (meadow > 0.05 && night > 0.5 && chance(0.9)) { // crickets
      const f = 4300 + Math.random() * 500;
      for (let k = 0; k < 5; k++) this.tone(f, 0.03, { vol: 0.012 * meadow * night, when: k * 0.045, attack: 0.004, bus: this.amb });
    }
  }
}
