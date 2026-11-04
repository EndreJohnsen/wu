// Terminal plumbing: colors, widths, the live-redrawn region, the WoW cast bar, keys, input box.
import { writeSync } from "node:fs";
import { createInterface } from "node:readline";

// WU_PLAIN=1 (or TERM=dumb) turns off animations, redraws and colors for consoles that garble them
export const TTY = Boolean(process.stdout.isTTY) && process.env.TERM !== "dumb" && !process.env.WU_PLAIN;
export const COLOR = TTY && !process.env.NO_COLOR;
export type RGB = readonly [number, number, number];

export function rgb(r: number, g: number, b: number): string {
  return COLOR ? `\x1b[38;2;${Math.trunc(r)};${Math.trunc(g)};${Math.trunc(b)}m` : "";
}
export function bg(r: number, g: number, b: number): string {
  return COLOR ? `\x1b[48;2;${r};${g};${b}m` : "";
}

export const CLAUDE = rgb(215, 119, 87);
export const SHINE = rgb(255, 196, 168);
export const GREEN = rgb(78, 186, 101);
export const RED = rgb(255, 107, 128);
export const YELLOW = rgb(255, 193, 7);
export const GRAY = rgb(140, 140, 140);
export const WHITE = rgb(235, 235, 235);
export const BOLD = COLOR ? "\x1b[1m" : "";
export const STRIKE = COLOR ? "\x1b[9m" : "";
export const ITALIC = COLOR ? "\x1b[3m" : "";
export const RESET = COLOR ? "\x1b[0m" : "";

// Noctalia palette (periwinkle accent, soft pink, near-black surface) for the update badge
export const NOCT_PRIMARY: RGB = [189, 194, 255];
export const NOCT_TERTIARY: RGB = [231, 185, 213];
export const NOCT_SURFACE: RGB = [19, 19, 24];

// shell-style syntax colors for commands shown on screen
export const SX_PROG = CLAUDE + BOLD; // wu
export const SX_SUB = rgb(240, 240, 240) + BOLD; // search, add, setup ...
export const SX_FLAG = rgb(122, 180, 255); // --check
export const SX_HOLE = rgb(180, 160, 225) + ITALIC; // <addon>, [words]
export const SX_PATH = rgb(152, 200, 121); // ~/.local/state/...
export const SX_GAME = rgb(232, 196, 104); // /reload (in-game slash commands)
export const SX_ARG = rgb(235, 235, 235); // plain arguments
export const SX_KEY = rgb(245, 245, 245) + BOLD; // tab, enter, ↑↓
const SUBCOMMANDS = new Set(["list", "search", "find", "add", "setup", "help", "import", "update"]);

const ANSI_G = /\x1b\[[0-9;?]*[A-Za-z]/g;
const ANSI_Y = /\x1b\[[0-9;?]*[A-Za-z]/y;

export function write(s: string): void {
  try {
    writeSync(1, s);
  } catch (e: any) {
    if (e?.code === "EPIPE") process.exit(0); // e.g. `wu search x | head`
    if (e?.code !== "EAGAIN") throw e;
  }
}
export function println(s = ""): void {
  write((COLOR ? s : plain(s)) + "\n");
}
export const plain = (s: string) => s.replace(ANSI_G, "");
export const dwidth = (s: string) => Bun.stringWidth(s);

/** Truncate to `width` terminal columns, keeping ANSI codes intact (wide glyphs count as 2). */
export function clip(s: string, width: number): string {
  let out = "";
  let seen = 0;
  let i = 0;
  while (i < s.length) {
    ANSI_Y.lastIndex = i;
    const m = ANSI_Y.exec(s);
    if (m) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    const cw = Bun.stringWidth(ch);
    if (seen + cw > width) break;
    out += ch;
    seen += cw;
    i += ch.length;
  }
  return out;
}

/** Pad or truncate (with …) to exactly `w` columns. */
export function dfit(s: string, w: number): string {
  const sw = dwidth(s);
  if (sw <= w) return s + " ".repeat(w - sw);
  let out = "";
  let used = 0;
  for (const ch of s) {
    const cw = Bun.stringWidth(ch);
    if (used + cw > w - 1) break;
    out += ch;
    used += cw;
  }
  return out + "…" + " ".repeat(Math.max(0, w - used - 1));
}

/** Syntax-highlight a command line; `base` is the color to resume afterwards. */
export function hlCmd(cmd: string, base = GRAY): string {
  if (!COLOR) return cmd;
  const out: string[] = [];
  cmd.split(/(\s+)/).forEach((tok, i) => {
    if (!tok || /^\s+$/.test(tok)) return void out.push(tok);
    let style: string;
    if (tok === "wu") style = SX_PROG;
    else if (tok.startsWith("-")) style = SX_FLAG;
    else if ("<[".includes(tok[0]!) && ">]".includes(tok[tok.length - 1]!)) style = SX_HOLE;
    else if (tok.startsWith("/") && !tok.slice(1).includes("/")) style = SX_GAME;
    else if (/^(~|\/|http|[A-Za-z]:[\\/])/.test(tok)) style = SX_PATH;
    else if (SUBCOMMANDS.has(tok) && i <= 2) style = SX_SUB;
    else style = SX_ARG;
    out.push(`${RESET}${style}${tok}`);
  });
  return out.join("") + RESET + base;
}

/** Tiny markup for prose: `code` gets syntax colors, {key} renders as a keycap. */
export function rich(text: string, base = GRAY): string {
  if (!COLOR) return text.replace(/[`{}]/g, "");
  text = text.replace(/`([^`]+)`/g, (_, c: string) => hlCmd(c, base));
  text = text.replace(/\{([^}]+)\}/g, (_, k: string) => `${RESET}${SX_KEY}${k}${RESET}${base}`);
  return base + text + RESET;
}

export function shimmer(text: string, frame: number): string {
  if (!COLOR) return text;
  const chars = [...text];
  const pos = (frame % (chars.length + 12)) - 6;
  return chars.map((ch, i) => (Math.abs(i - pos) <= 1 ? SHINE : CLAUDE) + ch).join("");
}

export function mix(a: RGB, b: RGB, w: number): RGB {
  return [Math.trunc(a[0] + (b[0] - a[0]) * w), Math.trunc(a[1] + (b[1] - a[1]) * w), Math.trunc(a[2] + (b[2] - a[2]) * w)];
}

export function fmtDur(secs: number): string {
  const s = Math.trunc(secs);
  return s < 60 ? `${s}s` : `${Math.trunc(s / 60)}m ${s % 60}s`;
}
export function fmtSize(n: number): string {
  for (const unit of ["B", "KB", "MB", "GB"]) {
    if (n < 1024 || unit === "GB") return unit === "B" || unit === "KB" ? `${n.toFixed(0)} ${unit}` : `${n.toFixed(1)} ${unit}`;
    n /= 1024;
  }
  return `${n}`;
}
export function fmtCount(n: number): string {
  n = Math.trunc(n || 0);
  for (const [div, suffix] of [[1e9, "B"], [1e6, "M"], [1e3, "K"]] as const) {
    if (n >= div) {
      const v = n / div;
      return v < 100 ? `${v.toFixed(1)}${suffix}` : `${v.toFixed(0)}${suffix}`;
    }
  }
  return String(n);
}
export function fmtAgo(stamp?: string): string {
  const then = Date.parse(String(stamp ?? ""));
  if (Number.isNaN(then)) return "?";
  const secs = Math.max(0, (Date.now() - then) / 1000);
  for (const [size, unit] of [[31536000, "y"], [2592000, "mo"], [86400, "d"], [3600, "h"], [60, "m"]] as const) {
    if (secs >= size) return `${Math.trunc(secs / size)}${unit} ago`;
  }
  return "just now";
}
export function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function termCols(): number {
  return Number(process.env.COLUMNS) || process.stdout.columns || 80;
}
export function termRows(): number {
  return Number(process.env.LINES) || process.stdout.rows || 24;
}

// ── live region ──────────────────────────────────────────────────────────────

/** A redrawn region at the bottom of the terminal, with permanent log lines above it. */
export class Live {
  private drawn = 0;
  private render: ((frame: number) => string[]) | null = null;
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  start(render: (frame: number) => string[]): void {
    this.render = render;
    if (!TTY) return;
    write("\x1b[?25l");
    this.draw();
    this.timer ??= setInterval(() => {
      this.frame++;
      this.draw();
    }, 80);
  }

  private clear(): void {
    if (this.drawn) {
      write(`\x1b[${this.drawn}F\x1b[J`);
      this.drawn = 0;
    }
  }

  private draw(): void {
    if (!this.render) return;
    let lines: string[];
    try {
      lines = this.render(this.frame);
    } catch (e) {
      if (process.env.WU_DEBUG) console.error(e);
      return;
    }
    const width = Math.max(20, termCols() - 1);
    const up = this.drawn ? `\x1b[${this.drawn}F` : "";
    write(up + lines.map((l) => clip(l, width) + RESET + "\x1b[K\n").join("") + "\x1b[J");
    this.drawn = lines.length;
  }

  refresh(): void {
    if (TTY) this.draw();
  }

  log(s = ""): void {
    if (TTY) this.clear();
    write((COLOR ? s : plain(s)) + RESET + "\n");
    if (TTY && this.render) this.draw();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (TTY) this.clear();
    this.render = null;
  }
}

export const live = new Live();

export function bullet(status: "ok" | "err" | "warn" | "run", frame = 0): string {
  if (status === "ok") return `${GREEN}●${RESET}`;
  if (status === "err") return `${RED}●${RESET}`;
  if (status === "warn") return `${YELLOW}●${RESET}`;
  return Math.trunc(frame / 5) % 2 === 0 ? `${WHITE}●${RESET}` : " ";
}
export const result = (text: string, color = GRAY) => `  ${GRAY}⎿${RESET}  ${color}${text}${RESET}`;
export const lead = (i: number) => (i === 0 ? `  ${GRAY}⎿${RESET}  ` : "     ");

// ── the loading line: a WoW cast bar ─────────────────────────────────────────
// Every message is a "spell" in its school's color, with a cooldown-sweep icon and a cast bar
// that fill up before the next cast starts.

const SCHOOLS: Record<string, RGB> = {
  holy: [255, 230, 140], fire: [255, 138, 40], frost: [120, 196, 255],
  nature: [118, 222, 92], shadow: [168, 120, 255], arcane: [232, 128, 255],
  fel: [150, 255, 70], gold: [232, 196, 104], physical: [225, 205, 170],
};
const CASTS: [string, string][] = [
  ["Scouring the Barrens", "gold"], ["Fighting demons", "fel"], ["Slaying murlocs", "frost"],
  ["Mrglglglgling", "frost"], ["Bribing goblins", "gold"], ["Haggling at the auction house", "gold"],
  ["Hearthstoning home", "arcane"], ["Conjuring water", "frost"], ["Conjuring food", "arcane"],
  ["Summoning a felhunter", "fel"], ["Banishing a voidwalker", "shadow"], ["Taming a raptor", "nature"],
  ["Skinning boars", "physical"], ["Mining copper veins", "fire"], ["Picking Peacebloom", "nature"],
  ["Fishing in Stranglethorn", "frost"], ["Pulling the whole room", "fire"], ["Wiping on trash", "shadow"],
  ["Running back from the spirit healer", "holy"], ["Waiting for the zeppelin", "gold"],
  ["Waiting for the boat to Menethil", "frost"], ["Riding the gryphon", "physical"],
  ["Asking a guard for directions", "physical"], ["Rolling need on everything", "gold"],
  ["Kiting Hogger", "fire"], ["Selling grey items", "physical"], ["Grinding mobs", "physical"],
  ["Tagging mobs", "physical"], ["Reading quest text (for once)", "holy"], ["Looting corpses", "gold"],
  ["Enchanting bracers", "arcane"], ["Brewing potions", "nature"], ["Dispelling curses", "holy"],
  ["Casting Frostbolt", "frost"], ["Channeling Arcane Missiles", "arcane"], ["Rezzing the healer", "holy"],
  ["Buffing Mark of the Wild", "nature"], ["Clearing the Deadmines", "fire"],
  ["Escorting a very slow NPC", "physical"], ["Searching for Mankrik's wife", "gold"],
  ["Linking [Thunderfury]", "frost"], ["Camping a rare spawn", "shadow"], ["Questing in Westfall", "gold"],
  ["Delving into Blackrock Depths", "fire"], ["Shadowmelding", "shadow"], ["Sapping a patrol", "shadow"],
  ["Dropping a Rain of Fire", "fel"], ["Healing through the pull", "holy"], ["Shapeshifting", "nature"],
];
const SWEEP = "○◔◑◕●"; // an ability icon's cooldown sweep
export const DONE_VERBS = ["Farmed", "Raided", "Grinded", "Quested", "Adventured", "Dungeon-crawled", "Camped the spawn"];
export const IDLE_VERBS = ["Scouted", "Patrolled", "Stood guard", "Checked the mailbox"];

export function shuffle<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
export const choice = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!;

/** WoW-style cast bar: one random "spell" after another, each with its own cast time. */
export class Spinner {
  static WIDTH = 12;
  start = Date.now();
  private casts: [string, RGB, number][];
  private cycle: number;

  /** `fixed`: play these casts in order ([name, school, seconds]) instead of random ones. */
  constructor(fixed?: [string, string, number][]) {
    this.casts = fixed
      ? fixed.map(([name, school, dur]) => [name, SCHOOLS[school] ?? SCHOOLS.gold!, dur])
      : shuffle(CASTS).map(([name, school]) => [name, SCHOOLS[school]!, 2.0 + Math.random() * 1.6]);
    this.cycle = this.casts.reduce((s, c) => s + c[2], 0);
  }

  private current(elapsed: number): [string, RGB, number, number] {
    let t = elapsed % this.cycle;
    for (const [name, color, dur] of this.casts) {
      if (t < dur) return [name, color, dur, t];
      t -= dur;
    }
    const [n, c, d] = this.casts[0]!;
    return [n, c, d, 0];
  }

  line(frame: number, extras: string[] = []): string {
    const elapsed = (Date.now() - this.start) / 1000;
    const [name, color, dur, t] = this.current(elapsed);
    const prog = Math.min(1, t / dur);
    const W = Spinner.WIDTH;
    const icon = SWEEP[Math.round(prog * 4)]!;
    const bits = [fmtDur(elapsed), ...extras, "ctrl+c to cancel"].join(" · ");
    if (!COLOR) {
      const filled = Math.round(prog * W);
      return `${icon} ${name}... [${"=".repeat(filled)}${" ".repeat(W - filled)}] (${bits})`;
    }
    const bright = mix(color, [255, 255, 255], 0.55);
    // spell name shimmers in its school color
    const chars = [...(name + "…")];
    const pos = (frame % (name.length + 14)) - 7;
    const text = chars.map((ch, i) => (Math.abs(i - pos) <= 1 ? rgb(...bright) : rgb(...color)) + ch).join("");
    // cast bar with smooth eighth-block fill; flashes white right as the cast lands
    const cells = prog * W;
    const full = Math.trunc(cells);
    const part = Math.trunc((cells - full) * 8);
    let bar = (prog > 0.94 ? rgb(...bright) : rgb(...color)) + "█".repeat(full);
    if (full < W) bar += (part ? " ▏▎▍▌▋▊▉"[part] : "") + GRAY + "░".repeat(W - full - (part ? 1 : 0));
    const left = `${Math.max(0, dur - t).toFixed(1)}s`.padStart(4);
    return `${rgb(...color)}${icon}${RESET} ${text}${RESET} ${GRAY}▕${RESET}${bar}${RESET}${GRAY}▏${RESET} ${GRAY}${left}  (${bits})${RESET}`;
  }
}

// ── keys + input ─────────────────────────────────────────────────────────────

const SEQ: Record<string, string> = {
  "[A": "up", "[B": "down", "[C": "right", "[D": "left", OA: "up", OB: "down", OC: "right", OD: "left",
  "[Z": "shift-tab", "[H": "home", "[F": "end", "[5~": "pgup", "[6~": "pgdn",
};

export function parseKeys(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === "\x1b") {
      if (s[i + 1] === "[" || s[i + 1] === "O") {
        let j = i + 2;
        while (j < s.length && !/[A-Za-z~]/.test(s[j]!)) j++;
        out.push(SEQ[s.slice(i + 1, j + 1)] ?? "");
        i = j + 1;
      } else {
        out.push("esc");
        i++;
      }
      continue;
    }
    if (ch === "\r" || ch === "\n") out.push("enter");
    else if (ch === "\t") out.push("tab");
    else if (ch === "\x7f" || ch === "\b") out.push("backspace");
    else if (ch === "\x03") out.push("ctrl-c");
    else {
      const c = String.fromCodePoint(s.codePointAt(i)!);
      out.push(c);
      i += c.length;
      continue;
    }
    i++;
  }
  return out.filter(Boolean);
}

let activeKeys: Keys | null = null;

/** Single keypresses from the terminal (raw mode; ctrl+c is handled here). */
export class Keys {
  private queue: string[] = [];
  private waiter: ((k: string) => void) | null = null;
  private onData = (buf: Buffer) => {
    for (const k of parseKeys(buf.toString("utf8"))) {
      if (k === "ctrl-c") return interrupt();
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w(k);
      } else this.queue.push(k);
    }
  };

  start(): this {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", this.onData);
    activeKeys = this;
    return this;
  }

  stop(): void {
    process.stdin.off("data", this.onData);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    if (activeKeys === this) activeKeys = null;
  }

  next(): Promise<string> {
    const k = this.queue.shift();
    if (k !== undefined) return Promise.resolve(k);
    return new Promise((resolve) => (this.waiter = resolve));
  }
}

export function interrupt(): never {
  try {
    activeKeys?.stop();
  } catch {}
  live.stop();
  write(`  ${GRAY}⎿${RESET}  ${RED}Interrupted by user${RESET}\n`);
  if (TTY) write("\x1b[?25h");
  process.exit(130);
}

export function readLine(): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, terminal: false });
    let done = false;
    rl.once("line", (l) => {
      done = true;
      rl.close();
      resolve(l);
    });
    rl.once("close", () => {
      if (!done) resolve("");
    });
  });
}

/** Claude-style rounded input box. Returns what was typed/pasted. */
export async function promptBox(hint = ""): Promise<string> {
  if (!(TTY && process.stdin.isTTY)) {
    write("> ");
    return readLine();
  }
  const cols = termCols();
  const width = Math.max(30, Math.min(cols - 1, 100));
  const inner = width - 2;
  const top = `${GRAY}╭${"─".repeat(inner)}╮${RESET}`;
  const bot = `${GRAY}╰${"─".repeat(inner)}╯${RESET}`;
  const mid = (t = "") => `${GRAY}│${RESET} ${CLAUDE}>${RESET} ${t}${" ".repeat(Math.max(0, inner - 3 - dwidth(t)))}${GRAY}│${RESET}`;
  const below = [bot, ...(hint ? [`  ${GRAY}${hint}${RESET}`] : [])];
  write([top, mid(), ...below].join("\n") + "\n");
  write(`\x1b[${below.length + 1}F\x1b[4C\x1b[?25h`);
  const value = await readLine();
  const used = 1 + Math.floor(Math.max(0, 4 + dwidth(value) - 1) / cols); // rows the typed line took
  const shown = dwidth(value) <= inner - 4 ? value : "…" + value.slice(-(inner - 5));
  write(`\x1b[${used + 1}F\x1b[J` + [top, mid(shown), bot].join("\n") + "\n");
  return value;
}

/** Claude-style numbered menu (❯ 1. …). Returns the chosen index, or -1 on esc/q. */
export async function choose(title: string, options: { label: string; hint?: string }[], start = 0): Promise<number> {
  if (!(TTY && process.stdin.isTTY)) return start;
  let cur = start;
  const render = () => [
    title,
    ...options.map((o, i) => {
      const n = `${i + 1}.`;
      const hint = o.hint ? `  ${GRAY}${o.hint}${RESET}` : "";
      return i === cur ? `  ${CLAUDE}❯ ${n} ${BOLD}${o.label}${RESET}${hint}` : `    ${GRAY}${n}${RESET} ${o.label}${hint}`;
    }),
    "",
    "  " + rich(`{↑↓} move · {1-${options.length}} pick · {enter} confirm · {esc} skip`),
  ];
  live.start(render);
  const keys = new Keys().start();
  let picked = -1;
  try {
    for (;;) {
      const k = await keys.next();
      if (k === "up" || k === "k") cur = (cur - 1 + options.length) % options.length;
      else if (k === "down" || k === "j") cur = (cur + 1) % options.length;
      else if (k === "enter") {
        picked = cur;
        break;
      } else if (k === "esc" || k === "q") break;
      else if (/^[1-9]$/.test(k) && Number(k) <= options.length) {
        picked = Number(k) - 1;
        break;
      }
      live.refresh();
    }
  } finally {
    keys.stop();
    live.stop();
  }
  return picked;
}
