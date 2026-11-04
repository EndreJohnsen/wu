// wu's own version: the update check, the Noctalia "UPDATE AVAILABLE" badge, the boot prompt,
// and `wu update` (self-update through bun).
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import pkg from "../package.json";
import { STATE_DIR, tilde, writeJsonAtomic } from "./paths";
import {
  BOLD, COLOR, GRAY, GREEN, NOCT_PRIMARY, NOCT_SURFACE, NOCT_TERTIARY, RED, RESET, Spinner, TTY, bg, bullet, choose,
  hlCmd, live, println, result, rgb, rich,
} from "./term";

export const VERSION: string = pkg.version;
export const PKG_NAME: string = pkg.name;
export const REPO: string = /github\.com[/:]([^/]+\/[^/.]+)/.exec(pkg.repository?.url ?? "")?.[1] ?? "EndreJohnsen/wu";
export const UA = `wu/${VERSION} (WoW Forever addon manager)`;

const CHECK_FILE = join(STATE_DIR, "selfcheck.json");
const CHECK_EVERY_MS = 60 * 60 * 1000;
type Check = { checked: number; latest: string | null; skip?: string | null };

let latest: string | null = null;
let skipped: string | null = null;

/** a > b, comparing dotted numbers (1.10.0 > 1.9.3). */
export function newer(a: string, b: string): boolean {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

function readCheck(): Check {
  try {
    return JSON.parse(readFileSync(CHECK_FILE, "utf8"));
  } catch {
    return { checked: 0, latest: null };
  }
}

/** Newest released version: the highest vX.Y.Z tag (tags are what `wu update` installs). */
async function remoteVersion(timeoutMs: number): Promise<string | null> {
  const headers = { "User-Agent": UA, Accept: "application/vnd.github+json" };
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/tags?per_page=50`, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) {
      const tags = ((await res.json()) as { name?: string }[]).map((t) => String(t.name ?? ""));
      const versions = tags.filter((n) => /^v\d+(\.\d+)*$/.test(n)).map((n) => n.slice(1));
      if (versions.length) return versions.reduce((a, b) => (newer(b, a) ? b : a));
    }
  } catch {}
  // fallback (e.g. API rate limit): package.json on main, which the raw CDN caches for a few minutes
  const res = await fetch(`https://raw.githubusercontent.com/${REPO}/main/package.json`, {
    headers: { "User-Agent": UA, "Cache-Control": "no-cache" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return null;
  return String(((await res.json()) as { version?: string }).version ?? "") || null;
}

/** Is a newer wu on GitHub? Cached for an hour; a slow or offline network never holds wu up long. */
export async function checkForUpdate(force = false, timeoutMs = 1500): Promise<string | null> {
  if (process.env.WU_NO_UPDATE_CHECK) return null;
  let c = readCheck();
  if (force || Date.now() - c.checked > CHECK_EVERY_MS) {
    try {
      const v = await remoteVersion(timeoutMs);
      if (v) {
        c = { ...c, checked: Date.now(), latest: v };
        mkdirSync(STATE_DIR, { recursive: true });
        writeJsonAtomic(CHECK_FILE, c);
      }
    } catch {}
  }
  skipped = c.skip ?? null;
  latest = c.latest && newer(c.latest, VERSION) ? c.latest : null;
  return latest;
}

export const updateAvailable = () => latest;

function pill(text: string): string {
  if (!COLOR) return `(${text.trim()})`;
  return `${bg(...NOCT_PRIMARY)}${rgb(...NOCT_SURFACE)}${BOLD}${text}${RESET}`;
}

/** "wu v1.0.0", with the Noctalia badge in front of the version when an update is out. */
export function versionLine(): string {
  const badge = latest ? pill(" UPDATE AVAILABLE ") + " " : "";
  return `${BOLD}wu${RESET} ${badge}${GRAY}v${VERSION}${RESET}`;
}

/** Extra banner line pointing at `wu update`. */
export function updateHint(): string {
  if (!latest) return "";
  const pink = rgb(...NOCT_TERTIARY);
  return `${pink}v${latest} is out → ${RESET}${hlCmd("wu update", pink)}${RESET}`;
}

/** On boot: if a newer wu is out, offer to update first. Returns an exit code if it re-ran wu. */
export async function bootPrompt(argv: string[]): Promise<number | null> {
  if (!latest || skipped === latest || !(TTY && process.stdin.isTTY) || process.env.WU_NO_UPDATE_PROMPT) return null;
  const title = `${pill(" UPDATE AVAILABLE ")} ${BOLD}wu v${latest}${RESET} ${GRAY}is out (you have v${VERSION})${RESET}`;
  const pick = await choose(title, [
    { label: "Update now", hint: "then carry on with what you ran" },
    { label: "Not now", hint: "ask again next time" },
    { label: `Skip v${latest}`, hint: "don't ask until the next release" },
  ]);
  if (pick === 2) {
    writeJsonAtomic(CHECK_FILE, { ...readCheck(), skip: latest });
    println(`${GRAY}Skipping v${latest}. ${RESET}` + rich("Run `wu update` whenever you want it."));
    println();
    return null;
  }
  if (pick !== 0) {
    println(`${GRAY}Later then. ${RESET}` + rich("Run `wu update` whenever you want it."));
    println();
    return null;
  }
  if (!(await selfUpdate(latest))) return null;
  println();
  const wu = Bun.which("wu") ?? process.argv[1]!;
  const child = Bun.spawnSync([wu, ...argv], {
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env, WU_NO_UPDATE_PROMPT: "1" },
  });
  return child.exitCode ?? 0;
}

async function run(cmd: string[]): Promise<{ ok: boolean; out: string }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { ok: (await p.exited) === 0, out: (out + err).trim() };
}

/** Where bun keeps global installs, if this wu is one of them. */
function bunGlobal(): { pkgRoot: string; globalDir: string } | null {
  const pkgRoot = resolve(dirname(realpathSync(import.meta.path)), "..");
  const nm = `${sep}node_modules${sep}`;
  if (!pkgRoot.includes(nm)) return null;
  const globalDir = pkgRoot.slice(0, pkgRoot.lastIndexOf(nm));
  return existsSync(join(globalDir, "package.json")) ? { pkgRoot, globalDir } : null;
}

/**
 * Bun pins a GitHub install to the commit it first saw, and `bun remove -g` leaves that lockfile
 * entry behind (bun 1.4), so a plain re-add keeps the old copy. Clear our traces, then add the tag.
 */
function scrubBunGlobal(globalDir: string): void {
  const lock = join(globalDir, "bun.lock");
  if (existsSync(lock)) {
    const lines = readFileSync(lock, "utf8").split("\n");
    writeFileSync(lock, lines.filter((l) => !l.includes(`"${PKG_NAME}`)).join("\n"));
  }
  const manifest = join(globalDir, "package.json");
  try {
    const m = JSON.parse(readFileSync(manifest, "utf8"));
    for (const k of Object.keys(m.dependencies ?? {})) if (k === PKG_NAME || k.includes(REPO)) delete m.dependencies[k];
    writeFileSync(manifest, JSON.stringify(m, null, 2) + "\n");
  } catch {}
  rmSync(join(globalDir, "node_modules", ...PKG_NAME.split("/")), { recursive: true, force: true });
}

/** `wu update`: install the newest wu from GitHub through bun. Puts the old one back on failure. */
export async function selfUpdate(target?: string | null): Promise<boolean> {
  target ??= await checkForUpdate(true, 8000);
  if (!target) {
    println(`${bullet("ok")} ${BOLD}wu v${VERSION}${RESET} ${GRAY}is the newest version.${RESET}`);
    return false;
  }
  const where = bunGlobal();
  if (!where) {
    println(`${bullet("warn")} ${BOLD}Update${RESET}(wu v${VERSION} → v${target})`);
    println(result(rich(`This wu runs from \`${tilde(resolve(dirname(import.meta.path), ".."))}\`, not a bun install. Use \`git pull\` there.`)));
    return false;
  }
  const bun = process.execPath;
  const backup = mkdtempSync(join(tmpdir(), "wu-backup-"));
  cpSync(where.pkgRoot, backup, { recursive: true });
  const binDir = (await run([bun, "pm", "bin", "-g"])).out.split("\n").pop() || join(dirname(dirname(where.globalDir)), "bin");

  const spin = new Spinner();
  const step = { text: "removing the old version" };
  live.start((f) => [`${bullet("run", f)} ${BOLD}Update${RESET}(wu v${VERSION} → v${target})`, result(step.text), "", spin.line(f)]);
  let ok = false;
  let why = "";
  try {
    await run([bun, "remove", "-g", PKG_NAME]);
    scrubBunGlobal(where.globalDir);
    step.text = `installing v${target} from github.com/${REPO}`;
    let r = await run([bun, "add", "-g", `github:${REPO}#v${target}`]);
    if (!r.ok) r = await run([bun, "add", "-g", `github:${REPO}`]); // no tag for it? take main
    const got = (() => {
      try {
        return JSON.parse(readFileSync(join(where.pkgRoot, "package.json"), "utf8")).version as string;
      } catch {
        return null;
      }
    })();
    ok = r.ok && got !== null && !newer(target, got);
    why = ok ? "" : r.ok ? `bun installed v${got ?? "?"} instead` : r.out.split("\n").slice(-2).join(" ");
  } catch (e: any) {
    why = e?.message ?? String(e);
  } finally {
    live.stop();
  }
  if (ok) {
    rmSync(backup, { recursive: true, force: true });
    println(`${bullet("ok")} ${BOLD}Update${RESET}(wu v${VERSION} → v${target})`);
    println(result(`${GREEN}Done.${RESET}${GRAY} Bun installed it to ${tilde(where.pkgRoot)}${RESET}`, GRAY));
    return true;
  }
  // put the old wu back exactly where it was, with its command
  rmSync(where.pkgRoot, { recursive: true, force: true });
  mkdirSync(dirname(where.pkgRoot), { recursive: true });
  cpSync(backup, where.pkgRoot, { recursive: true });
  const link = join(binDir, "wu");
  try {
    if (!existsSync(link)) symlinkSync(relative(binDir, join(where.pkgRoot, pkg.bin.wu)), link);
  } catch {}
  rmSync(backup, { recursive: true, force: true });
  println(`${bullet("err")} ${BOLD}Update${RESET}(wu v${VERSION} → v${target})`);
  println(result(`${why || "bun didn't install it"} · kept v${VERSION}`, RED));
  println(`     ${rich(`Try by hand: \`bun add -g github:${REPO}\``)}`);
  return false;
}
