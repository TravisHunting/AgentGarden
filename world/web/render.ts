// Canvas renderer: chunky procedural pixel art, plus mod-supplied sprites.

import type { CreatureDef, GardenState, Particles, SpeciesDef, WeatherDef } from '../src/game/types.ts';
import type { SpriteDef } from '../src/mods/schema.ts';

export const T = 16; // logical pixels per tile

export interface Content {
  species: SpeciesDef[];
  creatures: CreatureDef[];
  weather: WeatherDef[];
  sprites: Record<string, SpriteDef>;
  sounds: Record<string, unknown>;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  color: string;
  size: number;
  kind: Particles | 'smoke' | 'drop' | 'dirt' | 'spark';
}

type Ctx = CanvasRenderingContext2D;

export class Renderer {
  canvas: HTMLCanvasElement;
  ctx: Ctx;
  state: GardenState | null = null;
  scale = 3;
  hover: { x: number; y: number } | null = null;
  mailFlag = false;
  private species = new Map<string, SpeciesDef>();
  private creatureDefs = new Map<string, CreatureDef>();
  private weather = new Map<string, WeatherDef>();
  private sprites = new Map<string, { def: SpriteDef; frames: HTMLCanvasElement[] }>();
  private avatarPos = { x: 0, y: 0 };
  private creaturePos = new Map<number, { x: number; y: number }>();
  private particles: Particle[] = [];
  private fizzleUntil = 0;
  private lastFrame = performance.now();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
  }

  setContent(c: Content): void {
    this.species = new Map(c.species.map((s) => [s.id, s]));
    this.creatureDefs = new Map(c.creatures.map((s) => [s.id, s]));
    this.weather = new Map(c.weather.map((s) => [s.id, s]));
    this.sprites.clear();
    for (const [id, def] of Object.entries(c.sprites)) this.sprites.set(id, { def, frames: def.frames.map((f) => bakeFrame(def, f)) });
  }

  setState(s: GardenState): void {
    const first = !this.state;
    this.state = s;
    if (first) {
      this.avatarPos = { x: s.avatar.x, y: s.avatar.y };
    }
  }

  speciesDef(id: string): SpeciesDef | undefined {
    return this.species.get(id);
  }

  weatherDef(id: string): WeatherDef | undefined {
    return this.weather.get(id);
  }

  /** Fit the canvas to its container, keeping crisp pixels. */
  resize(availW: number, availH: number, dpr: number): void {
    if (!this.state) return;
    const lw = this.state.width * T;
    const lh = this.state.height * T;
    this.scale = Math.max(1, Math.min(availW / lw, availH / lh));
    const cssW = Math.floor(lw * this.scale);
    const cssH = Math.floor(lh * this.scale);
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.canvas.width = Math.floor(cssW * dpr);
    this.canvas.height = Math.floor(cssH * dpr);
  }

  tileAt(clientX: number, clientY: number): { x: number; y: number } | null {
    if (!this.state) return null;
    const r = this.canvas.getBoundingClientRect();
    const x = Math.floor(((clientX - r.left) / r.width) * this.state.width);
    const y = Math.floor(((clientY - r.top) / r.height) * this.state.height);
    return x >= 0 && y >= 0 && x < this.state.width && y < this.state.height ? { x, y } : null;
  }

  /** Avatar head position in CSS pixels relative to the canvas, for speech bubbles. */
  avatarAnchor(): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    const sx = r.width / ((this.state?.width ?? 1) * T);
    return { x: (this.avatarPos.x * T + T / 2) * sx, y: this.avatarPos.y * T * sx - 2 };
  }

  fizzle(): void {
    this.fizzleUntil = performance.now() + 2500;
    for (let i = 0; i < 10; i++) this.puff('smoke', this.avatarPos.x * T + 8, this.avatarPos.y * T + 6, '#9a9a9a');
  }

  effect(kind: string, x: number, y: number): void {
    const cx = x * T + 8;
    const cy = y * T + 8;
    const n = 8;
    for (let i = 0; i < n; i++) {
      if (kind === 'water') this.puff('drop', cx, cy - 6, '#6ec6ff');
      else if (kind === 'till' || kind === 'cut') this.puff('dirt', cx, cy + 4, kind === 'cut' ? '#7fbf4f' : '#7a5232');
      else if (kind === 'harvest' || kind === 'plant' || kind === 'fertilize') this.puff('spark', cx, cy, kind === 'fertilize' ? '#c9a46a' : '#fff4a3');
    }
  }

  private puff(kind: Particle['kind'], x: number, y: number, color: string): void {
    const spread = kind === 'smoke' ? 0.6 : 1.2;
    this.particles.push({
      x,
      y,
      vx: (Math.random() - 0.5) * 30 * spread,
      vy: kind === 'drop' ? 20 + Math.random() * 20 : -15 - Math.random() * 25,
      life: 0,
      max: 0.5 + Math.random() * 0.6,
      color,
      size: kind === 'smoke' ? 3 : 1,
      kind,
    });
  }

  // ---------------------------------------------------------------- frame

  draw(now: number): void {
    const s = this.state;
    if (!s) return;
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const ctx = this.ctx;
    const k = this.canvas.width / (s.width * T);
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.imageSmoothingEnabled = false;
    const lw = s.width * T;
    const lh = s.height * T;
    const t = now / 1000;

    // Smooth positions toward the latest authoritative state.
    const ease = 1 - Math.exp(-dt * 6);
    this.avatarPos.x += (s.avatar.x - this.avatarPos.x) * ease;
    this.avatarPos.y += (s.avatar.y - this.avatarPos.y) * ease;
    const seen = new Set<number>();
    for (const c of s.creatures) {
      seen.add(c.uid);
      const p = this.creaturePos.get(c.uid) ?? { x: c.x, y: c.y };
      p.x += (c.x - p.x) * ease;
      p.y += (c.y - p.y) * ease;
      this.creaturePos.set(c.uid, p);
    }
    for (const uid of this.creaturePos.keys()) if (!seen.has(uid)) this.creaturePos.delete(uid);

    // Ground
    for (let y = 0; y < s.height; y++) {
      for (let x = 0; x < s.width; x++) {
        const tile = s.tiles[y * s.width + x];
        const px = x * T;
        const py = y * T;
        if (tile.tilled) {
          const wet = tile.moisture / 100;
          ctx.fillStyle = mix('#9b6a3c', '#4a2f1b', wet * 0.8);
          ctx.fillRect(px, py, T, T);
          ctx.fillStyle = mix('#7d5230', '#38220f', wet * 0.8);
          for (let r = 3; r < T; r += 5) ctx.fillRect(px + 1, py + r, T - 2, 1);
        } else {
          ctx.fillStyle = (x + y) % 2 ? '#6aa84f' : '#64a04a';
          ctx.fillRect(px, py, T, T);
          ctx.fillStyle = '#7dbb5c';
          const h = hash2(x, y);
          ctx.fillRect(px + (h % 11) + 2, py + ((h >> 4) % 11) + 2, 1, 2);
          ctx.fillRect(px + ((h >> 8) % 11) + 2, py + ((h >> 12) % 11) + 2, 1, 2);
        }
        if (this.hover && this.hover.x === x && this.hover.y === y) {
          ctx.strokeStyle = 'rgba(255,255,255,0.8)';
          ctx.lineWidth = 1;
          ctx.strokeRect(px + 0.5, py + 0.5, T - 1, T - 1);
        }
      }
    }

    // Mailbox
    this.drawMailbox(ctx, s.mailbox.x * T, s.mailbox.y * T, t);

    // Plants, sorted top-to-bottom so lower rows overlap upper ones
    for (let y = 0; y < s.height; y++) {
      for (let x = 0; x < s.width; x++) {
        const plant = s.tiles[y * s.width + x].plant;
        if (plant) this.drawPlant(ctx, x * T, y * T, plant, t);
      }
    }

    // Creatures
    for (const c of s.creatures) {
      const p = this.creaturePos.get(c.uid)!;
      const def = this.creatureDefs.get(c.def);
      if (def) this.drawCreature(ctx, p.x * T, p.y * T, def, t, c.uid);
    }

    // Avatar
    this.drawAvatar(ctx, this.avatarPos.x * T, this.avatarPos.y * T, t, now < this.fizzleUntil);

    // Weather + light
    const weather = this.weather.get(s.weather.id);
    this.weatherParticles(weather?.particles ?? 'none', lw, lh, dt);
    this.drawParticles(ctx, dt);
    if (weather?.tint) {
      ctx.fillStyle = weather.tint;
      ctx.fillRect(0, 0, lw, lh);
    }
    if (weather?.particles === 'fog') {
      ctx.fillStyle = 'rgba(230,230,240,0.25)';
      ctx.fillRect(0, 0, lw, lh);
    }
    const dark = nightAmount(new Date());
    if (dark > 0) {
      ctx.fillStyle = `rgba(10,15,50,${0.45 * dark})`;
      ctx.fillRect(0, 0, lw, lh);
      this.drawGlows(ctx, t, dark);
    }
  }

  // ---------------------------------------------------------------- pieces

  private drawMailbox(ctx: Ctx, px: number, py: number, t: number): void {
    rect(ctx, px + 7, py + 8, 2, 8, '#6b4a2b');
    rect(ctx, px + 3, py + 3, 10, 6, '#3c6fb4');
    rect(ctx, px + 3, py + 3, 10, 1, '#5d8fd6');
    rect(ctx, px + 4, py + 5, 4, 3, '#1f3d66');
    if (this.mailFlag) {
      const wave = Math.sin(t * 6) > 0 ? 0 : 1;
      rect(ctx, px + 12, py + 0 + wave, 1, 5, '#555');
      rect(ctx, px + 13, py + 0 + wave, 3, 2, '#e5383b');
    } else {
      rect(ctx, px + 12, py + 5, 4, 1, '#e5383b');
    }
  }

  private spriteFrame(id: string | undefined, growth: number | null, t: number): HTMLCanvasElement | null {
    if (!id) return null;
    const sp = this.sprites.get(id);
    if (!sp) return null;
    if (sp.def.mode === 'stages' && growth !== null) return sp.frames[Math.min(sp.frames.length - 1, Math.floor(growth * sp.frames.length))];
    const fps = sp.def.fps ?? 4;
    return sp.frames[fps > 0 ? Math.floor(t * fps) % sp.frames.length : 0];
  }

  private drawPlant(ctx: Ctx, px: number, py: number, plant: GardenState['tiles'][number]['plant'] & {}, t: number): void {
    const def = this.species.get(plant.species);
    const dead = plant.health <= 0;
    const g = plant.growth;
    const scale = plant.mutation?.scale ?? 1;
    ctx.save();
    if (plant.mutation?.hue) ctx.filter = `hue-rotate(${plant.mutation.hue}deg)`;
    if (scale !== 1) {
      ctx.translate(px + T / 2, py + T);
      ctx.scale(scale, scale);
      ctx.translate(-(px + T / 2), -(py + T));
    }
    const sprite = !dead ? this.spriteFrame(def?.sprite, g, t) : null;
    if (sprite) {
      ctx.drawImage(sprite, px + (T - sprite.width) / 2, py + T - sprite.height);
    } else {
      const colors = dead
        ? { stem: '#6b5a3a', leaf: '#8a7550', bloom: '#5c4a30' }
        : def?.colors ?? { stem: '#777', leaf: '#999', bloom: '#bbb' };
      drawProceduralPlant(ctx, px, py, def?.shape ?? 'bush', colors, dead ? Math.max(0.4, g) : g, t, dead);
    }
    ctx.restore();
    if (!dead && g >= 1 && Math.floor(t * 2 + px) % 5 === 0) {
      rect(ctx, px + 2 + ((Math.floor(t * 3) * 5) % 12), py + 1, 1, 1, '#fffbe0');
    }
    if (!dead && plant.health < 40) rect(ctx, px + 13, py + 1, 2, 2, '#e5383b');
  }

  private drawCreature(ctx: Ctx, px: number, py: number, def: CreatureDef, t: number, uid: number): void {
    const bob = Math.round(Math.sin(t * 6 + uid) * 1);
    const sprite = this.spriteFrame(def.sprite, null, t);
    if (sprite) {
      ctx.drawImage(sprite, px + (T - sprite.width) / 2, py + (T - sprite.height) / 2 + bob);
      return;
    }
    const { body, accent } = def.colors;
    const cx = px + 6;
    const cy = py + 8 + bob;
    switch (def.shape) {
      case 'bug':
        rect(ctx, cx, cy, 4, 3, body);
        rect(ctx, cx + 1, cy, 1, 3, accent);
        rect(ctx, cx + 1, cy - 2 + (Math.floor(t * 20) % 2), 2, 2, 'rgba(255,255,255,0.8)');
        break;
      case 'bird':
        rect(ctx, cx, cy, 5, 3, body);
        rect(ctx, cx + 4, cy - 2, 3, 3, body);
        rect(ctx, cx + 6, cy - 1, 2, 1, '#f6c90e');
        rect(ctx, cx + 1, cy + 1, 3, 2, accent);
        rect(ctx, cx + 5, cy - 1, 1, 1, '#111');
        break;
      case 'snail':
        rect(ctx, cx - 2, cy + 3, 8, 2, accent);
        rect(ctx, cx, cy - 1, 5, 4, body);
        rect(ctx, cx + 1, cy, 3, 2, mix(body, '#000', 0.3));
        rect(ctx, cx + 6, cy + 1, 1, 2, accent);
        break;
      case 'ghost':
        ctx.globalAlpha = 0.7 + Math.sin(t * 3) * 0.2;
        rect(ctx, cx - 1, cy - 4, 7, 8, body);
        rect(ctx, cx, cy - 2, 1, 2, accent);
        rect(ctx, cx + 3, cy - 2, 1, 2, accent);
        ctx.globalAlpha = 1;
        break;
      case 'blob':
        rect(ctx, cx - 1, cy, 7, 4, body);
        rect(ctx, cx, cy - 1, 5, 1, body);
        rect(ctx, cx + 1, cy + 1, 1, 1, accent);
        rect(ctx, cx + 3, cy + 1, 1, 1, accent);
        break;
      default:
        rect(ctx, cx - 1, cy, 7, 4, body);
        rect(ctx, cx + 5, cy - 2, 3, 3, body);
        rect(ctx, cx + 6, cy - 1, 1, 1, accent);
        rect(ctx, cx, cy + 4, 1, 1, body);
        rect(ctx, cx + 4, cy + 4, 1, 1, body);
    }
  }

  private drawAvatar(ctx: Ctx, px: number, py: number, t: number, fizzling: boolean): void {
    const s = this.state!;
    const av = s.avatar;
    const mode = fizzling ? 'fizzling' : av.mode;
    const walking = mode === 'walking';
    const working = mode === 'working';
    const shake = mode === 'fizzling' ? Math.round(Math.sin(t * 50)) : 0;
    const bob = walking ? Math.abs(Math.round(Math.sin(t * 12))) : working ? Math.round(Math.sin(t * 8)) : 0;
    ctx.save();
    ctx.translate(Math.round(px + shake), Math.round(py - 3 - bob));
    if (av.facing < 0) {
      ctx.translate(T, 0);
      ctx.scale(-1, 1);
    }
    if (mode === 'fizzling') ctx.filter = 'grayscale(0.8) brightness(0.9)';
    const sprite = this.spriteFrame('avatar', null, t);
    if (sprite) {
      ctx.drawImage(sprite, (T - sprite.width) / 2, T - sprite.height);
    } else {
      const step = walking ? Math.floor(t * 8) % 2 : 0;
      // shadow
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      ctx.fillRect(4, 15 + bob, 8, 1);
      // legs
      rect(ctx, 5, 12, 2, 3 - step, '#3b2f2f');
      rect(ctx, 9, 12, 2, 2 + step, '#3b2f2f');
      // overalls
      rect(ctx, 4, 8, 8, 5, '#3d6fb6');
      rect(ctx, 5, 7, 1, 2, '#3d6fb6');
      rect(ctx, 10, 7, 1, 2, '#3d6fb6');
      rect(ctx, 6, 9, 4, 1, '#f2c94c');
      // arms
      const arm = working ? Math.floor(t * 6) % 2 : 0;
      rect(ctx, 3, 8 + arm, 1, 3, '#f1c27d');
      rect(ctx, 12, 8 - arm, 1, 3, '#f1c27d');
      // head
      rect(ctx, 5, 3, 6, 5, '#f1c27d');
      rect(ctx, 9, 5, 1, 1, '#222');
      rect(ctx, 8, 7, 2, 1, mode === 'fizzling' ? '#222' : '#c46a5a');
      // straw hat
      rect(ctx, 3, 3, 10, 1, '#e9c46a');
      rect(ctx, 5, 1, 6, 2, '#e9c46a');
      rect(ctx, 5, 2, 6, 1, '#d1495b');
      if (working) {
        // a little watering can / trowel in hand
        rect(ctx, 13, 9 - arm, 3, 2, '#9aa5b1');
      }
    }
    ctx.restore();
    // emote + resting z's (not mirrored)
    const ex = Math.round(px + 10);
    const ey = Math.round(py - 8 - bob);
    if (mode === 'resting') {
      ctx.fillStyle = '#ffffff';
      ctx.font = '6px monospace';
      ctx.fillText('z', ex + Math.sin(t * 2) * 1, ey - ((t * 4) % 4));
    }
    if (av.emote) drawEmote(ctx, ex, ey, av.emote, t);
  }

  private weatherParticles(kind: Particles, lw: number, lh: number, dt: number): void {
    const rate: Partial<Record<Particles, number>> = { rain: 90, snow: 20, petals: 6, sparkles: 8, leaves: 4, embers: 10 };
    const r = rate[kind];
    if (!r) return;
    let n = r * dt;
    while (n > 0) {
      if (n < 1 && Math.random() > n) break;
      n -= 1;
      const p: Particle = { x: Math.random() * lw, y: -2, vx: 0, vy: 0, life: 0, max: 6, color: '#fff', size: 1, kind };
      switch (kind) {
        case 'rain':
          Object.assign(p, { vx: -10, vy: 140, color: 'rgba(170,200,255,0.8)', max: 2 });
          break;
        case 'snow':
          Object.assign(p, { vx: 4, vy: 14, color: '#ffffff' });
          break;
        case 'petals':
          Object.assign(p, { vx: 12, vy: 10, color: '#f7a8c4', size: 2 });
          break;
        case 'sparkles':
          Object.assign(p, { y: Math.random() * lh, vx: 0, vy: -3, color: '#fff7a8', max: 1.2 });
          break;
        case 'leaves':
          Object.assign(p, { x: -2, y: Math.random() * lh, vx: 30, vy: 6, color: '#d9a441', size: 2 });
          break;
        case 'embers':
          Object.assign(p, { y: lh + 2, vx: 3, vy: -18, color: '#ff8c42', max: 4 });
          break;
      }
      this.particles.push(p);
    }
  }

  private drawParticles(ctx: Ctx, dt: number): void {
    const s = this.state!;
    const lh = s.height * T;
    this.particles = this.particles.filter((p) => {
      p.life += dt;
      if (p.life > p.max || p.y > lh + 4) return false;
      if (p.kind === 'snow' || p.kind === 'petals' || p.kind === 'leaves') p.vx += Math.sin(p.life * 3 + p.y) * 0.5;
      if (p.kind === 'drop' || p.kind === 'dirt' || p.kind === 'spark') p.vy += 60 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const fade = p.kind === 'sparkles' || p.kind === 'smoke' || p.kind === 'spark' ? 1 - p.life / p.max : 1;
      ctx.globalAlpha = Math.max(0, fade);
      ctx.fillStyle = p.color;
      if (p.kind === 'rain') ctx.fillRect(Math.round(p.x), Math.round(p.y), 1, 3);
      else ctx.fillRect(Math.round(p.x), Math.round(p.y), p.size + (p.kind === 'smoke' ? Math.floor(p.life * 4) : 0), p.size);
      ctx.globalAlpha = 1;
      return true;
    });
    if (this.particles.length > 600) this.particles.splice(0, this.particles.length - 600);
  }

  private drawGlows(ctx: Ctx, t: number, dark: number): void {
    const s = this.state!;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < s.tiles.length; i++) {
      const p = s.tiles[i].plant;
      if (!p || p.health <= 0) continue;
      const def = this.species.get(p.species);
      if (!def?.glow) continue;
      const cx = (i % s.width) * T + 8;
      const cy = Math.floor(i / s.width) * T + 8;
      const r = 6 + p.growth * 6 + Math.sin(t * 2 + i) * 1;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, withAlpha(def.colors.bloom, 0.5 * dark));
      g.addColorStop(1, withAlpha(def.colors.bloom, 0));
      ctx.fillStyle = g;
      ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    }
    ctx.restore();
  }
}

// ---------------------------------------------------------------- helpers

function rect(ctx: Ctx, x: number, y: number, w: number, h: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

function drawProceduralPlant(
  ctx: Ctx,
  px: number,
  py: number,
  shape: SpeciesDef['shape'],
  c: SpeciesDef['colors'],
  g: number,
  t: number,
  dead: boolean,
): void {
  const stage = g < 0.15 ? 0 : g < 0.4 ? 1 : g < 0.7 ? 2 : g < 1 ? 3 : 4;
  const sway = dead ? 0 : Math.round(Math.sin(t * 1.5 + px * 0.3) * 0.6);
  const bx = px + 8;
  const by = py + 14;
  if (stage === 0) {
    rect(ctx, bx - 2, by, 4, 1, '#5b3a1f');
    rect(ctx, bx - 1, by - 1, 2, 1, c.leaf);
    return;
  }
  const leaf = (x: number, y: number, w = 2, h = 1) => rect(ctx, x + sway, y, w, h, c.leaf);
  switch (shape) {
    case 'flower': {
      const h = [0, 4, 7, 10, 11][stage];
      rect(ctx, bx, by - h, 1, h + 1, c.stem);
      if (stage >= 1) leaf(bx - 2, by - 2);
      if (stage >= 2) leaf(bx + 1, by - 5);
      if (stage >= 3) rect(ctx, bx - 1 + sway, by - h - 1, 3, 2, mix(c.bloom, c.leaf, stage === 3 ? 0.6 : 0));
      if (stage === 4) {
        rect(ctx, bx - 2 + sway, by - h - 3, 5, 5, c.bloom);
        rect(ctx, bx - 1 + sway, by - h - 2, 3, 3, mix(c.bloom, '#5a3a1a', 0.6));
      }
      break;
    }
    case 'root': {
      const n = stage + 1;
      for (let i = 0; i < n; i++) rect(ctx, bx - n + i * 2 + sway, by - 2 - stage - (i % 2), 1, 2 + stage + (i % 2), c.leaf);
      if (stage >= 3) rect(ctx, bx - 2, by - 1, 4, 2, c.bloom);
      break;
    }
    case 'vine': {
      const w = 2 + stage * 2;
      const h = 2 + stage * 2;
      rect(ctx, bx - w / 2 + sway, by - h, w, h, c.leaf);
      rect(ctx, bx - w / 2 + 1 + sway, by - h + 1, Math.max(1, w - 3), 1, mix(c.leaf, '#ffffff', 0.2));
      rect(ctx, bx, by - 1, 1, 2, c.stem);
      if (stage >= 3) {
        rect(ctx, bx - 2, by - 3, 2, 2, mix(c.bloom, c.leaf, stage === 3 ? 0.5 : 0));
        if (stage === 4) rect(ctx, bx + 2, by - 6, 2, 2, c.bloom);
      }
      break;
    }
    case 'tree': {
      const h = [0, 3, 6, 9, 10][stage];
      rect(ctx, bx, by - h, 2, h + 1, c.stem);
      const r = 1 + stage;
      rect(ctx, bx - r + 1 + sway, by - h - r, r * 2, r + 1, c.leaf);
      if (stage === 4) {
        rect(ctx, bx - 2 + sway, by - h - 2, 1, 1, c.bloom);
        rect(ctx, bx + 2 + sway, by - h - 3, 1, 1, c.bloom);
        rect(ctx, bx + sway, by - h, 1, 1, c.bloom);
      }
      break;
    }
    case 'grass': {
      for (let i = 0; i < stage + 2; i++) rect(ctx, bx - 4 + i * 2 + (i % 2 ? sway : 0), by - 1 - stage - (i % 3), 1, 2 + stage + (i % 3), c.leaf);
      if (stage === 4) {
        rect(ctx, bx - 3, by - 7, 2, 2, c.bloom);
        rect(ctx, bx + 2, by - 6, 2, 2, c.bloom);
      }
      break;
    }
    case 'mushroom': {
      const h = 1 + stage;
      rect(ctx, bx, by - h, 2, h + 1, mix(c.stem, '#ffffff', 0.6));
      const w = 2 + stage * 2;
      rect(ctx, bx + 1 - w / 2, by - h - 2, w, 2, c.bloom);
      rect(ctx, bx + 2 - w / 2, by - h - 3, Math.max(1, w - 2), 1, c.bloom);
      if (stage >= 3) rect(ctx, bx, by - h - 2, 1, 1, '#ffffff');
      break;
    }
    case 'crystal': {
      const h = 1 + stage * 2;
      rect(ctx, bx - 1, by - h, 3, h + 1, c.bloom);
      rect(ctx, bx, by - h - 1, 1, 1, c.bloom);
      rect(ctx, bx - 1, by - h + 1, 1, h - 1, mix(c.bloom, '#ffffff', 0.5));
      if (stage >= 2) rect(ctx, bx - 4, by - h / 2, 2, h / 2 + 1, c.leaf);
      if (stage >= 3) rect(ctx, bx + 3, by - h / 2 - 1, 2, h / 2 + 2, c.leaf);
      break;
    }
    default: {
      // bush
      const r = 1 + stage;
      rect(ctx, bx - r + sway, by - r * 2 + 1, r * 2, r * 2, c.leaf);
      rect(ctx, bx - r + 1 + sway, by - r * 2 + 1, r * 2 - 2, 1, mix(c.leaf, '#ffffff', 0.25));
      if (stage >= 3) {
        rect(ctx, bx - 1 + sway, by - r * 2, 1, 1, c.bloom);
        rect(ctx, bx + 1 + sway, by - r * 2 + 2, 1, 1, c.bloom);
        if (stage === 4) {
          rect(ctx, bx - r + 1 + sway, by - r, 1, 1, c.bloom);
          rect(ctx, bx + r - 2 + sway, by - r - 1, 1, 1, c.bloom);
        }
      }
    }
  }
}

function drawEmote(ctx: Ctx, x: number, y: number, emote: string, t: number): void {
  const hop = Math.round(Math.abs(Math.sin(t * 5)) * 1);
  const colors: Record<string, string> = {
    happy: '#ffd23f',
    love: '#ff5d8f',
    sad: '#6ec6ff',
    confused: '#ffffff',
    angry: '#ff4d4d',
    surprised: '#ffffff',
    sleepy: '#c8b6ff',
    proud: '#ffd23f',
  };
  const glyphs: Record<string, string[]> = {
    love: ['.X.X.', 'XXXXX', 'XXXXX', '.XXX.', '..X..'],
    happy: ['.....', 'X...X', '.....', 'X...X', '.XXX.'],
    proud: ['..X..', '.XXX.', 'XXXXX', '.XXX.', '.X.X.'],
    sad: ['..X..', '..X..', '.XXX.', '.XXX.', '..X..'],
    confused: ['.XXX.', '...X.', '..X..', '.....', '..X..'],
    surprised: ['..X..', '..X..', '..X..', '.....', '..X..'],
    angry: ['X...X', '.X.X.', '.....', '.X.X.', 'X...X'],
    sleepy: ['XXXX.', '..X..', '.X...', 'XXXX.', '.....'],
  };
  const glyph = glyphs[emote] ?? glyphs.happy;
  rect(ctx, x - 1, y - 1 - hop, 7, 7, 'rgba(0,0,0,0.55)');
  glyph.forEach((row, ry) => [...row].forEach((ch, rx) => ch === 'X' && rect(ctx, x + rx, y + ry - hop, 1, 1, colors[emote] ?? '#fff')));
}

function bakeFrame(def: SpriteDef, rows: string[]): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = def.w;
  c.height = def.h;
  const ctx = c.getContext('2d')!;
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      const col = def.palette[ch];
      if (ch !== '.' && col) {
        ctx.fillStyle = col;
        ctx.fillRect(x, y, 1, 1);
      }
    });
  });
  return c;
}

function hash2(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function mix(a: string, b: string, k: number): string {
  if (!a.startsWith('#') || !b.startsWith('#')) return a;
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  const f = (x: number, y: number) => Math.round(x + (y - x) * k);
  return `rgb(${f(r1, r2)},${f(g1, g2)},${f(b1, b2)})`;
}

function withAlpha(hex: string, a: number): string {
  if (!hex.startsWith('#')) return hex;
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

/** 0 by day, 1 deep at night, with dusk/dawn ramps (player's local clock). */
export function nightAmount(d: Date): number {
  const h = d.getHours() + d.getMinutes() / 60;
  if (h >= 7 && h <= 18) return 0;
  if (h > 18 && h < 20.5) return (h - 18) / 2.5;
  if (h >= 5 && h < 7) return (7 - h) / 2;
  return 1;
}
