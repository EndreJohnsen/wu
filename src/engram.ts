// The engram: a spinning ASCII dodecahedron with hatched shadow faces, plus the banner + finale.
import { GAME_VERSION, WOW_DIR, shortPath } from "./paths";
import { type RGB, CLAUDE, COLOR, GRAY, RESET, SHINE, TTY, choice, clip, mix, plain, println, rgb, shimmer, termCols, write } from "./term";
import { updateHint, versionLine } from "./version";

const PHI = (1 + Math.sqrt(5)) / 2;
const ROWS = 13;
export const ENGRAM_YAW = 0.3; // resting pose
export const ENGRAM_PITCH = 0.35; // tilted toward you so the top face shows
const SPIN_SECS: [number, number] = [0.7, 0.9]; // each run picks a random length in this range
const ASPECT = 2.05; // terminal cells are about twice as tall as wide
const HATCH = " ..::;;"; // lit faces stay open, shadowed sides get filled in
// while it spins, the fill pattern and colors are rolled at random, then settle back to HATCH + gold
const SPIN_HATCHES = [" ..::;;", " .-=+*#", " .:oO@", " .,~=%", " .*#%@", " -=xX#"];
const SPIN_PALETTES: Record<string, RGB[] | null> = {
  rainbow: null,
  engram: [[163, 53, 238], [255, 200, 60], [80, 140, 255], [90, 200, 110], [235, 235, 235]],
  ember: [[255, 80, 40], [255, 150, 30], [255, 215, 90], [200, 40, 40]],
  arcane: [[130, 90, 255], [60, 170, 255], [195, 110, 255], [80, 230, 220]],
  fel: [[90, 220, 70], [170, 255, 90], [40, 170, 70], [210, 255, 150]],
  frost: [[150, 220, 255], [90, 160, 255], [225, 245, 255], [110, 200, 235]],
};
const GLOW_LIT: RGB = [255, 222, 160]; // pale gold on faces turned to the light
const GLOW_SHADOW: RGB = [238, 150, 62]; // warm amber in shadow: stays bright, never brown

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => {
  const m = Math.sqrt(dot(a, a));
  return [a[0] / m, a[1] / m, a[2] / m];
};

function dodecahedron() {
  const verts: V3[] = [];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) verts.push([x, y, z]);
  for (const s1 of [-1, 1])
    for (const s2 of [-1, 1]) verts.push([0, s1 / PHI, s2 * PHI], [s1 / PHI, s2 * PHI, 0], [s1 * PHI, 0, s2 / PHI]);
  const faces: number[][] = [];
  for (const s1 of [-1, 1])
    for (const s2 of [-1, 1])
      for (const n of [[0, s1 * PHI, s2], [s2, 0, s1 * PHI], [s1 * PHI, s2, 0]] as V3[]) {
        const d = verts.map((v) => dot(v, n));
        const top = Math.max(...d);
        const idx = d.flatMap((x, i) => (Math.abs(x - top) < 1e-9 ? [i] : []));
        const c: V3 = [0, 1, 2].map((k) => idx.reduce((s, i) => s + verts[i]![k]!, 0) / 5) as V3;
        const u = unit(sub(verts[idx[0]!]!, c));
        const w = cross(unit(n), u);
        idx.sort((a, b) => {
          const ang = (i: number) => Math.atan2(dot(sub(verts[i]!, c), w), dot(sub(verts[i]!, c), u));
          return ang(a) - ang(b);
        });
        faces.push(idx);
      }
  const edges = new Map<string, { i: number; j: number; faces: number[] }>();
  faces.forEach((f, fi) => {
    for (let k = 0; k < 5; k++) {
      const [i, j] = [f[k]!, f[(k + 1) % 5]!].sort((a, b) => a - b) as [number, number];
      const key = `${i},${j}`;
      if (!edges.has(key)) edges.set(key, { i, j, faces: [] });
      edges.get(key)!.faces.push(fi);
    }
  });
  return { verts, faces, edges };
}

const D = dodecahedron();
const LIGHT = unit([-0.55, 0.65, 0.75]);

function rotate(p: V3, yaw: number, pitch: number, roll = 0): V3 {
  let [x, y, z] = p;
  let c = Math.cos(yaw);
  let s = Math.sin(yaw);
  [x, z] = [x * c + z * s, -x * s + z * c];
  c = Math.cos(pitch);
  s = Math.sin(pitch);
  [y, z] = [y * c - z * s, y * s + z * c];
  if (roll) {
    c = Math.cos(roll);
    s = Math.sin(roll);
    [x, y] = [x * c - y * s, x * s + y * c];
  }
  return [x, y, z];
}

/** ASCII line in cell space: one glyph per row when steep, one per column (stepping _ - ) when shallow. */
function line(x1: number, y1: number, x2: number, y2: number): [number, number, string][] {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const ang = (((Math.atan2(-dy * ASPECT, dx) * 180) / Math.PI) % 180 + 180) % 180;
  const out: [number, number, string][] = [];
  if (ang >= 44 && ang <= 136) {
    const ch = ang >= 72 && ang <= 108 ? "|" : ang < 90 ? "/" : "\\";
    const [ra, rb] = [y1, y2].sort((a, b) => a - b) as [number, number];
    for (let r = Math.floor(ra); r <= Math.floor(rb); r++) {
      const yc = Math.min(Math.max(r + 0.5, ra), rb);
      const t = dy === 0 ? 0 : (yc - y1) / dy;
      out.push([Math.trunc(x1 + dx * t), r, ch]);
    }
  } else {
    const [ca, cb] = [x1, x2].sort((a, b) => a - b) as [number, number];
    for (let c = Math.floor(ca); c <= Math.floor(cb); c++) {
      const xc = Math.min(Math.max(c + 0.5, ca), cb);
      const t = dx === 0 ? 0 : (xc - x1) / dx;
      const y = y1 + dy * t;
      let r = Math.floor(y);
      const fy = y - r;
      let ch: string;
      if (fy < 0.28) {
        r -= 1;
        ch = "_";
      } else ch = fy < 0.72 ? "-" : "_";
      out.push([c, r, ch]);
    }
  }
  return out;
}

type Cell = [string, "fill" | "edge" | "rim" | null, number, number];

export function engramGrid(yaw: number, pitch: number, roll = 0, hatch = HATCH, rows = ROWS): Cell[][] {
  const sy = (rows - 1.2) / (2 * Math.sqrt(3));
  const sx = sy * ASPECT;
  const cols = Math.trunc(2 * Math.sqrt(3) * sx + 3);
  const cx = cols / 2;
  const cy = rows / 2;
  const pv = D.verts.map((v) => rotate(v, yaw, pitch, roll));
  const proj = pv.map(([x, y]) => [cx + x * sx, cy - y * sy] as [number, number]);
  const grid: Cell[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => [" ", null, 0, -1] as Cell));

  const visible = new Map<number, V3>();
  D.faces.forEach((f, fi) => {
    let n = unit(cross(sub(pv[f[1]!]!, pv[f[0]!]!), sub(pv[f[2]!]!, pv[f[0]!]!)));
    const centroid: V3 = [0, 1, 2].map((k) => f.reduce((s, i) => s + pv[i]![k]!, 0) / 5) as V3;
    if (dot(n, centroid) < 0) n = [-n[0], -n[1], -n[2]];
    if (n[2] > 0.08) visible.set(fi, n); // skip faces seen almost edge-on
  });

  for (const [fi, n] of visible) {
    const poly = D.faces[fi]!.map((i) => proj[i]!);
    const shade = 1 - Math.max(0, dot(n, LIGHT));
    const level = Math.min(hatch.length - 1, Math.trunc(shade * shade * hatch.length * 1.15));
    const xs = poly.map((q) => q[0]);
    const ys = poly.map((q) => q[1]);
    for (let r = Math.max(0, Math.trunc(Math.min(...ys))); r < Math.min(rows, Math.trunc(Math.max(...ys)) + 1); r++) {
      for (let col = Math.max(0, Math.trunc(Math.min(...xs))); col < Math.min(cols, Math.trunc(Math.max(...xs)) + 1); col++) {
        const px = col + 0.5;
        const py = r + 0.5;
        let sign = 0;
        let inside = true;
        for (let k = 0; k < 5; k++) {
          const [x1, y1] = poly[k]!;
          const [x2, y2] = poly[(k + 1) % 5]!;
          const cr = (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1);
          if (Math.abs(cr) < 1e-9) continue;
          if (sign === 0) sign = cr > 0 ? 1 : -1;
          else if (cr > 0 !== sign > 0) {
            inside = false;
            break;
          }
        }
        if (inside) {
          let ch = hatch[level]!;
          if (ch === ";" && (r + col) % 3 === 0) ch = ":";
          grid[r]![col] = [ch, "fill", shade, fi];
        }
      }
    }
  }

  for (const { i, j, faces } of D.edges.values()) {
    const seen = faces.filter((f) => visible.has(f));
    if (!seen.length) continue;
    const kind = seen.length === 1 ? "rim" : "edge";
    for (const [col, r, ch] of line(...proj[i]!, ...proj[j]!)) {
      if (r >= 0 && r < rows && col >= 0 && col < cols) grid[r]![col] = [ch, kind, 0, -1];
    }
  }
  return grid;
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const uniform = (a: number, b: number) => a + Math.random() * (b - a);
const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Resting fill color for the hatching (gold→amber), plus the shade step. */
function glow(shade: number): [RGB, number] {
  const t = Math.round(Math.min(1, Math.max(0, (shade - 0.2) / 0.8)) * 5) / 5;
  return [mix(GLOW_LIT, GLOW_SHADOW, t), t];
}

/** One random spin: direction, turns, tumble, easing, palette, fill pattern. */
class SpinPlan {
  secs = uniform(...SPIN_SECS);
  turns = uniform(0.55, 1.15) * choice([-1, 1]);
  pitch0 = ENGRAM_PITCH + uniform(-0.8, 0.8);
  roll0 = uniform(-1, 1);
  wobble = uniform(0, 0.35);
  wobbleFreq = uniform(1, 3);
  easeKind = choice(["cubic", "quart", "back"] as const);
  palette = SPIN_PALETTES[choice(Object.keys(SPIN_PALETTES))] ?? null;
  hatch = choice(SPIN_HATCHES);
  hue0 = Math.random();
  hueSpeed = uniform(1.5, 4) * choice([-1, 1]);
  faceStep = uniform(0.05, 0.2);

  ease(t: number): number {
    if (this.easeKind === "cubic") return 1 - (1 - t) ** 3;
    if (this.easeKind === "quart") return 1 - (1 - t) ** 4;
    const c1 = 1.70158; // back: overshoots a little, then settles
    return 1 + (c1 + 1) * (t - 1) ** 3 + c1 * (t - 1) ** 2;
  }

  pose(t: number): [number, number, number] {
    const e = this.ease(t);
    const yaw = ENGRAM_YAW - (1 - e) * this.turns * 2 * Math.PI;
    const pitch = ENGRAM_PITCH + (this.pitch0 - ENGRAM_PITCH) * (1 - e) + this.wobble * Math.sin(t * Math.PI * this.wobbleFreq) * (1 - t);
    return [yaw, pitch, this.roll0 * (1 - e)];
  }

  color(face: number, t: number, bright = false): RGB {
    if (!this.palette) {
      const hue = mod(this.hue0 + face * this.faceStep + t * this.hueSpeed * 0.35, 1);
      const h6 = hue * 6;
      const k = h6 - Math.trunc(h6);
      const v = 255;
      const s = bright ? 0.45 : 0.7;
      const p = v * (1 - s);
      const q = v * (1 - s * k);
      const r = v * (1 - s * (1 - k));
      return ([[v, r, p], [q, v, p], [p, v, r], [p, q, v], [r, p, v], [v, p, q]] as RGB[])[Math.trunc(h6) % 6]!;
    }
    const base = this.palette[mod(Math.trunc(face + t * this.hueSpeed * 3 + this.hue0 * 12), this.palette.length)]!;
    return bright ? mix(base, [255, 255, 255], 0.35) : base;
  }
}

/** Colored rows. With a plan, colors/fill come from the random spin and blend home as t -> 1. */
function engramLines(yaw: number, pitch: number, roll = 0, glint: number | null = null, plan: SpinPlan | null = null, t = 1): string[] {
  const home = plan === null ? 1 : smooth(0.45, 0.9, t); // 1 = fully back to gold + orange
  const hatch = plan !== null && home < 0.5 ? plan.hatch : HATCH;
  return engramGrid(yaw, pitch, roll, hatch).map((row, r) => {
    let out = "";
    let cur = "";
    row.forEach(([ch, kind, shade, face], c) => {
      if (ch === " " || !COLOR) return void (out += ch);
      let color: string;
      if (glint !== null && Math.abs(c + r * 2 - glint) <= 1.5) color = "\x1b[38;2;255;240;225m";
      else if (kind === "rim") color = SHINE;
      else if (kind === "edge") color = home >= 1 ? CLAUDE : rgb(...mix(plan!.color((c + r) % 12, t, true), [215, 119, 87], home));
      else {
        const [warm, dark] = glow(shade);
        if (home >= 1) color = rgb(...warm);
        else {
          const lit = 1 - 0.55 * dark;
          const wild = plan!.color(face, t).map((x) => x * lit) as unknown as RGB;
          color = rgb(...mix(wild, warm, home));
        }
      }
      if (color !== cur) {
        out += color;
        cur = color;
      }
      out += ch;
    });
    return out + RESET;
  });
}

/** The spinning-engram banner, with `info` lines to its right. */
export async function banner(nAddons: number, info?: string[]): Promise<void> {
  const lines = info ?? [
    versionLine(),
    `${GRAY}WoW Forever ${GAME_VERSION} · ${nAddons} addons tracked${RESET}`,
    `${GRAY}${shortPath(WOW_DIR)}${RESET}`,
  ];
  const extra = updateHint();
  const all = extra ? [...lines, extra] : lines;
  const compose = (rows: string[], trim = false) => {
    if (trim) {
      while (rows.length && !plain(rows[0]!).trim()) rows = rows.slice(1);
      while (rows.length && !plain(rows[rows.length - 1]!).trim()) rows = rows.slice(0, -1);
    }
    const top = Math.trunc((rows.length - all.length) / 2);
    return rows.map((row, i) => row + "   " + (all[i - top] ?? ""));
  };
  if (!TTY) {
    println(compose(engramLines(ENGRAM_YAW, ENGRAM_PITCH), true).map((r) => plain(r).trimEnd()).join("\n"));
    println();
    return;
  }
  const width = Math.max(20, termCols() - 1);
  let drawn = 0;
  const draw = (rows: string[]) => {
    write((drawn ? `\x1b[${drawn}F` : "") + rows.map((r) => clip(r, width) + RESET + "\x1b[K\n").join("") + "\x1b[J");
    drawn = rows.length;
  };
  write("\x1b[?25l");
  const plan = new SpinPlan();
  const t0 = performance.now();
  for (;;) {
    // random spin, eased into the resting pose, colors coming home
    const t = Math.min(1, (performance.now() - t0) / 1000 / plan.secs);
    const [yaw, pitch, roll] = plan.pose(t);
    draw(compose(engramLines(yaw, pitch, roll, null, plan, t)));
    if (t >= 1) break;
    await Bun.sleep(20);
  }
  for (let g = -4; g < 60; g += 6) {
    // a quick glint as it settles
    draw(compose(engramLines(ENGRAM_YAW, ENGRAM_PITCH, 0, g)));
    await Bun.sleep(8);
  }
  draw(compose(engramLines(ENGRAM_YAW, ENGRAM_PITCH), true));
  println();
}

/** Settle the final ✻ line with one sweep of shimmer; `styled` is the colored resting text. */
export async function finale(text: string, styled?: string): Promise<void> {
  if (TTY && COLOR) {
    const n = [...plain(text)].length;
    for (let f = 0; f < n + 12; f += 3) {
      write(`\r\x1b[K${CLAUDE}✻${RESET} ` + shimmer(text, f) + RESET);
      await Bun.sleep(12);
    }
    write("\r\x1b[K");
  }
  println(`${CLAUDE}✻${RESET} ${styled ?? CLAUDE + text}${RESET}`);
}

