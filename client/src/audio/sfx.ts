// Procedural cartoon sound effects and music using the Web Audio API. No asset files are needed.
type Settings = { master: number; music: number; sfx: number; muted: boolean };

const SETTINGS_KEY = "tps.audio";
const DEFAULTS: Settings = { master: 0.8, music: 0.4, sfx: 0.8, muted: false };

export class Sfx {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private musicGain!: GainNode;
  private sfxGain!: GainNode;
  private settings: Settings;
  private musicTimer: number | null = null;
  private footTimer = 0;

  constructor() {
    this.settings = Sfx.load();
  }

  static load(): Settings {
    try {
      return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Partial<Settings>) };
    } catch {
      return { ...DEFAULTS };
    }
  }

  get current(): Settings {
    return { ...this.settings };
  }

  update(patch: Partial<Settings>): void {
    this.settings = { ...this.settings, ...patch };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      // ignore storage failures
    }
    this.applyGains();
  }

  /** Must be called from a user gesture (browsers block audio before that). */
  unlock(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as any).webkitAudioContext;
    if (!Ctor) return;
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.musicGain = this.ctx.createGain();
    this.sfxGain = this.ctx.createGain();
    this.musicGain.connect(this.master);
    this.sfxGain.connect(this.master);
    this.master.connect(this.ctx.destination);
    this.applyGains();
  }

  private applyGains() {
    if (!this.ctx) return;
    const s = this.settings;
    const m = s.muted ? 0 : s.master;
    this.master.gain.value = m;
    this.musicGain.gain.value = s.music * 0.35;
    this.sfxGain.gain.value = s.sfx;
  }

  private tone(freq: number, dur: number, type: OscillatorType = "square", vol = 0.25, when = 0, slideTo?: number) {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + when;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.sfxGain);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  private noise(dur: number, vol = 0.2, when = 0, highpass = 800) {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + when;
    const len = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    const hp = this.ctx.createBiquadFilter();
    const g = this.ctx.createGain();
    src.buffer = buf;
    hp.type = "highpass";
    hp.frequency.value = highpass;
    g.gain.value = vol;
    src.connect(hp).connect(g).connect(this.sfxGain);
    src.start(t0);
  }

  diceRoll(): void {
    for (let i = 0; i < 8; i++) this.noise(0.04, 0.25, i * 0.07, 1500);
  }

  diceTick(): void {
    this.tone(880, 0.05, "triangle", 0.15);
  }

  catcherAnnounce(): void {
    [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.22, "triangle", 0.3, i * 0.12));
  }

  swing(): void {
    this.noise(0.12, 0.18, 0, 500);
  }

  hit(): void {
    this.tone(420, 0.12, "square", 0.22, 0, 160);
    this.noise(0.06, 0.12, 0, 1200);
  }

  knockout(): void {
    this.tone(600, 0.6, "sawtooth", 0.2, 0, 90);
    this.tone(300, 0.6, "triangle", 0.15, 0.1, 60);
  }

  dodge(): void {
    this.tone(300, 0.18, "sine", 0.18, 0, 900);
  }

  footstep(): void {
    const now = performance.now();
    if (now - this.footTimer < 260) return;
    this.footTimer = now;
    this.noise(0.05, 0.08, 0, 300);
  }

  victory(): void {
    [523, 659, 784, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.25, "triangle", 0.3, i * 0.13));
  }

  defeat(): void {
    [392, 349, 330, 262].forEach((f, i) => this.tone(f, 0.35, "sawtooth", 0.18, i * 0.25));
  }

  /** Simple looping pentatonic background music. */
  startMusic(): void {
    if (!this.ctx || this.musicTimer !== null) return;
    const notes = [262, 294, 330, 392, 440, 392, 330, 294];
    let i = 0;
    const step = () => {
      if (!this.ctx) return;
      this.tone(notes[i % notes.length] / 2, 0.45, "triangle", 0.18);
      if (i % 2 === 0) this.tone(notes[(i + 2) % notes.length], 0.3, "sine", 0.1);
      i++;
    };
    step();
    this.musicTimer = window.setInterval(step, 420);
  }

  stopMusic(): void {
    if (this.musicTimer !== null) clearInterval(this.musicTimer);
    this.musicTimer = null;
  }
}

export const sfx = new Sfx();
