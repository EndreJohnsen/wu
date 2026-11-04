// Soulstones: a backup cast right before wu changes addons. Old addon folders are *moved* in (instant),
// the WTF folder is copied with reflinks where the filesystem allows (btrfs/xfs: near free), plus
// wu's own state. `wu restore` resurrects from one.
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renameSync, rmTree } from "./install";
import { STATE_FILE, WOW_DIR, isDir, writeJsonAtomic } from "./paths";
import { BOLD, RESET, Spinner, bullet, live } from "./term";

export type StoneAddon = { pid: string; title: string; from: string; to: string; folders: string[] };
export type Manifest = { created: string; reason: string; addons: StoneAddon[]; wtfBytes: number };
export type Stone = { dir: string; manifest: Manifest };

const KEEP = 5;
export const stonesDir = () => join(WOW_DIR, "Interface", ".wu", "soulstones");

/** Copy a tree, reflinking files when the filesystem can (falls back to a normal copy). Returns bytes. */
export function copyTree(src: string, dst: string, skip: (name: string) => boolean = () => false): number {
  const st = lstatSync(src);
  if (st.isSymbolicLink()) return 0;
  if (st.isDirectory()) {
    mkdirSync(dst, { recursive: true });
    let n = 0;
    for (const name of readdirSync(src)) if (!skip(name)) n += copyTree(join(src, name), join(dst, name), skip);
    return n;
  }
  copyFileSync(src, dst, constants.COPYFILE_FICLONE);
  return st.size;
}

function stampId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function listStones(): Stone[] {
  try {
    return readdirSync(stonesDir())
      .filter((n) => /^\d{8}-\d{6}/.test(n))
      .sort()
      .reverse()
      .flatMap((n) => {
        try {
          const dir = join(stonesDir(), n);
          return [{ dir, manifest: JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest }];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function prune(protect?: string): void {
  for (const s of listStones().slice(KEEP)) if (s.dir !== protect) rmTree(s.dir);
}

/** Show a short cast while `work` runs (at least `minMs`, so you can see it land). */
export async function withCast<T>(title: string, casts: [string, string, number][], minMs: number, work: () => T | Promise<T>): Promise<T> {
  const spin = new Spinner(casts);
  live.start((f) => [`${bullet("run", f)} ${BOLD}${title}${RESET}`, "", spin.line(f)]);
  const t0 = Date.now();
  try {
    const out = await work();
    const left = minMs - (Date.now() - t0);
    if (left > 0) await Bun.sleep(left);
    return out;
  } finally {
    live.stop();
  }
}

/** Cast a soulstone: WTF + wu state now; old addon folders get moved in as they're replaced. */
export async function castSoulstone(reason: string, addons: StoneAddon[], protect?: string): Promise<Stone> {
  return withCast("Soulstone(backing up first)", [["Casting Soulstone", "shadow", 0.22], ["Applying Soulstone", "fel", 0.22]], 450, () => {
    const dir = join(stonesDir(), stampId());
    mkdirSync(join(dir, "AddOns"), { recursive: true });
    const wtf = join(WOW_DIR, "WTF");
    const wtfBytes = isDir(wtf) ? copyTree(wtf, join(dir, "WTF"), (n) => n.endsWith(".bak")) : 0;
    if (existsSync(STATE_FILE)) copyFileSync(STATE_FILE, join(dir, "state.json"), constants.COPYFILE_FICLONE);
    const manifest: Manifest = { created: new Date().toISOString(), reason, addons, wtfBytes };
    writeJsonAtomic(join(dir, "manifest.json"), manifest);
    prune(protect);
    return { dir, manifest };
  });
}

/** Record which addons actually changed; a stone where nothing changed is dropped. */
export function sealSoulstone(stone: Stone, changed: StoneAddon[]): boolean {
  if (!changed.length) {
    rmTree(stone.dir);
    return false;
  }
  stone.manifest.addons = changed;
  writeJsonAtomic(join(stone.dir, "manifest.json"), stone.manifest);
  return true;
}

/** Move whatever is in `backup` (old addon folders) into the stone. Same filesystem, so instant. */
export function keepInStone(stone: Stone, backup: string): void {
  for (const name of readdirSync(backup)) {
    const dst = join(stone.dir, "AddOns", name);
    if (!existsSync(dst)) renameSync(join(backup, name), dst);
  }
}

export function stoneSummary(m: Manifest): string {
  const names = m.addons.map((a) => a.title);
  const what = names.length <= 2 ? names.join(" + ") : `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
  return `${m.reason} · ${what}`;
}

