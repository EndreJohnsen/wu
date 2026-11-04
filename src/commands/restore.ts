// `wu restore`: resurrect addons and/or WTF settings from a soulstone (wu casts one before every update).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { finale } from "../engram";
import { renameSync } from "../install";
import { type State, WOW_DIR, acquireLock, addonsDir, isDir, loadState, saveState, wowRunning } from "../paths";
import { type Stone, castSoulstone, copyTree, listStones, sealSoulstone, stoneSummary, withCast } from "../soulstone";
import { BOLD, CLAUDE, GRAY, GREEN, RESET, TTY, YELLOW, bullet, choose, fmtAgo, fmtSize, lead, println, result, rich } from "../term";

export async function cmdRestore(args: string[]): Promise<number> {
  acquireLock();
  const stones = listStones();
  if (!stones.length) {
    println(`${bullet("ok")} ${BOLD}Restore${RESET}`);
    println(result("No soulstones yet. wu casts one automatically before every addon update."));
    return 0;
  }
  if (wowRunning()) {
    println(`${bullet("warn")} ${BOLD}Restore${RESET}`);
    println(result("Exit WoW first: it rewrites addon settings when you log out, which would undo the restore.", YELLOW));
    return 1;
  }
  const label = (s: Stone) => {
    const when = new Date(s.manifest.created);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())} ${p(when.getHours())}:${p(when.getMinutes())} · before ${stoneSummary(s.manifest)}`;
  };
  let stone: Stone;
  if (args[0] === "--latest" || !(TTY && process.stdin.isTTY)) stone = stones[0]!;
  else {
    const i = await choose(
      `${bullet("ok")} ${BOLD}Which soulstone?${RESET} ${GRAY}(newest first)${RESET}`,
      stones.map((s) => ({ label: label(s), hint: `${s.manifest.addons.length} addons · WTF ${fmtSize(s.manifest.wtfBytes)} · ${fmtAgo(s.manifest.created)}` })),
    );
    if (i < 0) {
      println(result("Nothing restored."));
      return 0;
    }
    stone = stones[i]!;
  }

  const hasWtf = isDir(join(stone.dir, "WTF"));
  let what = 0; // 0 addons + settings, 1 addons only, 2 settings only
  if (TTY && process.stdin.isTTY) {
    const opts = [
      { label: "Addons and settings", hint: hasWtf ? "the addon versions and the whole WTF folder from then" : "" },
      { label: "Addons only", hint: stone.manifest.addons.map((a) => `${a.title} ${a.from}`).join(", ") },
      ...(hasWtf ? [{ label: "Settings only (WTF)", hint: "keeps today's addon versions" }] : []),
      { label: "Cancel", hint: "" },
    ];
    what = await choose(`${bullet("ok")} ${BOLD}Restore what?${RESET} ${GRAY}from ${label(stone)}${RESET}`, opts);
    if (what < 0 || what === opts.length - 1) {
      println(result("Nothing restored."));
      return 0;
    }
  }
  const doAddons = what === 0 || what === 1;
  const doWtf = hasWtf && (what === 0 || what === 2);

  // a fresh soulstone of how things are right now, so this restore can be undone too
  const reversed = stone.manifest.addons.map((a) => ({ ...a, from: a.to, to: a.from }));
  const undo = await castSoulstone("restore", reversed, stone.dir);
  const restored: string[] = [];
  await withCast("Restore(resurrecting)", [["Using Soulstone", "shadow", 0.2], ["Resurrecting", "holy", 0.25]], 0, () => {
    if (doAddons) {
      const old: State | null = (() => {
        try {
          return JSON.parse(readFileSync(join(stone.dir, "state.json"), "utf8"));
        } catch {
          return null;
        }
      })();
      const state = loadState();
      const saved = join(stone.dir, "AddOns");
      for (const a of stone.manifest.addons) {
        // today's folders for this addon go into the undo stone, the stone's copies come back
        const now = state.addons[a.pid]?.folders ?? a.folders;
        for (const f of now) {
          const cur = join(addonsDir(), f);
          if (isDir(cur)) renameSync(cur, join(undo.dir, "AddOns", f));
        }
        for (const f of a.folders) if (isDir(join(saved, f))) copyTree(join(saved, f), join(addonsDir(), f));
        if (old?.addons[a.pid]) state.addons[a.pid] = old.addons[a.pid]!;
        restored.push(`${a.title} ${a.from}`);
      }
      saveState(state);
    }
    if (doWtf) {
      copyTree(join(stone.dir, "WTF"), join(WOW_DIR, "WTF"));
      restored.push("WTF settings");
    }
  });
  sealSoulstone(undo, reversed);

  println(`${bullet("ok")} ${BOLD}Restore${RESET}(from ${label(stone)})`);
  restored.forEach((r, i) => println(`${lead(i)}${GREEN}✓${RESET} ${r}`));
  println(`     ${GRAY}what you had a moment ago is in a new soulstone, ${RESET}${rich("`wu restore` again undoes this")}`);
  println();
  await finale(
    "Resurrected · log in and it's like the update never happened",
    `${CLAUDE}Resurrected${RESET} ${GRAY}·${RESET} ${rich(doAddons ? "run `wu` later to get the updates back" : "settings are back", CLAUDE)}`,
  );
  return 0;
}

