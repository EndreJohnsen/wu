// `wu search [words]`: top WoW Forever addons on CurseForge; pick 1-10 to install.
import { SORTS, released, searchCf } from "../curseforge";
import { loadState } from "../paths";
import {
  BOLD, CLAUDE, GRAY, GREEN, RED, RESET, Spinner, TTY, WHITE, YELLOW, Keys, bullet, dfit, dwidth, fmtAgo, fmtCount,
  live, println, result, rich,
} from "../term";
import { installProject } from "./add";

export async function cmdSearch(args: string[]): Promise<number> {
  const query = args.join(" ").trim();
  const tracked = new Set(Object.keys(loadState().addons));
  const label = query ? `"${query}"` : "top addons";
  const ui = { sort: 0, page: 0, items: [] as any[], total: 0, cursor: 0, loading: true, error: "", note: "" };
  const spin = new Spinner();

  const fetchPage = async () => {
    ui.loading = true;
    ui.error = "";
    spin.reset();
    live.refresh();
    try {
      const { items, total } = await searchCf(query, SORTS[ui.sort]![0], ui.page);
      Object.assign(ui, { items, total });
    } catch (e: any) {
      Object.assign(ui, { items: [], total: 0, error: `search failed: ${e?.message ?? e}` });
    }
    await live.settle(false); // let the cast land before the results replace it
    Object.assign(ui, { cursor: 0, loading: false });
  };

  if (!(TTY && process.stdin.isTTY)) {
    await fetchPage();
    println(`● Search(${label} · WoW Forever · ${SORTS[0]![1]})`);
    if (ui.error) {
      println(`  ⎿  ${ui.error}`);
      return 1;
    }
    ui.items.forEach((m, i) =>
      println(`  ${String(i + 1).padStart(2)}. ${m.name}  (${fmtCount(m.downloadCount)} downloads, updated ${fmtAgo(released(m))})  wu add ${m.id}`),
    );
    return 0;
  }

  const head = () => `${bullet("ok")} ${BOLD}Search${RESET}(${label}) ${GRAY}· WoW Forever · ${RESET}${CLAUDE}${SORTS[ui.sort]![1]}${RESET}`;
  const render = (frame: number) => {
    const pages = Math.max(1, Math.ceil(ui.total / 10));
    if (ui.loading) return [head(), result("asking CurseForge…"), "", spin.line(frame)];
    if (ui.error) return [head(), result(ui.error, RED), "", "  " + rich("{tab} retry · {q} quit")];
    if (!ui.items.length) return [head(), result(`No WoW Forever addons match ${label}.`, YELLOW), "", "  " + rich("{q} quit")];
    const lines = [head(), result(`${ui.total} results · page ${ui.page + 1}/${pages}`), ""];
    const nameW = Math.min(36, Math.max(...ui.items.map((m) => dwidth(m.name ?? ""))));
    ui.items.forEach((m, i) => {
      const name = dfit(m.name ?? "?", nameW);
      const num = `${i + 1}.`.padStart(3);
      const stats = `${fmtCount(m.downloadCount).padStart(6)} ↓  ${fmtAgo(released(m)).padStart(8)}`;
      const have = tracked.has(String(m.id)) ? `  ${GREEN}✓ installed${RESET}` : "";
      if (i === ui.cursor) {
        lines.push(`  ${CLAUDE}❯ ${num} ${BOLD}${name}${RESET}  ${GRAY}${stats}${RESET}${have}`);
        const summary = String(m.summary ?? "").trim();
        const who = (m.authors ?? []).slice(0, 2).map((a: any) => a.name).join(", ");
        if (summary || who) lines.push(`         ${GRAY}${summary}${who ? " · by " + who : ""}${RESET}`);
      } else lines.push(`    ${GRAY}${num}${RESET} ${WHITE}${name}${RESET}  ${GRAY}${stats}${RESET}${have}`);
    });
    lines.push("");
    lines.push("  " + rich(`{↑↓} move · {1-9},{0} install · {enter} install · {tab} ${SORTS[1 - ui.sort]![1]} · {←→} page · {q} quit`));
    if (ui.note) lines.push(`  ${ui.note}`);
    return lines;
  };

  live.start(render);
  let choice: any = null;
  const keys = new Keys().start();
  try {
    await fetchPage();
    live.refresh();
    for (;;) {
      const k = await keys.next();
      ui.note = "";
      const n = ui.items.length;
      let pick: number | null = null;
      if (k === "q" || k === "Q" || k === "esc") break;
      else if ((k === "up" || k === "k") && n) ui.cursor = (ui.cursor - 1 + n) % n;
      else if ((k === "down" || k === "j") && n) ui.cursor = (ui.cursor + 1) % n;
      else if (k === "tab" || k === "shift-tab" || k === "s") {
        ui.sort = 1 - ui.sort;
        ui.page = 0;
        await fetchPage();
      } else if ((k === "right" || k === "pgdn" || k === "n") && (ui.page + 1) * 10 < ui.total) {
        ui.page++;
        await fetchPage();
      } else if ((k === "left" || k === "pgup" || k === "p") && ui.page > 0) {
        ui.page--;
        await fetchPage();
      } else if (k === "enter" && n) pick = ui.cursor;
      else if (/^\d$/.test(k) && n) {
        const idx = k === "0" ? 9 : Number(k) - 1;
        if (idx < n) pick = ui.cursor = idx;
      }
      if (pick !== null) {
        const m = ui.items[pick];
        if (tracked.has(String(m.id))) ui.note = rich(`${m.name} is already installed. Run \`wu\` to update it.`, YELLOW);
        else {
          choice = m;
          break;
        }
      }
      live.refresh();
    }
  } finally {
    keys.stop();
    live.stop();
  }
  const headStatic = `${bullet("ok")} ${BOLD}Search${RESET}(${label}) ${GRAY}· WoW Forever · ${SORTS[ui.sort]![1]}${RESET}`;
  println(headStatic);
  if (!choice) {
    println(result("Nothing installed."));
    return 0;
  }
  println(result(`Picked ${choice.name} · ${fmtCount(choice.downloadCount)} downloads · updated ${fmtAgo(released(choice))}`));
  println();
  return installProject(String(choice.id), choice.name || String(choice.id));
}
