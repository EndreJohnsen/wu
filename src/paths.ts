// Where things live: WoW Forever, config, state, the lock, and finding WoW on disk.
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, sep } from "node:path";
import { BOLD, RED, RESET, bullet, choose, println, result, rich } from "./term";

export const GAME_VERSION = "1.60.1"; // CurseForge's game-version tag for WoW Forever
export const IS_WIN = process.platform === "win32";
export const IS_MAC = process.platform === "darwin";
export const HOME = homedir();
const SEPS = /[\\/]/; // Windows accepts both separators
const PROGRAM_FILES_X86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
export const DEFAULT_WOW_DIR = IS_WIN
  ? join(PROGRAM_FILES_X86, "World of Warcraft", "_forever_")
  : IS_MAC
    ? "/Applications/World of Warcraft/_forever_"
    : join(HOME, "Games/battlenet/drive_c/Program Files (x86)/World of Warcraft/_forever_");
// Windows: %APPDATA%\wu and %LOCALAPPDATA%\wu; elsewhere XDG (~/.config/wu, ~/.local/state/wu)
const CONFIG_BASE = process.env.XDG_CONFIG_HOME || (IS_WIN ? process.env.APPDATA || join(HOME, "AppData", "Roaming") : join(HOME, ".config"));
const STATE_BASE = process.env.XDG_STATE_HOME || (IS_WIN ? process.env.LOCALAPPDATA || join(HOME, "AppData", "Local") : join(HOME, ".local/state"));
export const CONFIG_DIR = join(CONFIG_BASE, "wu");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");
export const STATE_DIR = join(STATE_BASE, "wu");
export const STATE_FILE = join(STATE_DIR, "state.json");

export const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
export const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

export function tilde(p: string): string {
  const [a, h] = IS_WIN ? [p.toLowerCase(), HOME.toLowerCase()] : [p, HOME];
  return a === h || a.startsWith(h + sep) ? "~" + p.slice(HOME.length) : p;
}
export function shortPath(p: string, width = 44): string {
  const s = tilde(p);
  if (s.length <= width) return s;
  const d = s.includes("\\") ? "\\" : "/";
  const parts = s.split(SEPS);
  return parts.slice(0, 3).join(d) + d + "…" + d + parts[parts.length - 1];
}

/** Every drive letter that exists (Windows). */
export const drives = () => (IS_WIN ? "CDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((l) => `${l}:\\`).filter(isDir) : []);

const envDir = () => process.env.WU_DIR || process.env.WOW_U_DIR || "";

export function configuredWowDir(): string {
  if (envDir()) return envDir();
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8")).wow_dir || DEFAULT_WOW_DIR;
  } catch {
    return DEFAULT_WOW_DIR;
  }
}

export let WOW_DIR = configuredWowDir();
export const addonsDir = () => join(WOW_DIR, "Interface", "AddOns");
export function setWowDir(p: string): void {
  WOW_DIR = p;
}

/**
 * Interface/AddOns inside WoW Forever, created if the user says so (a fresh install may not have
 * it). False if it's missing and stays missing. A missing WoW Forever folder is the caller's to report.
 */
export async function ensureAddonsDir(): Promise<boolean> {
  const dir = addonsDir();
  if (isDir(dir)) return true;
  if (!isDir(WOW_DIR)) return false;
  const rel = join("Interface", "AddOns");
  println(`${bullet("warn")} ${BOLD}AddOns${RESET}(${tilde(dir)})`);
  println(result(`There's no ${rel} folder yet, and that's where WoW loads addons from.`));
  println();
  const pick = await choose(`${bullet("ok")} ${BOLD}Create it?${RESET}`, [
    { label: `Create ${rel}`, hint: "an empty folder in WoW Forever, nothing else changes" },
    { label: "Not now", hint: "" },
  ]);
  if (pick !== 0) {
    println(result(`Skipped. wu needs ${rel} before it can install addons.`));
    return false;
  }
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e: any) {
    println(`${bullet("err")} ${BOLD}Create${RESET}(${rel})`);
    println(result(`Couldn't create it: ${e?.code ?? e?.message ?? e}`, RED));
    return false;
  }
  println(`${bullet("ok")} ${BOLD}Created${RESET}(${rel})`);
  println();
  return true;
}

export function writeJsonAtomic(path: string, data: unknown): void {
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, path);
}

export function saveConfig(wowDir: string): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeJsonAtomic(CONFIG_FILE, { wow_dir: wowDir });
}
export const hasConfig = () => existsSync(CONFIG_FILE);
export const envOverride = () => Boolean(envDir());

// ── state ────────────────────────────────────────────────────────────────────

export type Entry = {
  title: string;
  file_id: number | null;
  file_name?: string;
  version: string | null;
  folders: string[];
  updated_at?: string;
  needed_by?: string; // installed because this addon requires it (its title)
};
export type State = { addons: Record<string, Entry> };

export function loadState(): State {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return { ...s, addons: s.addons ?? {} };
  } catch (e: any) {
    if (e?.code === "ENOENT") return { addons: {} };
    throw new Error(`can't read ${tilde(STATE_FILE)}: ${e.message}`);
  }
}

export function saveState(state: State): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeJsonAtomic(STATE_FILE, state);
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
};

let lockHeld = false;
/** One wu at a time: a lock file holding our pid (stale locks from dead processes are taken over). */
export function acquireLock(): void {
  if (lockHeld) return;
  mkdirSync(STATE_DIR, { recursive: true });
  const path = join(STATE_DIR, "lock");
  try {
    const fd = openSync(path, "wx");
    writeSync(fd, String(process.pid));
    closeSync(fd);
  } catch (e: any) {
    if (e?.code !== "EEXIST") throw e;
    const pid = Number(readFileSync(path, "utf8").trim());
    if (pid && pid !== process.pid && alive(pid)) {
      println(`${RED}●${RESET} Another wu is already running.`);
      process.exit(1);
    }
    writeFileSync(path, String(process.pid));
  }
  lockHeld = true;
  process.on("exit", () => {
    try {
      if (readFileSync(path, "utf8").trim() === String(process.pid)) unlinkSync(path);
    } catch {}
  });
}

// ── finding WoW Forever ──────────────────────────────────────────────────────

function glob(pattern: string): string[] {
  if (!/[*?[]/.test(pattern)) return existsSync(join(HOME, pattern)) ? [join(HOME, pattern)] : [];
  try {
    return [...new Bun.Glob(pattern).scanSync({ cwd: HOME, onlyFiles: false, dot: true, absolute: true })].sort();
  } catch {
    return [];
  }
}

export function winePrefixes(): string[] {
  if (IS_WIN) return []; // only Linux/macOS run WoW through Wine
  const pats = ["Games/*", ".wine", ".wine*", ".local/share/wineprefixes/*",
    ".local/share/Steam/steamapps/compatdata/*/pfx", ".steam/steam/steamapps/compatdata/*/pfx",
    ".local/share/bottles/bottles/*", ".var/app/com.usebottles.bottles/data/bottles/bottles/*",
    ".local/share/lutris/prefixes/*", "Games/*/prefix"];
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (p: string, front = false) => {
    let real = p;
    try {
      real = realpathSync(p);
    } catch {}
    if (seen.has(real) || !isDir(join(p, "drive_c"))) return;
    seen.add(real);
    front ? out.unshift(p) : out.push(p);
  };
  for (const pat of pats) for (const p of glob(pat)) add(p);
  const parts = WOW_DIR.split(SEPS); // whatever prefix the current setting lives in
  const i = parts.lastIndexOf("drive_c");
  if (i > 0) add(parts.slice(0, i).join("/"), true);
  return out;
}

/** Where Battle.net and Blizzard say WoW is installed (Windows): product.db, then the registry. */
function windowsWowRoots(): string[] {
  const roots: string[] = [];
  const productDb = join(process.env.ProgramData || "C:\\ProgramData", "Battle.net", "Agent", "product.db");
  try {
    const raw = readFileSync(productDb).toString("latin1");
    for (const m of raw.matchAll(/[A-Za-z]:[\\/][^\x00-\x1f"]*?World of Warcraft(?=[\\/_\x00-\x1f"])/gi)) roots.push(m[0].replace(/\//g, "\\"));
  } catch {}
  for (const key of ["HKLM\\SOFTWARE\\WOW6432Node\\Blizzard Entertainment\\World of Warcraft", "HKLM\\SOFTWARE\\Blizzard Entertainment\\World of Warcraft"]) {
    try {
      const out = Bun.spawnSync(["reg", "query", key, "/v", "InstallPath"], { stdout: "pipe", stderr: "ignore" }).stdout.toString();
      const m = /InstallPath\s+REG_\w+\s+(.+)/i.exec(out);
      if (m) roots.push(dirname(m[1]!.trim().replace(/[\\/]+$/, ""))); // points at _retail_ or _classic_
    } catch {}
  }
  for (const d of drives())
    for (const sub of ["Program Files (x86)", "Program Files", "", "Games", "Battle.net", "Blizzard", "Blizzard Games"])
      roots.push(join(d, sub, "World of Warcraft"));
  return roots;
}

/** Fast check of the usual places: Battle.net's records on Windows, Wine/Proton/Lutris/Bottles elsewhere. */
export function detectForever(): string[] {
  const found: string[] = [];
  const add = (cand: string) => {
    if (isDir(cand) && !found.some((f) => f.toLowerCase() === cand.toLowerCase())) found.push(cand);
  };
  if (IS_WIN) for (const root of windowsWowRoots()) add(join(root, "_forever_"));
  if (IS_MAC) add("/Applications/World of Warcraft/_forever_");
  for (const pfx of winePrefixes())
    for (const pf of ["Program Files (x86)", "Program Files"]) add(join(pfx, "drive_c", pf, "World of Warcraft", "_forever_"));
  return found;
}

// folder names never worth walking into (compared lowercase; "windows" is also Wine's C:\Windows)
const SKIP = new Set(["node_modules", ".git", ".cache", ".npm", ".bun", ".cargo", ".rustup", ".nvm", ".pyenv", ".gradle",
  ".m2", ".mozilla", ".vscode", ".vscode-server", "__pycache__", ".venv", "venv", "site-packages", "trash", ".trash",
  ".thumbnails", "proc", "sys", "dev", "windows", "dosdevices", "shadercache", "snap", "lost+found",
  "$recycle.bin", "system volume information", "appdata", "programdata", "windows.old", "recovery", "perflogs",
  "$winreagent", "msocache", "config.msi"]);

export type ScanProgress = { dirs: number; now: string; found: string[] };

/** Walk the disks for WoW Forever (a `_forever_` folder with Wow.exe, or inside "World of Warcraft"). */
export async function scanDisks(progress: ScanProgress, budgetMs = 20000): Promise<string[]> {
  let user = "";
  try {
    user = userInfo().username;
  } catch {}
  const roots = IS_WIN
    ? drives()
    : [HOME, "/mnt", "/media", `/run/media/${user}`, "/opt", "/games", "/srv", "/Volumes", "/Applications"].filter(isDir);
  const queue: [string, number][] = roots.map((r) => [r, 0]);
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const seen = new Set(progress.found.map(real)); // the quick check may have found some already
  const t0 = performance.now();
  let lastYield = t0;
  while (queue.length && performance.now() - t0 < budgetMs) {
    const [dir, depth] = queue.shift()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    progress.dirs++;
    progress.now = dir;
    for (const e of entries) {
      if (!e.isDirectory()) continue; // symlinks are skipped too, so no loops
      const full = join(dir, e.name);
      if (e.name.toLowerCase() === "_forever_") {
        if ((isFile(join(full, "Wow.exe")) || /world of warcraft$/i.test(dir)) && !seen.has(real(full))) {
          seen.add(real(full));
          progress.found.push(full);
        }
        continue;
      }
      const otherFlavor = /^_.+_$/.test(e.name); // _retail_, _classic_ ... never hold _forever_
      if (!SKIP.has(e.name.toLowerCase()) && !otherFlavor && depth < 12) queue.push([full, depth + 1]);
    }
    if (performance.now() - lastYield > 40) {
      await Bun.sleep(0); // let the cast bar animate
      lastYield = performance.now();
    }
  }
  return progress.found;
}

/** Accepts the _forever_ folder, anything inside it, Wow.exe, or the World of Warcraft folder. */
export function toForeverDir(p: string): [string | null, string | null] {
  if (isFile(p)) p = dirname(p);
  if (!/^([A-Za-z]:)?[\\/]$/.test(p)) p = p.replace(/[\\/]+$/, ""); // keep "/" and "C:\" as they are
  if (!isDir(p)) return [null, `${tilde(p)} doesn't exist.`];
  const parts = p.split(SEPS);
  const i = parts.findIndex((x) => x.toLowerCase() === "_forever_");
  if (i >= 0) return [parts.slice(0, i + 1).join(IS_WIN ? "\\" : "/"), null];
  for (const cand of [join(p, "_forever_"), join(p, "World of Warcraft", "_forever_")]) if (isDir(cand)) return [cand, null];
  if (isFile(join(p, "Wow.exe"))) return [p, null];
  let flavors: string[] = [];
  try {
    flavors = readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory() && /^_.*_$/.test(d.name)).map((d) => d.name).sort();
  } catch {}
  if (flavors.length) return [null, `No _forever_ folder there (found ${flavors.join(", ")}). Is WoW Forever installed?`];
  return [null, `${tilde(p)} doesn't look like a World of Warcraft folder.`];
}

export function resolveWowInput(raw: string): [string | null, string | null] {
  let s = raw.trim().replace(/^['"]|['"]$/g, "").trim();
  if (s.startsWith("file://")) s = decodeURIComponent(s.slice("file://".length)).replace(/^\/(?=[A-Za-z]:)/, "");
  s = s.replace(/%([^%]+)%/g, (all, name: string) => process.env[name] ?? all); // %ProgramFiles(x86)% etc.
  if (IS_WIN) return toForeverDir(s.startsWith("~") ? HOME + s.slice(1) : s); // native Windows path
  s = s.replace(/\\ /g, " ").replace(/\\\(/g, "(").replace(/\\\)/g, ")"); // shell-escaped drag and drop
  const m = /^([A-Za-z]):[\\/]*(.*)$/.exec(s);
  if (m) {
    // a Windows path from inside Wine: try it in every prefix we know
    const rest = m[2]!.replace(/\\/g, "/");
    const letter = m[1]!.toLowerCase();
    let why = `Couldn't find ${s} in any Wine prefix. Paste the Linux path instead.`;
    for (const pfx of winePrefixes()) {
      const drive = letter === "c" ? join(pfx, "drive_c") : join(pfx, "dosdevices", `${letter}:`);
      const [path, err] = toForeverDir(join(drive, rest));
      if (path) return [path, null];
      if (err?.includes("_forever_")) why = err;
    }
    return [null, why];
  }
  return toForeverDir(s.startsWith("~") ? HOME + s.slice(1) : s);
}

/** No WU_DIR, no config, default path missing: use the first WoW Forever the quick check finds. */
export function autodetectWowDir(): void {
  if (envOverride() || hasConfig() || isDir(WOW_DIR)) return;
  const found = detectForever();
  if (found.length) {
    setWowDir(found[0]!);
    println(rich(`Using WoW Forever found at \`${tilde(found[0]!)}\` (run \`wu setup\` to choose another)`));
    println();
  }
}

export function wowRunning(): boolean {
  if (IS_WIN) {
    try {
      const out = Bun.spawnSync(["tasklist", "/FI", "IMAGENAME eq Wow.exe", "/NH"], { stdout: "pipe", stderr: "ignore" }).stdout.toString();
      return /wow\.exe/i.test(out);
    } catch {
      return false;
    }
  }
  if (IS_MAC) {
    try {
      return /World of Warcraft/i.test(Bun.spawnSync(["ps", "-axo", "comm"], { stdout: "pipe" }).stdout.toString());
    } catch {
      return false;
    }
  }
  try {
    for (const pid of readdirSync("/proc")) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        if (readFileSync(`/proc/${pid}/cmdline`).toString("latin1").toLowerCase().includes("wow.exe")) return true;
      } catch {}
    }
  } catch {}
  return false;
}
