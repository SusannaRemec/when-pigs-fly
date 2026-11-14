// All sound is synthesised with WebAudio; there are no audio files.
export class Sfx {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.musicTimer = null;
  }

  init() {
    if (this.ctx) { this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.55;
    this.master.connect(this.ctx.destination);
    const len = this.ctx.sampleRate * 2;
    this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.55;
    return this.muted;
  }

  tone(freq, dur, { type = 'sine', vol = 0.2, when = 0, slide = null, filter = null } = {}) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + when;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = o;
    if (filter) {
      const f = this.ctx.createBiquadFilter();
      f.type = filter.type; f.frequency.value = filter.freq; f.Q.value = filter.q || 1;
      o.connect(f); node = f;
    }
    node.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.05);
  }

  noise(dur, { vol = 0.2, when = 0, type = 'lowpass', from = 800, to = null, q = 1 } = {}) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + when;
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(from, t);
    if (to) f.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(this.master);
    s.start(t, Math.random()); s.stop(t + dur + 0.05);
  }

  oink() {
    const bp = { type: 'bandpass', freq: 900, q: 3 };
    this.tone(190, 0.11, { type: 'sawtooth', vol: 0.3, slide: 120, filter: bp });
    this.tone(230, 0.16, { type: 'sawtooth', vol: 0.3, slide: 110, filter: bp, when: 0.13 });
  }
  flap() { this.noise(0.22, { vol: 0.22, type: 'bandpass', from: 900, to: 180, q: 0.8 }); }
  hop() { this.tone(260, 0.12, { type: 'triangle', vol: 0.12, slide: 420 }); }
  chime() { [784, 988, 1319].forEach((f, i) => this.tone(f, 0.3, { vol: 0.12, when: i * 0.07 })); }
  rustle() { this.noise(0.3, { vol: 0.18, type: 'highpass', from: 2500 }); }
  thud() { this.tone(110, 0.15, { type: 'sine', vol: 0.3, slide: 50 }); }
  moo() {
    this.tone(150, 0.9, { type: 'sawtooth', vol: 0.22, slide: 105, filter: { type: 'lowpass', freq: 500, q: 2 } });
  }
  bark() {
    const f = { type: 'bandpass', freq: 700, q: 2 };
    this.tone(320, 0.09, { type: 'sawtooth', vol: 0.3, slide: 170, filter: f });
    this.tone(300, 0.12, { type: 'sawtooth', vol: 0.3, slide: 150, filter: f, when: 0.16 });
  }
  meow() { this.tone(620, 0.45, { type: 'sawtooth', vol: 0.14, slide: 880, filter: { type: 'bandpass', freq: 1500, q: 4 } }); this.tone(880, 0.3, { type: 'sawtooth', vol: 0.1, slide: 520, when: 0.4, filter: { type: 'bandpass', freq: 1500, q: 4 } }); }
  cluck() { [0, 0.09, 0.2].forEach((w, i) => this.tone(520 + i * 90, 0.06, { type: 'square', vol: 0.12, slide: 380, when: w, filter: { type: 'bandpass', freq: 1800, q: 3 } })); }
  neigh() { this.tone(900, 0.7, { type: 'sawtooth', vol: 0.14, slide: 300, filter: { type: 'bandpass', freq: 1300, q: 3 } }); this.tone(140, 0.25, { type: 'sawtooth', vol: 0.12, slide: 90, when: 0.6 }); }
  creak() { this.tone(90, 1.6, { type: 'sawtooth', vol: 0.16, slide: 150, filter: { type: 'bandpass', freq: 600, q: 6 } }); this.noise(1.4, { vol: 0.08, type: 'bandpass', from: 500, to: 900, q: 5 }); }
  trumpet() { const f = { type: 'bandpass', freq: 900, q: 2 }; this.tone(330, 0.5, { type: 'sawtooth', vol: 0.3, slide: 620, filter: f }); this.tone(620, 0.7, { type: 'sawtooth', vol: 0.28, slide: 380, filter: f, when: 0.45 }); }
  clank() { [1900, 2750, 3300].forEach((f, i) => this.tone(f, 0.25, { type: 'square', vol: 0.07, when: i * 0.012 })); this.noise(0.08, { vol: 0.2, type: 'highpass', from: 3000 }); }
  muffled() { const f = { type: 'lowpass', freq: 380, q: 1 }; this.tone(190, 0.11, { type: 'sawtooth', vol: 0.16, slide: 120, filter: f }); this.tone(230, 0.16, { type: 'sawtooth', vol: 0.16, slide: 110, filter: f, when: 0.13 }); }
  hiss() { this.noise(1.6, { vol: 0.25, type: 'highpass', from: 5000, to: 1200 }); }
  thunder() {
    this.noise(0.12, { vol: 0.6, type: 'highpass', from: 2000 });
    this.noise(1.8, { vol: 0.55, type: 'lowpass', from: 400, to: 60, when: 0.05 });
  }
  feat() { [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.35, { type: 'triangle', vol: 0.2, when: i * 0.11 })); }
  ring(i) { this.tone(440 * Math.pow(2, i / 6), 0.5, { type: 'triangle', vol: 0.2 }); this.tone(880 * Math.pow(2, i / 6), 0.5, { vol: 0.1, when: 0.05 }); }
  win() {
    [523, 659, 784, 1047, 784, 1047, 1319, 1568].forEach((f, i) =>
      this.tone(f, 0.45, { type: 'triangle', vol: 0.22, when: i * 0.14 }));
  }

  startMusic() {
    if (!this.ctx || this.musicTimer) return;
    // A bouncy barnyard loop: pentatonic lead over a two-note bass.
    const scale = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.25];
    const lead = [0, 2, 3, 2, 4, 3, 2, -1, 0, 2, 3, 5, 4, 3, 2, -1, 5, 4, 3, 2, 3, 2, 0, -1, 0, 2, 3, 2, 0, -1, 0, -1];
    const bass = [130.81, 130.81, 196.0, 196.0, 174.61, 174.61, 196.0, 196.0];
    const step = 0.21;
    let i = 0;
    let next = this.ctx.currentTime + 0.1;
    this.musicTimer = setInterval(() => {
      while (next < this.ctx.currentTime + 0.4) {
        const when = next - this.ctx.currentTime;
        const n = lead[i % lead.length];
        if (n >= 0) this.tone(scale[n], 0.18, { type: 'triangle', vol: 0.05, when });
        if (i % 2 === 0) this.tone(bass[(i / 4 | 0) % bass.length] / (i % 4 === 0 ? 1 : 0.5) / 2, 0.16, { type: 'sine', vol: 0.09, when });
        i++; next += step;
      }
    }, 120);
  }
}
