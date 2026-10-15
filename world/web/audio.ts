// Tiny WebAudio synth. Base sound effects are defined here; mods may add new
// ones or override these by id (see docs/MODDING.md).

import type { SoundDef } from '../src/mods/schema.ts';

const BASE_SOUNDS: Record<string, SoundDef> = {
  water: { wave: 'noise', notes: [{ freq: 1800, dur: 0.25, vol: 0.25 }] },
  till: { wave: 'triangle', notes: [{ freq: 110, dur: 0.08, vol: 0.6 }, { freq: 80, dur: 0.1, vol: 0.5 }], slide: -30 },
  plant: { wave: 'sine', notes: [{ freq: 520, dur: 0.06, vol: 0.5 }, { freq: 780, dur: 0.08, vol: 0.4 }] },
  fertilize: { wave: 'noise', notes: [{ freq: 600, dur: 0.15, vol: 0.2 }] },
  cut: { wave: 'square', notes: [{ freq: 1400, dur: 0.03, vol: 0.2 }, { freq: 900, dur: 0.04, vol: 0.2 }] },
  harvest: { wave: 'triangle', notes: [{ freq: 523, dur: 0.07 }, { freq: 659, dur: 0.07 }, { freq: 784, dur: 0.12 }] },
  fizzle: { wave: 'sawtooth', notes: [{ freq: 600, dur: 0.18, vol: 0.25 }, { freq: 300, dur: 0.3, vol: 0.2 }], slide: -250 },
  chime: { wave: 'sine', notes: [{ freq: 1046, dur: 0.12, vol: 0.4 }, { freq: 1318, dur: 0.25, vol: 0.3 }] },
  rain: { wave: 'noise', notes: [{ freq: 900, dur: 1.2, vol: 0.08 }] },
};

export class Synth {
  private ctx: AudioContext | null = null;
  private sounds: Record<string, SoundDef> = { ...BASE_SOUNDS };
  private lastPlayed = new Map<string, number>();
  muted: boolean;

  constructor() {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem('garden.muted');
    } catch {
      // storage unavailable
    }
    this.muted = stored === null ? false : stored === '1';
  }

  setModSounds(mod: Record<string, SoundDef>): void {
    this.sounds = { ...BASE_SOUNDS, ...mod };
  }

  setMuted(m: boolean): void {
    this.muted = m;
    try {
      localStorage.setItem('garden.muted', m ? '1' : '0');
    } catch {
      // storage unavailable
    }
  }

  /** Must be called from a user gesture at least once (autoplay policy). */
  unlock(): void {
    this.ctx ??= new AudioContext();
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  play(id: string): void {
    if (this.muted || !this.ctx || this.ctx.state !== 'running') return;
    const def = this.sounds[id];
    if (!def) return;
    const now = performance.now();
    if (now - (this.lastPlayed.get(id) ?? 0) < 120) return; // don't machine-gun
    this.lastPlayed.set(id, now);
    const ctx = this.ctx;
    let t = ctx.currentTime + 0.01;
    const master = ctx.createGain();
    master.gain.value = 0.35;
    master.connect(ctx.destination);
    for (const note of def.notes) {
      const gain = ctx.createGain();
      const vol = note.vol ?? 0.5;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(vol, t + Math.min(0.01, note.dur / 4));
      gain.gain.exponentialRampToValueAtTime(0.0001, t + note.dur);
      gain.connect(master);
      if (def.wave === 'noise') {
        const len = Math.ceil(ctx.sampleRate * note.dur);
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = note.freq;
        src.connect(filter).connect(gain);
        src.start(t);
        src.stop(t + note.dur);
      } else {
        const osc = ctx.createOscillator();
        osc.type = def.wave;
        osc.frequency.setValueAtTime(note.freq, t);
        if (def.slide) osc.frequency.linearRampToValueAtTime(Math.max(20, note.freq + def.slide), t + note.dur);
        osc.connect(gain);
        osc.start(t);
        osc.stop(t + note.dur + 0.02);
      }
      t += note.dur;
    }
  }
}
