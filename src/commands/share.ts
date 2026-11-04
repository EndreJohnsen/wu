// `wu share` (addon list) and `wu share_wtf` (addons + their settings) as a clipboard code, and
// applying a code with `wu add <code>`. Settings go into the receiver's *own* WTF account folder,
// replacing only the shared variables, with a backup, never while WoW is running.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { finale } from "../engram";
import { WOW_DIR, loadState, saveState, tilde, wowRunning } from "../paths";
import {
  BOLD, CLAUDE, GRAY, GREEN, RED, RESET, TTY, WHITE, YELLOW, Keys, bullet, choose, dfit, fmtSize, lead, live,
  println, result, rich, stamp, termRows, write,
} from "../term";
import { VERSION } from "../version";
import { cmdUpdate } from "./update";

type ShareData = {
  v: 1;
  from: string;
  addons: { id: string; t: string }[];
  wtf?: Record<string, Record<string, string>>; // SavedVariables file stem -> variable -> Lua text
};

const PREFIX = "wu1.";

export const isShareCode = (s: string) => s.trim().startsWith(PREFIX);

function encode(data: ShareData): string {
  return PREFIX + deflateRawSync(Buffer.from(JSON.stringify(data)), { level: 9 }).toString("base64url");
}

function decode(code: string): ShareData {
  const body = code.trim().replace(/\s+/g, "").slice(PREFIX.length);
  const data = JSON.parse(inflateRawSync(Buffer.from(body, "base64url")).toString("utf8"));
  if (data?.v !== 1 || !Array.isArray(data.addons)) throw new Error("not a wu share code");
  return data;
}

// ── clipboard ────────────────────────────────────────────────────────────────

async function tryTools(tools: string[][], input?: string): Promise<{ tool: string; out: string } | null> {
  for (const t of tools) {
    if (!Bun.which(t[0]!)) continue;
    try {
      const p = Bun.spawn(t, { stdin: input !== undefined ? "pipe" : "ignore", stdout: "pipe", stderr: "ignore" });
      if (input !== undefined && p.stdin) {
        p.stdin.write(input);
        await p.stdin.end();
      }
      const out = input === undefined ? await new Response(p.stdout).text() : "";
      if ((await p.exited) === 0) return { tool: t[0]!, out };
    } catch {}
  }
  return null;
}

function clipTools(dir: "copy" | "paste"): string[][] {
  const t: string[][] = [];
  if (process.env.WAYLAND_DISPLAY) t.push(dir === "copy" ? ["wl-copy"] : ["wl-paste", "--no-newline"]);
  if (process.env.DISPLAY)
    t.push(...(dir === "copy" ? [["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]] : [["xclip", "-selection", "clipboard", "-o"], ["xsel", "--clipboard", "--output"]]));
  if (process.platform === "darwin") t.push(dir === "copy" ? ["pbcopy"] : ["pbpaste"]);
  return t;
}

async function copyToClipboard(text: string): Promise<string | null> {
  const r = await tryTools(clipTools("copy"), text);
  if (r) return r.tool;
  if (TTY && text.length < 90000) {
    write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`); // ask the terminal itself (OSC 52)
    return "terminal";
  }
  return null;
}

export async function readClipboard(): Promise<string> {
  return (await tryTools(clipTools("paste")))?.out.trim() ?? "";
}

// ── SavedVariables ───────────────────────────────────────────────────────────

type Chunk = { name: string; text: string };

/** Split a SavedVariables file into its top-level `NAME = ...` assignments (WoW writes one per line start). */
export function splitSV(text: string): Chunk[] {
  const re = /^([A-Za-z_][A-Za-z0-9_]*) = /gm;
  const hits = [...text.matchAll(re)];
  return hits.map((m, i) => ({ name: m[1]!, text: text.slice(m.index!, hits[i + 1]?.index ?? text.length).trimEnd() }));
}
const joinSV = (chunks: Chunk[]) => "\n" + chunks.map((c) => c.text).join("\n") + "\n";

// Words in a variable's name that mean history or game data rather than settings. Names are split
// into words after dropping the addon's own name, so CHATTYNATOR_CONFIG or DialogueUI_DB stay in.
const PRIVATE: [Set<string>, string][] = [
  [new Set(["log", "logs", "history", "histories", "message", "messages", "chat", "chats", "whisper", "whispers", "im", "conversation", "conversations"]), "history or logs"],
  [new Set(["ignore", "ignored", "friend", "friends", "mail", "guild", "roster"]), "people or social data"],
  [new Set(["inventory", "inventories", "bank", "realm", "realms", "character", "characters", "alt", "alts", "gear"]), "character or inventory data"],
  [new Set(["cache", "database", "price", "prices", "scan", "scans", "record", "records", "session", "sessions", "stats", "data", "segments"]), "collected game data"],
  [new Set(["private", "secret", "secrets", "token", "tokens", "account", "accounts", "password"]), "private by name"],
];
const MAX_VAR = 256 * 1024;

export function nameWords(name: string, addon: string): string[] {
  let rest = name;
  if (addon && rest.toLowerCase().startsWith(addon.toLowerCase())) rest = rest.slice(addon.length);
  return rest.split(/_|\d+|(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/).map((w) => w.toLowerCase()).filter(Boolean);
}

export function verdict(name: string, text: string, addon: string): string | null {
  const words = nameWords(name, addon);
  for (const [set, why] of PRIVATE) if (words.some((w) => set.has(w))) return why;
  if (text.length > MAX_VAR) return `too big to be settings (${fmtSize(text.length)})`;
  return null;
}

const wtfAccounts = () => {
  const dir = join(WOW_DIR, "WTF", "Account");
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== "SavedVariables").map((d) => d.name).sort();
  } catch {
    return [];
  }
};
const svDir = (account: string) => join(WOW_DIR, "WTF", "Account", account, "SavedVariables");

async function pickAccount(why: string): Promise<string | null> {
  const accounts = wtfAccounts();
  if (accounts.length <= 1) return accounts[0] ?? null;
  const i = await choose(`${bullet("ok")} ${BOLD}Which WoW account ${why}?${RESET}`, accounts.map((a) => ({ label: a })));
  return i >= 0 ? accounts[i]! : null;
}

// ── wu share / wu share_wtf ──────────────────────────────────────────────────

type Row = { stem: string; addon: string; keep: Chunk[]; left: [string, string][]; accept: boolean };

export async function cmdShare(withSettings: boolean): Promise<number> {
  const state = loadState();
  const addons = Object.entries(state.addons).map(([id, a]) => ({ id, t: a.title }));
  if (!addons.length) {
    println(`${bullet("warn")} ${BOLD}Share${RESET}`);
    println(result(rich("wu isn't tracking anything to share yet. Try `wu import` first.")));
    return 1;
  }
  const data: ShareData = { v: 1, from: VERSION, addons };

  if (withSettings) {
    const account = await pickAccount("should the settings come from");
    if (!account) {
      println(`${bullet("err")} ${BOLD}Share${RESET}(settings)`);
      println(result("No WTF account folder yet. Log into WoW Forever once so it saves your addon settings.", RED));
      return 1;
    }
    const rows: Row[] = [];
    for (const [, a] of Object.entries(state.addons))
      for (const stem of a.folders ?? []) {
        const file = join(svDir(account), `${stem}.lua`);
        if (!existsSync(file)) continue;
        const chunks = splitSV(readFileSync(file, "utf8"));
        const keep: Chunk[] = [];
        const left: [string, string][] = [];
        for (const c of chunks) {
          const why = verdict(c.name, c.text, stem);
          why ? left.push([c.name, why]) : keep.push(c);
        }
        if (keep.length || left.length) rows.push({ stem, addon: a.title, keep, left, accept: keep.length > 0 });
      }
    if (!rows.length) {
      println(`${bullet("warn")} ${BOLD}Share${RESET}(settings)`);
      println(result(`No saved settings for your addons in ${tilde(svDir(account))} yet.`));
      return 1;
    }
    if (TTY && process.stdin.isTTY && !(await reviewSettings(rows, account))) {
      println(`${bullet("ok")} ${BOLD}Share${RESET}(settings)`);
      println(result("Nothing copied."));
      return 0;
    }
    data.wtf = {};
    for (const r of rows) if (r.accept && r.keep.length) data.wtf[r.stem] = Object.fromEntries(r.keep.map((c) => [c.name, c.text]));
  }

  const code = encode(data);
  const tool = await copyToClipboard(code);
  const nSettings = Object.keys(data.wtf ?? {}).length;
  println(`${bullet(tool ? "ok" : "warn")} ${BOLD}Share${RESET}(${addons.length} addons${withSettings ? ` + settings for ${nSettings}` : ""})`);
  if (tool) println(result(`Copied to your clipboard${tool === "terminal" ? " (through the terminal)" : ` (${tool})`} · ${code.length.toLocaleString()} characters`));
  else println(result("Couldn't reach a clipboard tool (wl-copy, xclip, xsel, pbcopy). Copy the code below by hand:", YELLOW));
  println(`     ${GRAY}${tool && code.length > 90 ? code.slice(0, 40) + "…" + code.slice(-20) : code}${RESET}`);
  println();
  println(`  ${rich("Your friend runs `wu add` (it reads the code from their clipboard), or `wu add <code>`.")}`);
  println();
  await finale(withSettings ? "Addons and settings packed · share away" : "Addon list packed · share away");
  return 0;
}

async function reviewSettings(rows: Row[], account: string): Promise<boolean> {
  const ui = { cursor: 0, top: 0 };
  live.start(() => {
    const height = Math.max(5, termRows() - 12);
    if (ui.cursor < ui.top) ui.top = ui.cursor;
    else if (ui.cursor >= ui.top + height) ui.top = ui.cursor - height + 1;
    const out = [`${bullet("ok")} ${BOLD}Share${RESET}(settings from ${account}) ${GRAY}· pick what goes in the code${RESET}`];
    for (let i = ui.top; i < Math.min(rows.length, ui.top + height); i++) {
      const r = rows[i]!;
      const chip = !r.keep.length ? `${GRAY}– none  ${RESET}` : r.accept ? `${GREEN}✓ share ${RESET}` : `${RED}✗ keep  ${RESET}`;
      const size = fmtSize(r.keep.reduce((s, c) => s + c.text.length, 0));
      const ptr = i === ui.cursor ? `${CLAUDE}❯${RESET}` : " ";
      const name = dfit(r.stem, 26);
      out.push(`  ${ptr} ${chip}  ${i === ui.cursor ? BOLD + name + RESET : name} ${GRAY}${r.keep.length} setting${r.keep.length !== 1 ? "s" : ""} · ${size}${r.left.length ? ` · ${r.left.length} kept private` : ""}${RESET}`);
    }
    const r = rows[ui.cursor]!;
    out.push("");
    out.push(`     ${GRAY}shares${RESET}   ${r.keep.map((c) => c.name).join(", ") || "nothing"}`);
    if (r.left.length) out.push(`     ${GRAY}private${RESET}  ${r.left.map(([n, why]) => `${n} ${GRAY}(${why})${RESET}`).join(", ")}`);
    out.push("");
    out.push("  " + rich("{↑↓} move · {y} share · {n} keep · {space} toggle · {enter} copy code · {q} cancel"));
    return out;
  });
  const keys = new Keys().start();
  try {
    for (;;) {
      const k = await keys.next();
      const r = rows[ui.cursor]!;
      if (k === "q" || k === "esc") return false;
      if (k === "enter") return true;
      if (k === "up" || k === "k") ui.cursor = (ui.cursor - 1 + rows.length) % rows.length;
      else if (k === "down" || k === "j") ui.cursor = (ui.cursor + 1) % rows.length;
      else if (k === "y" && r.keep.length) (r.accept = true), (ui.cursor = Math.min(rows.length - 1, ui.cursor + 1));
      else if (k === "n") (r.accept = false), (ui.cursor = Math.min(rows.length - 1, ui.cursor + 1));
      else if (k === " " && r.keep.length) r.accept = !r.accept;
      live.refresh();
    }
  } finally {
    keys.stop();
    live.stop();
  }
}

// ── wu add <code> ────────────────────────────────────────────────────────────

export async function applyShare(code: string, args: string[]): Promise<number> {
  let data: ShareData;
  try {
    data = decode(code);
  } catch {
    println(`${bullet("err")} ${BOLD}Share${RESET}`);
    println(result("That code didn't decode. Was it copied completely?", RED));
    return 1;
  }
  const state = loadState();
  const fresh = data.addons.filter((a) => !state.addons[a.id]);
  const nSettings = Object.keys(data.wtf ?? {}).length;
  println(`${bullet("ok")} ${BOLD}Share${RESET}(from wu v${data.from} · ${data.addons.length} addons${nSettings ? ` · settings for ${nSettings}` : ""})`);
  data.addons.forEach((a, i) => println(`${lead(i)}${state.addons[a.id] ? `${GRAY}✓ ${a.t} (have it)` : `${GREEN}+ ${RESET}${WHITE}${a.t}`}${RESET}`));
  println();

  let doSettings = false;
  const interactive = TTY && process.stdin.isTTY;
  if (interactive) {
    const opts = [
      ...(nSettings ? [{ label: `Install ${fresh.length} new addon${fresh.length !== 1 ? "s" : ""} and apply their settings`, hint: "your settings files are backed up first" }] : []),
      { label: fresh.length ? `Install ${fresh.length} new addon${fresh.length !== 1 ? "s" : ""}${nSettings ? " only" : ""}` : "Nothing new to install, just update", hint: "" },
      { label: "Cancel", hint: "" },
    ];
    const pick = await choose(`${bullet("ok")} ${BOLD}What should wu do?${RESET}`, opts);
    if (pick === -1 || pick === opts.length - 1) {
      println(result("Nothing changed."));
      return 0;
    }
    doSettings = nSettings > 0 && pick === 0;
  } else if (!args.includes("--yes")) {
    println(rich("Run this in a terminal to choose, or add `--yes` to install the addons (settings need a terminal)."));
    return 0;
  }

  for (const a of fresh) state.addons[a.id] = { title: a.t, file_id: null, version: null, folders: [] };
  saveState(state);
  const rc = fresh.length || !doSettings ? await cmdUpdate([]) : 0;
  if (doSettings && data.wtf) return (await applySettings(data.wtf)) || rc;
  return rc;
}

async function applySettings(wtf: Record<string, Record<string, string>>): Promise<number> {
  println();
  if (wowRunning()) {
    println(`${bullet("warn")} ${BOLD}Settings${RESET}`);
    println(result("WoW is running, and it rewrites settings files when you log out. Exit WoW, then run the same `wu add` again.", YELLOW));
    return 1;
  }
  const account = await pickAccount("should get these settings");
  if (!account) {
    println(`${bullet("warn")} ${BOLD}Settings${RESET}`);
    println(result("No WTF account folder yet. Log into WoW Forever once, exit, then run the same `wu add` again.", YELLOW));
    return 1;
  }
  const dir = svDir(account);
  mkdirSync(dir, { recursive: true });
  const when = stamp().replace(/[-:]/g, "").replace(" ", "-"); // local time, e.g. 20261104-1721
  const done: string[] = [];
  for (const [stem, vars] of Object.entries(wtf)) {
    const file = join(dir, `${stem}.lua`);
    const had = existsSync(file);
    const chunks = had ? splitSV(readFileSync(file, "utf8")) : [];
    for (const [name, text] of Object.entries(vars)) {
      const i = chunks.findIndex((c) => c.name === name);
      if (i >= 0) chunks[i] = { name, text };
      else chunks.push({ name, text });
    }
    if (had) copyFileSync(file, `${file}.wu-backup-${when}`);
    writeFileSync(file, joinSV(chunks));
    done.push(`${stem} (${Object.keys(vars).length})`);
  }
  println(`${bullet("ok")} ${BOLD}Settings${RESET}(${done.length} addons → ${account})`);
  done.forEach((d, i) => println(`${lead(i)}${GREEN}✓${RESET} ${d}`));
  println(`     ${GRAY}old files kept as *.wu-backup-${when} in ${tilde(dir)}${RESET}`);
  println();
  await finale("Settings applied · they load the next time you log in");
  return 0;
}

