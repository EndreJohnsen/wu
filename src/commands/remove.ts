// `wu remove [addon…]`: tick tracked addons in a checklist (or name them) and remove them. Their folders
// are moved into a Soulstone, not deleted, so `wu restore` brings them back. WTF settings stay put.
import { join } from "node:path";
import { finale } from "../engram";
import { renameSync } from "../install";
import { type Entry, WOW_DIR, acquireLock, addonsDir, isDir, loadState, saveState, tilde, wowRunning } from "../paths";
import { type StoneAddon, castSoulstone, sealSoulstone, withCast } from "../soulstone";
import {
  BOLD, CLAUDE, GRAY, GREEN, RED, RESET, STRIKE, TTY, WHITE, YELLOW, Keys, bullet, choose, dfit, lead, live, println,
  result, rich, termRows,
} from "../term";

type Row = { pid: string; a: Entry; on: boolean };

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Tracked addons an argument names: project id, title, folder, CurseForge link/slug, or part of a title. */
function matches(arg: string, rows: Row[]): Row[] {
  const raw = arg.trim().replace(/^.*curseforge\.com\/wow\/addons\//i, "").replace(/[/?#].*$/, "");
  const q = squash(raw);
  if (!q) return [];
  const exact = rows.filter(
    (r) => r.pid === raw || squash(r.a.title) === q || (r.a.folders ?? []).some((f) => squash(f) === q),
  );
  return exact.length ? exact : rows.filter((r) => squash(r.a.title).includes(q));
}

/** Space ticks, enter removes the ticked ones. Returns false on cancel. */
async function checklist(rows: Row[]): Promise<boolean> {
  const ui = { cursor: 0, top: 0, note: "" };
  const titleW = Math.min(32, Math.max(...rows.map((r) => r.a.title.length)));
  const verW = Math.min(16, Math.max(...rows.map((r) => (r.a.version || "?").length)));
  live.start(() => {
    const height = Math.max(5, termRows() - 10);
    if (ui.cursor < ui.top) ui.top = ui.cursor;
    else if (ui.cursor >= ui.top + height) ui.top = ui.cursor - height + 1;
    const n = rows.filter((r) => r.on).length;
    const out = [`${bullet("ok")} ${BOLD}Remove${RESET}(tick the addons to remove) ${GRAY}· ${rows.length} tracked${RESET}`];
    for (let i = ui.top; i < Math.min(rows.length, ui.top + height); i++) {
      const r = rows[i]!;
      const here = i === ui.cursor;
      const box = r.on ? `${RED}☒${RESET}` : `${GRAY}☐${RESET}`;
      const title = dfit(r.a.title, titleW);
      const name = r.on ? `${RED}${STRIKE}${title}${RESET}` : here ? `${BOLD}${WHITE}${title}${RESET}` : title;
      const folders = r.a.folders?.length ?? 0;
      const meta = `${dfit(r.a.version || "?", verW)}  ${folders} folder${folders !== 1 ? "s" : ""}`;
      out.push(`  ${here ? `${CLAUDE}❯${RESET}` : " "} ${box} ${name}  ${GRAY}${meta}${RESET}`);
    }
    if (rows.length > height) out.push(`    ${GRAY}${ui.top + 1}-${Math.min(rows.length, ui.top + height)} of ${rows.length}${RESET}`);
    const cur = rows[ui.cursor]!;
    out.push("");
    out.push(`     ${GRAY}folders${RESET}  ${(cur.a.folders ?? []).join(", ") || "none"}`);
    out.push("");
    out.push("  " + rich(`{↑↓} move · {space} tick · {a} all/none · {enter} remove${n ? ` ${n}` : ""} · {q} cancel`));
    if (ui.note) out.push(`  ${ui.note}`);
    return out;
  });
  const keys = new Keys().start();
  try {
    for (;;) {
      const k = await keys.next();
      ui.note = "";
      if (k === "q" || k === "Q" || k === "esc") return false;
      if (k === "enter") {
        if (rows.some((r) => r.on)) return true;
        ui.note = rich("Tick at least one with {space} first.", YELLOW);
      } else if (k === "up" || k === "k") ui.cursor = (ui.cursor - 1 + rows.length) % rows.length;
      else if (k === "down" || k === "j") ui.cursor = (ui.cursor + 1) % rows.length;
      else if (k === "pgup") ui.cursor = Math.max(0, ui.cursor - 10);
      else if (k === "pgdn") ui.cursor = Math.min(rows.length - 1, ui.cursor + 10);
      else if (k === " " || k === "x") rows[ui.cursor]!.on = !rows[ui.cursor]!.on;
      else if (k === "a" || k === "A") {
        const all = rows.every((r) => r.on);
        for (const r of rows) r.on = !all;
      }
      live.refresh();
    }
  } finally {
    keys.stop();
    live.stop();
  }
}

export async function cmdRemove(args: string[]): Promise<number> {
  acquireLock();
  const state = loadState();
  const rows: Row[] = Object.entries(state.addons)
    .map(([pid, a]) => ({ pid, a, on: false }))
    .sort((x, y) => x.a.title.toLowerCase().localeCompare(y.a.title.toLowerCase()));
  if (!rows.length) {
    println(`${bullet("ok")} ${BOLD}Remove${RESET}`);
    println(result(rich("wu isn't tracking any addons, so there's nothing to remove. `wu import` adopts the ones you have.")));
    return 0;
  }
  if (!isDir(WOW_DIR)) {
    println(`${bullet("err")} Can't find WoW Forever at ${tilde(WOW_DIR)}`);
    println(result(rich("Run `wu setup` first.", RED), RED));
    return 1;
  }

  const interactive = TTY && process.stdin.isTTY;
  let names = args.filter((a) => !a.startsWith("-"));
  if (names.length > 1 && matches(names.join(" "), rows).length === 1) names = [names.join(" ")]; // wu remove fake bags
  if (names.length) {
    for (const name of names) {
      const hit = matches(name, rows);
      if (hit.length === 1) hit[0]!.on = true;
      else {
        println(`${bullet("err")} ${BOLD}Remove${RESET}(${name})`);
        if (!hit.length) println(result(rich(`No tracked addon matches "${name}". \`wu list\` shows them, or run \`wu remove\` to pick.`), RED));
        else {
          println(result(`"${name}" matches ${hit.length} addons. Be more specific, or use the id:`, YELLOW));
          for (const r of hit) println(`     ${r.a.title}  ${GRAY}wu remove ${r.pid}${RESET}`);
        }
        return 1;
      }
    }
    const picked = rows.filter((r) => r.on);
    const what = picked.map((r) => r.a.title).join(", ");
    const pick = await choose(`${bullet("warn")} ${BOLD}Remove ${what}?${RESET}`, [
      { label: `Remove ${picked.length === 1 ? "it" : `all ${picked.length}`}`, hint: "a Soulstone keeps a copy, wu restore brings it back" },
      { label: "Cancel", hint: "" },
    ]);
    if (pick !== 0) {
      println(result("Nothing removed."));
      return 0;
    }
  } else if (!interactive) {
    println(`${RED}●${RESET} usage: ${rich("`wu remove <addon>` (a name, project id or CurseForge link; `wu list` shows them)")}`);
    return 2;
  } else if (!(await checklist(rows))) {
    println(`${bullet("ok")} ${BOLD}Remove${RESET}`);
    println(result("Nothing removed."));
    return 0;
  }

  const picked = rows.filter((r) => r.on);
  const pickedIds = new Set(picked.map((r) => r.pid));
  // a folder another tracked addon also ships stays where it is
  const shared = new Set(rows.filter((r) => !pickedIds.has(r.pid)).flatMap((r) => r.a.folders ?? []));
  const gone: StoneAddon[] = picked.map((r) => ({
    pid: r.pid, title: r.a.title, from: r.a.version || "?", to: "removed",
    folders: (r.a.folders ?? []).filter((f) => !shared.has(f)),
  }));

  // the Soulstone takes WTF + wu's state now; the addon folders are moved into it below
  const stone = await castSoulstone("remove", gone);
  let moved = 0;
  try {
    await withCast(`Remove(${picked.length} addon${picked.length !== 1 ? "s" : ""})`, [["Banishing", "shadow", 0.22]], 0, () => {
      for (const g of gone) {
        for (const f of g.folders) {
          const src = join(addonsDir(), f);
          if (isDir(src)) {
            renameSync(src, join(stone.dir, "AddOns", f));
            moved++;
          }
        }
        delete state.addons[g.pid];
        saveState(state); // per addon, so an error halfway leaves wu's list matching the disk
      }
    });
  } catch (e: any) {
    sealSoulstone(stone, gone); // whatever moved before the error is in there, so `wu restore` can bring it back
    println(`${bullet("err")} ${BOLD}Remove${RESET}`);
    println(result(`${e?.message ?? e}`, RED));
    println(`     ${rich("Anything already moved is in the newest Soulstone: `wu restore` brings it back.")}`);
    return 1;
  }
  sealSoulstone(stone, gone);

  println(`${bullet("ok")} ${BOLD}Remove${RESET}(${picked.length} addon${picked.length !== 1 ? "s" : ""} · ${moved} folder${moved !== 1 ? "s" : ""})`);
  gone.forEach((g, i) => println(`${lead(i)}${GREEN}✓${RESET} ${g.title} ${GRAY}${g.from}${RESET}`));
  println(`     ${GRAY}Their settings in WTF stay. ${RESET}${rich("`wu restore` brings the addons back.")}`);
  if (wowRunning()) println(`     ${YELLOW}WoW is running: they stay loaded until you /reload or relog.${RESET}`);
  println();
  const left = Object.keys(state.addons).length;
  const who = picked.length === 1 ? picked[0]!.a.title : `${picked.length} addons`;
  await finale(`Banished ${who} · wu now tracks ${left} addon${left !== 1 ? "s" : ""}`);
  return 0;
}
