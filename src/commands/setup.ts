// `wu setup [path]`: find WoW Forever by itself (searches the disks), or take a pasted path.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { banner, finale } from "../engram";
import {
  CONFIG_FILE, WOW_DIR, detectForever, envOverride, isDir, isFile, loadState, resolveWowInput, saveConfig, scanDisks,
  setWowDir, shortPath, tilde, type ScanProgress,
} from "../paths";
import { BOLD, CLAUDE, GRAY, RED, RESET, Spinner, TTY, YELLOW, Keys, bullet, choose, fmtDur, live, println, promptBox, result, rich } from "../term";

function addonCount(forever: string): number {
  try {
    const dir = join(forever, "Interface", "AddOns");
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && readdirSync(join(dir, d.name)).some((f) => f.endsWith(".toc"))).length;
  } catch {
    return 0;
  }
}

/** Search this computer for WoW Forever installs, with a cast bar. esc stops early. */
async function search(): Promise<string[]> {
  const progress: ScanProgress & { abort?: boolean } = { dirs: 0, now: "", found: [...detectForever()] };
  if (!TTY) return scanDisks(progress, 20000);
  const spin = new Spinner();
  const t0 = Date.now();
  live.start((f) => [
    `${bullet("run", f)} ${BOLD}Search${RESET}(WoW Forever on this computer)`,
    result(`${progress.dirs.toLocaleString()} folders · found ${progress.found.length}` + (progress.now ? ` · ${shortPath(progress.now, 50)}` : "")),
    "",
    spin.line(f, ["esc to stop"]),
  ]);
  const keys = process.stdin.isTTY ? new Keys().start() : null;
  const watch = (async () => {
    while (keys && !progress.abort) {
      const k = await keys.next();
      if (k === "esc" || k === "q" || k === "enter") progress.abort = true;
    }
  })();
  try {
    await scanDisks(progress, 20000);
  } finally {
    progress.abort = true;
    keys?.stop();
    live.stop();
  }
  void watch;
  const n = progress.found.length;
  println(`${bullet(n ? "ok" : "warn")} ${BOLD}Search${RESET}(WoW Forever on this computer)`);
  println(result(`found ${n} install${n !== 1 ? "s" : ""} in ${progress.dirs.toLocaleString()} folders · ${fmtDur((Date.now() - t0) / 1000)}`));
  println();
  return progress.found;
}

async function pastePath(): Promise<string | null> {
  println(result("Paste the path to WoW Forever (the _forever_ folder, World of Warcraft, or Wow.exe)."));
  println();
  for (let i = 0; i < 3; i++) {
    const raw = await promptBox(String.raw`Linux or Windows paths both work, e.g. C:\Program Files (x86)\World of Warcraft`);
    if (!raw.trim()) {
      println(result("Nothing pasted. Try again (ctrl+c to quit).", YELLOW));
      println();
      continue;
    }
    const [path, why] = resolveWowInput(raw);
    if (path) return path;
    println(result(why ?? "That didn't work.", RED));
    println();
  }
  return null;
}

export async function cmdSetup(args: string[]): Promise<number> {
  const n = Object.keys(loadState().addons).length;
  await banner(n, [
    `${BOLD}wu setup${RESET}`,
    `${GRAY}Point wu at your WoW Forever folder${RESET}`,
    `${GRAY}current: ${isDir(WOW_DIR) ? shortPath(WOW_DIR) : "not set"}${RESET}`,
  ]);
  let path: string | null = null;
  if (args.length) {
    const [p, why] = resolveWowInput(args.join(" "));
    if (!p) {
      println(`${bullet("err")} ${BOLD}Setup${RESET}\n${result(why ?? "", RED)}`);
      return 1;
    }
    path = p;
  } else {
    const found = await search();
    if (found.length) {
      const options = [
        ...found.map((p) => {
          const bits = [`${addonCount(p)} addons`];
          if (p === WOW_DIR) bits.push("current");
          if (!isFile(join(p, "Wow.exe"))) bits.push("no Wow.exe yet");
          return { label: tilde(p), hint: bits.join(" · ") };
        }),
        { label: "Paste a different path…", hint: "" },
      ];
      const pick = await choose(`${bullet("ok")} ${BOLD}Which one is yours?${RESET}`, options, Math.max(0, found.indexOf(WOW_DIR)));
      if (pick === -1) {
        println(result("Nothing changed."));
        return 0;
      }
      path = pick < found.length ? found[pick]! : await pastePath();
    } else {
      println(`${bullet("warn")} ${BOLD}Setup${RESET}`);
      println(result("Didn't find WoW Forever by searching. Has the Battle.net launcher installed it yet?"));
      path = await pastePath();
    }
    if (!path) return 1;
  }

  saveConfig(path);
  setWowDir(path);
  const have = addonCount(path);
  println(`${bullet("ok")} ${BOLD}Saved${RESET}(${tilde(CONFIG_FILE)})`);
  println(result(`WoW Forever: ${tilde(path)}`));
  println(`     ${GRAY}${have} addon folder${have !== 1 ? "s" : ""} in Interface/AddOns${RESET}`);
  if (envOverride()) println(`     ${YELLOW}Note: WU_DIR is set in your environment and overrides this.${RESET}`);
  println();
  await finale(
    "All set · run wu to install or update your addons there",
    rich(have ? "All set · `wu import` adopts what's there, `wu` keeps it fresh" : "All set · try `wu search bags` to add your first addon", CLAUDE),
  );
  return 0;
}
