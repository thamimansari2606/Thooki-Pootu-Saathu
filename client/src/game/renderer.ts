// Canvas 2D isometric renderer. Draws the shared arena layout with depth sorting, cartoon
// characters, health bars, floating damage numbers and the catcher warning. Pure drawing: it reads
// state and never changes game state.
import { OBSTACLES, ARENA_SIZE, type Rect } from "../../../shared/arena.ts";
import { worldToScreen, TILE_W, TILE_H } from "./iso.ts";
import type { PlayerPose } from "./interpolation.ts";

export type Quality = "low" | "medium" | "high";

export interface Effect {
  kind: "damage" | "swing" | "dodge";
  at: number; // render clock ms
  x: number;
  y: number;
  text?: string;
  color?: string;
  dir?: { x: number; y: number };
}

const PALETTE = ["#4fc3f7", "#81c784", "#ffb74d", "#ba68c8", "#4db6ac", "#f06292"];
const HEIGHTS: Record<Rect["kind"], number> = { house: 3, building: 4.5, wall: 1.4, tree: 2.6, barrel: 1.1, box: 1.2 };
const TOP: Record<Rect["kind"], string> = {
  house: "#ffe0b2", building: "#cfd8dc", wall: "#d7ccc8", tree: "#66bb6a", barrel: "#a1887f", box: "#ffcc80",
};
const SIDE: Record<Rect["kind"], string> = {
  house: "#ffcc80", building: "#90a4ae", wall: "#bcaaa4", tree: "#388e3c", barrel: "#6d4c41", box: "#ffa726",
};

export class ArenaRenderer {
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  private dpr = 1;
  private w = 0;
  private h = 0;
  private quality: Quality = "medium";
  private zoom = 1;
  private groundCache: HTMLCanvasElement | null = null;
  private groundOrigin = { x: 0, y: 0 };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas unavailable");
    this.ctx = ctx;
    this.resize();
  }

  setQuality(q: Quality): void {
    this.quality = q;
    this.dpr = q === "low" ? 1 : Math.min(2, window.devicePixelRatio || 1);
    this.groundCache = null;
    this.resize();
  }

  setZoom(z: number): void {
    this.zoom = Math.max(0.6, Math.min(1.8, z));
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.w = Math.max(1, Math.floor(rect.width));
    this.h = Math.max(1, Math.floor(rect.height));
    this.canvas.width = Math.floor(this.w * this.dpr);
    this.canvas.height = Math.floor(this.h * this.dpr);
  }

  /** Builds the ground once (tiles, plaza, paths) into an offscreen canvas. */
  private buildGround(): HTMLCanvasElement {
    const c = document.createElement("canvas");
    const size = 2400;
    c.width = size;
    c.height = size;
    const g = c.getContext("2d")!;
    const origin = { x: size / 2, y: size / 2 - (ARENA_SIZE * TILE_H) / 2 };
    const toPx = (x: number, y: number) => {
      const s = worldToScreen({ x, y });
      return { x: s.x + origin.x, y: s.y + origin.y };
    };
    for (let i = 0; i < ARENA_SIZE; i++) {
      for (let j = 0; j < ARENA_SIZE; j++) {
        const inPlaza = i > 13 && i < 26 && j > 13 && j < 26;
        const alt = (i + j) % 2 === 0;
        const base = inPlaza ? (alt ? "#fff3c4" : "#ffeaa0") : alt ? "#a5d6a7" : "#95cd98";
        g.fillStyle = base;
        const a = toPx(i, j);
        const b = toPx(i + 1, j);
        const cc = toPx(i + 1, j + 1);
        const d = toPx(i, j + 1);
        g.beginPath();
        g.moveTo(a.x, a.y);
        g.lineTo(b.x, b.y);
        g.lineTo(cc.x, cc.y);
        g.lineTo(d.x, d.y);
        g.closePath();
        g.fill();
      }
    }
    // Edge of the arena.
    g.strokeStyle = "#5d8f63";
    g.lineWidth = 6;
    g.beginPath();
    const corners = [toPx(0, 0), toPx(ARENA_SIZE, 0), toPx(ARENA_SIZE, ARENA_SIZE), toPx(0, ARENA_SIZE)];
    g.moveTo(corners[0].x, corners[0].y);
    corners.slice(1).forEach((p) => g.lineTo(p.x, p.y));
    g.closePath();
    g.stroke();
    this.groundCache = c;
    this.groundOrigin = origin;
    return c;
  }

  private scale(): number {
    return this.zoom * (this.w / 900);
  }

  /** Screen position of a world point for the current camera. */
  toScreen(x: number, y: number, cam: { x: number; y: number }): { x: number; y: number } {
    const s = worldToScreen({ x, y });
    const c = worldToScreen(cam);
    const k = this.scale();
    return { x: this.w / 2 + (s.x - c.x) * k, y: this.h / 2 + (s.y - c.y) * k };
  }

  draw(opts: {
    poses: PlayerPose[];
    camera: { x: number; y: number };
    localId: string | null;
    catcherId: string | null;
    effects: Effect[];
    now: number;
  }): void {
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    const bg = ctx.createLinearGradient(0, 0, 0, this.h);
    bg.addColorStop(0, "#cfeeff");
    bg.addColorStop(1, "#fff6e5");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, this.w, this.h);

    const ground = this.groundCache ?? this.buildGround();
    const k = this.scale();
    const cs = worldToScreen(opts.camera);
    // The cache's top-left pixel is the world point whose iso projection is -groundOrigin.
    const topLeft = {
      x: this.w / 2 + (-this.groundOrigin.x - cs.x) * k,
      y: this.h / 2 + (-this.groundOrigin.y - cs.y) * k,
    };
    ctx.imageSmoothingEnabled = this.quality !== "low";
    ctx.drawImage(ground, topLeft.x, topLeft.y, ground.width * k, ground.height * k);

    // Depth-sorted scene: obstacles and characters together by world (x + y).
    type Item = { depth: number; draw: () => void };
    const items: Item[] = [];
    for (const r of OBSTACLES) {
      items.push({ depth: r.x + r.w / 2 + r.y + r.h / 2, draw: () => this.drawBlock(r, opts.camera) });
    }
    const catcher = opts.poses.find((p) => p.id === opts.catcherId);
    for (const p of opts.poses) {
      const index = Math.max(0, opts.poses.indexOf(p));
      items.push({ depth: p.x + p.y + 0.5, draw: () => this.drawCharacter(p, index, opts) });
    }
    items.sort((a, b) => a.depth - b.depth);
    for (const it of items) it.draw();

    // Effects on top.
    for (const e of opts.effects) this.drawEffect(e, opts.camera, opts.now);

    // Catcher warning for the local player: a red pulse when the catcher is close.
    const me = opts.poses.find((p) => p.id === opts.localId);
    if (me && catcher && catcher.id !== me.id && me.role === "survivor" && !me.knockedOut) {
      const d = Math.hypot(catcher.x - me.x, catcher.y - me.y);
      if (d < 7) {
        const a = Math.max(0, (7 - d) / 7);
        const pulse = 0.5 + 0.5 * Math.sin(opts.now / 120);
        const c = this.toScreen(catcher.x, catcher.y, opts.camera);
        ctx.strokeStyle = `rgba(229,57,53,${(0.3 + 0.5 * pulse) * a})`;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(c.x, c.y, 30 * k + 10 * pulse, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  private drawBlock(r: Rect, cam: { x: number; y: number }) {
    const { ctx } = this;
    const h = HEIGHTS[r.kind] * this.scale() * 14;
    const corners = [
      this.toScreen(r.x, r.y, cam),
      this.toScreen(r.x + r.w, r.y, cam),
      this.toScreen(r.x + r.w, r.y + r.h, cam),
      this.toScreen(r.x, r.y + r.h, cam),
    ];
    if (r.kind === "tree") {
      const c = corners[0];
      const cx = (corners[0].x + corners[2].x) / 2;
      const cy = (corners[0].y + corners[2].y) / 2;
      ctx.fillStyle = "rgba(0,0,0,0.15)";
      ctx.beginPath();
      ctx.ellipse(cx, cy, 14 * this.scale(), 6 * this.scale(), 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#8d6e63";
      ctx.fillRect(cx - 2 * this.scale(), cy - h * 0.5, 4 * this.scale(), h * 0.5);
      ctx.fillStyle = "#43a047";
      ctx.beginPath();
      ctx.arc(cx, cy - h * 0.7, 16 * this.scale(), 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#66bb6a";
      ctx.beginPath();
      ctx.arc(cx - 3 * this.scale(), cy - h * 0.75, 7 * this.scale(), 0, Math.PI * 2);
      ctx.fill();
      void c;
      return;
    }
    const [a, b, cc, d] = corners;
    // Left face and right face (darker), top face (light).
    ctx.fillStyle = SIDE[r.kind];
    ctx.beginPath();
    ctx.moveTo(d.x, d.y);
    ctx.lineTo(cc.x, cc.y);
    ctx.lineTo(cc.x, cc.y - h);
    ctx.lineTo(d.x, d.y - h);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = this.shade(SIDE[r.kind], -18);
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(cc.x, cc.y);
    ctx.lineTo(cc.x, cc.y - h);
    ctx.lineTo(b.x, b.y - h);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = TOP[r.kind];
    ctx.beginPath();
    ctx.moveTo(a.x, a.y - h);
    ctx.lineTo(b.x, b.y - h);
    ctx.lineTo(cc.x, cc.y - h);
    ctx.lineTo(d.x, d.y - h);
    ctx.closePath();
    ctx.fill();
    if (r.kind === "house") {
      // Roof stripe and a door for a cartoon touch.
      ctx.fillStyle = "#e57373";
      ctx.beginPath();
      ctx.moveTo(a.x, a.y - h);
      ctx.lineTo((a.x + cc.x) / 2, (a.y + cc.y) / 2 - h - 14 * this.scale());
      ctx.lineTo(cc.x, cc.y - h);
      ctx.closePath();
      ctx.fill();
    }
  }

  private shade(hex: string, amt: number): string {
    const n = parseInt(hex.slice(1), 16);
    const r = Math.max(0, Math.min(255, (n >> 16) + amt));
    const g = Math.max(0, Math.min(255, ((n >> 8) & 255) + amt));
    const b = Math.max(0, Math.min(255, (n & 255) + amt));
    return `rgb(${r},${g},${b})`;
  }

  private drawCharacter(p: PlayerPose, index: number, opts: { camera: { x: number; y: number }; localId: string | null; now: number }) {
    const { ctx } = this;
    const k = this.scale();
    const s = this.toScreen(p.x, p.y, opts.camera);
    const color = p.role === "catcher" ? "#ef5350" : PALETTE[index % PALETTE.length];

    // Shadow
    if (this.quality !== "low") {
      ctx.fillStyle = "rgba(0,0,0,0.22)";
      ctx.beginPath();
      ctx.ellipse(s.x, s.y + 2 * k, 13 * k, 6 * k, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.save();
    if (p.invulnerable && Math.floor(opts.now / 80) % 2 === 0) ctx.globalAlpha = 0.35;
    if (p.knockedOut) {
      // Lying down with X eyes: cartoon knockout, no gore.
      ctx.translate(s.x, s.y);
      ctx.rotate(Math.PI / 2);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.ellipse(0, -10 * k, 12 * k, 9 * k, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#263238";
      ctx.lineWidth = 2 * k;
      ctx.beginPath();
      ctx.moveTo(-6 * k, -13 * k);
      ctx.lineTo(-2 * k, -9 * k);
      ctx.moveTo(-2 * k, -13 * k);
      ctx.lineTo(-6 * k, -9 * k);
      ctx.stroke();
      ctx.restore();
    } else {
      const bob = p.role === "catcher" || p.dodging ? 0 : Math.sin(opts.now / 160 + index) * 1.2 * k;
      const squash = p.dodging ? 0.7 : 1;
      // Body
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.ellipse(s.x, s.y - 12 * k + bob, 10 * k * (squash > 0.8 ? 1 : 1.15), 11 * k * squash, 0, 0, Math.PI * 2);
      ctx.fill();
      // Head
      ctx.fillStyle = "#ffe0bd";
      ctx.beginPath();
      ctx.arc(s.x, s.y - 26 * k + bob, 8 * k, 0, Math.PI * 2);
      ctx.fill();
      // Eyes follow facing
      const fx = Math.sign(p.facing.x - p.facing.y) || 1;
      ctx.fillStyle = "#263238";
      ctx.beginPath();
      ctx.arc(s.x - 3 * k + fx * 1.2 * k, s.y - 27 * k + bob, 1.3 * k, 0, Math.PI * 2);
      ctx.arc(s.x + 3 * k + fx * 1.2 * k, s.y - 27 * k + bob, 1.3 * k, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#263238";
      ctx.lineWidth = 1.2 * k;
      ctx.beginPath();
      ctx.arc(s.x, s.y - 23.5 * k + bob, 2.5 * k, 0.1, Math.PI - 0.1);
      ctx.stroke();
      // Prop (catcher only)
      if (p.role === "catcher" && p.prop) {
        ctx.strokeStyle = p.prop === "hammer" ? "#616161" : p.prop === "slipper" ? "#8d6e63" : "#a1887f";
        ctx.lineWidth = (p.prop === "hammer" ? 4 : 3) * k;
        ctx.beginPath();
        ctx.moveTo(s.x + 6 * k, s.y - 14 * k + bob);
        ctx.lineTo(s.x + 14 * k, s.y - 26 * k + bob);
        ctx.stroke();
      }
    }
    ctx.restore();

    // Name and health bar
    const label = p.knockedOut ? `${p.name} (out)` : p.name;
    ctx.font = `${Math.max(10, 12 * k)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.strokeStyle = "rgba(38,50,56,0.8)";
    ctx.lineWidth = 3;
    ctx.strokeText(label, s.x, s.y - 44 * k);
    ctx.fillText(label, s.x, s.y - 44 * k);
    if (!p.knockedOut) {
      const bw = 34 * k;
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillRect(s.x - bw / 2, s.y - 52 * k, bw, 5 * k);
      ctx.fillStyle = p.hp > 40 ? "#66bb6a" : p.hp > 20 ? "#ffca28" : "#ef5350";
      ctx.fillRect(s.x - bw / 2, s.y - 52 * k, bw * (p.hp / 100), 5 * k);
    }
  }

  private drawEffect(e: Effect, cam: { x: number; y: number }, now: number) {
    const { ctx } = this;
    const age = now - e.at;
    if (age < 0) return;
    const k = this.scale();
    const s = this.toScreen(e.x, e.y, cam);
    if (e.kind === "damage") {
      const life = 900;
      if (age > life) return;
      const t = age / life;
      ctx.globalAlpha = 1 - t;
      ctx.font = `bold ${Math.round(18 * k)}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.fillStyle = e.color ?? "#ef5350";
      ctx.strokeStyle = "#263238";
      ctx.lineWidth = 3;
      ctx.strokeText(e.text ?? "", s.x, s.y - 60 * k - t * 30 * k);
      ctx.fillText(e.text ?? "", s.x, s.y - 60 * k - t * 30 * k);
      ctx.globalAlpha = 1;
    } else if (e.kind === "swing") {
      const life = 180;
      if (age > life || !e.dir) return;
      const t = age / life;
      const ang = Math.atan2(e.dir.y, e.dir.x) - (1 - t) * 1.2 + 0.6;
      ctx.strokeStyle = `rgba(255,255,255,${0.9 * (1 - t)})`;
      ctx.lineWidth = 5 * k;
      ctx.beginPath();
      ctx.arc(s.x, s.y - 12 * k, 22 * k, ang - 0.7, ang + 0.2);
      ctx.stroke();
    } else if (e.kind === "dodge") {
      const life = 220;
      if (age > life) return;
      ctx.globalAlpha = 0.4 * (1 - age / life);
      ctx.fillStyle = "#e3f2fd";
      ctx.beginPath();
      ctx.ellipse(s.x, s.y - 10 * k, 14 * k, 8 * k, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
}

export { ARENA_SIZE };
