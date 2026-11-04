// `wu import [--yes]`: match untracked AddOns folders to CurseForge, then accept or deny each match.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CF_API, cfMod, foreverFile, getJson, prettyVersion, type ForeverFile } from "../curseforge";
import { finale } from "../engram";
import { GAME_VERSION, acquireLock, addonsDir, isDir, loadState, saveState, tilde } from "../paths";
import {
  BOLD, CLAUDE, COLOR, GRAY, GREEN, RED, RESET, Spinner, TTY, WHITE, Keys, bullet, dfit, fmtCount, lead, live, plain,
  println, result, rich, stamp, termRows,
} from "../term";
import { limiter } from "./update";

const WOW_CODES = /\|c[0-9a-fA-F]{8}|\|r|\|T[^|]*\|t|\|A[^|]*\|a|\|n/g;
const normName = (s?: string) => String(s ?? "").replace(WOW_CODES, "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** difflib.SequenceMatcher(None, a, b).ratio(): 2·matches / total, via longest matching blocks. */
export function ratio(a: string, b: string): number {
  if (!a.length && !b.length) return 1;
  const matches = (alo: number, ahi: number, blo: number, bhi: number): number => {
    let best = 0;
    let bi = 0;
    let bj = 0;
    for (let i = alo; i < ahi; i++)
      for (let j = blo; j < bhi; j++) {
        let k = 0;
        while (i + k < ahi && j + k < bhi && a[i + k] === b[j + k]) k++;
        if (k > best) [best, bi, bj] = [k, i, j];
      }
    if (!best) return 0;
    return best + matches(alo, bi, blo, bj) + matches(bi + best, ahi, bj + best, bhi);
  };
  return (2 * matches(0, a.length, 0, b.length)) / (a.length + b.length);
}

type Meta = { title: string; version: string; cfId: string | null; deps: string[] };

function readToc(folder: string, name: string): Meta | null {
  let tocs: string[];
  try {
    tocs = readdirSync(folder).filter((f) => f.toLowerCase().endsWith(".toc"));
  } catch {
    return null;
  }
  if (!tocs.length) return null;
  const stem = (t: string) => t.slice(0, -4).toLowerCase();
  tocs.sort((x, y) => Number(!stem(x).endsWith("_camelot")) - Number(!stem(y).endsWith("_camelot")) ||
    Number(stem(x) !== name.toLowerCase()) - Number(stem(y) !== name.toLowerCase()) || x.localeCompare(y));
  const fields = new Map<string, string>();
  for (const toc of tocs) {
    let text = "";
    try {
      text = readFileSync(join(folder, toc), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/).slice(0, 120)) {
      const m = /^\s*##\s*([^:]+?)\s*:\s*(.*?)\s*$/.exec(line);
      if (m && !fields.has(m[1]!.toLowerCase())) fields.set(m[1]!.toLowerCase(), m[2]!);
    }
  }
  const deps = ["dependencies", "requireddeps", "dep", "dependancies"].flatMap((k) =>
    (fields.get(k) ?? "").split(",").map((d) => d.trim()).filter(Boolean));
  const title = (fields.get("title") ?? name).replace(WOW_CODES, "").replace(/\s+/g, " ").trim() || name;
  const cfId = (fields.get("x-curse-project-id") ?? "").replace(/\D/g, "") || null;
  return { title, version: (fields.get("version") ?? "").trim(), cfId, deps };
}

const versionTokens = (s?: string) => new Set(String(s ?? "").match(/\d+(?:\.\d+)+/g) ?? []);

function sameVersion(installed: string, ff: ForeverFile | null): boolean {
  if (!installed || !ff) return false;
  if (prettyVersion({ display: installed }) === prettyVersion({ display: ff.display })) return true;
  const mine = [...versionTokens(installed)];
  if (!mine.length) return false;
  const main = mine.reduce((a, b) => (b.length > a.length ? b : a));
  return versionTokens(ff.display).has(main) || versionTokens(ff.name).has(main);
}

type Cand = {
  pid: string; name: string; downloads: number; authors: string[]; score: number; why: string;
  file: ForeverFile | null; modules: string[]; forever: boolean; current: boolean;
};

function candidate(mod: any, folder: string, meta: Meta, viaToc = false): Cand {
  const ff = foreverFile(mod);
  const mods = new Set((ff?.modules ?? []).map((m) => m.toLowerCase()));
  for (const lf of mod.latestFiles ?? []) for (const m of lf.modules ?? []) mods.add(String(m.name ?? "").toLowerCase());
  const names = [normName(mod.name), normName(mod.slug)];
  const mine = [normName(meta.title), normName(folder)];
  let score = 0;
  let why = "";
  if (viaToc) [score, why] = [1000, "TOC project id"];
  else if (mods.has(folder.toLowerCase())) [score, why] = [100, "ships this folder"];
  if (names.some((n) => n && mine.includes(n))) {
    score += 60;
    why ||= "same name";
  } else {
    const r = Math.max(0, ...names.flatMap((a) => mine.filter((b) => a && b).map((b) => ratio(a, b))));
    score += Math.trunc(r * 50);
    why ||= `similar name (${Math.trunc(r * 100)}%)`;
  }
  score += Math.min(9, Math.trunc(Math.log10((mod.downloadCount ?? 0) + 1)));
  return {
    pid: String(mod.id), name: mod.name ?? "?", downloads: mod.downloadCount ?? 0,
    authors: (mod.authors ?? []).slice(0, 2).map((a: any) => a.name ?? ""), score, why,
    file: ff, modules: ff?.modules ?? [], forever: ff !== null, current: sameVersion(meta.version, ff),
  };
}

/** CurseForge candidates for one installed addon folder, best first. */
async function matchFolder(folder: string, meta: Meta): Promise<Cand[]> {
  const cands = new Map<string, Cand>();
  const add = (mod: any, viaToc = false) => {
    const c = candidate(mod, folder, meta, viaToc);
    if (!cands.has(c.pid) || c.score > cands.get(c.pid)!.score) cands.set(c.pid, c);
  };
  if (meta.cfId) {
    try {
      add(await cfMod(meta.cfId), true);
    } catch {}
  }
  const queries: string[] = [];
  for (let q of [meta.title, folder.replace(/(?<=[a-z])(?=[A-Z])|_/g, " ")]) {
    q = q.replace(/[^\w\s'-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
    if (q && !queries.some((x) => x.toLowerCase() === q.toLowerCase())) queries.push(q);
  }
  for (const q of queries) {
    if (cands.size && Math.max(...[...cands.values()].map((c) => c.score)) >= 160) break;
    for (const foreverOnly of [true, false]) {
      const params = new URLSearchParams({ gameId: "1", searchFilter: q, sortField: "2", sortOrder: "desc", pageSize: "12" });
      if (foreverOnly) params.set("gameVersion", GAME_VERSION);
      try {
        const { data } = await getJson(`${CF_API}/mods/search?${params}`);
        for (const mod of data.data ?? []) add(mod);
      } catch {}
      if ([...cands.values()].some((c) => c.forever && c.score >= 60)) break;
    }
  }
  return [...cands.values()]
    .filter((c) => c.score >= (c.forever ? 25 : 60))
    .sort((a, b) => Number(!a.forever) - Number(!b.forever) || b.score - a.score)
    .slice(0, 6);
}

type Row = { main: string; meta: Meta; folders: string[]; cands: Cand[]; ci: number; accept: boolean | null };

export async function cmdImport(args: string[]): Promise<number> {
  const auto = args.includes("--yes") || args.includes("-y");
  const state = loadState();
  if (!isDir(addonsDir())) {
    println(`${bullet("err")} Can't find ${tilde(addonsDir())}`);
    println(result(rich("Run `wu setup` first.", RED), RED));
    return 1;
  }
  const owned = new Set(Object.values(state.addons).flatMap((a) => a.folders ?? []));
  const found = new Map<string, Meta>();
  const dirs = readdirSync(addonsDir(), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  for (const name of dirs) {
    if (name.startsWith(".") || name.startsWith("Blizzard_") || owned.has(name)) continue;
    const meta = readToc(join(addonsDir(), name), name);
    if (meta) found.set(name, meta);
  }
  const head = `${bullet("ok")} ${BOLD}Import${RESET}(${found.size} untracked folder${found.size !== 1 ? "s" : ""})`;
  if (!found.size) {
    println(head);
    println(result("Everything in AddOns is already tracked by wu."));
    return 0;
  }

  const names = [...found.keys()];
  const lower = new Map(names.map((n) => [n.toLowerCase(), n]));
  const parentOf = (n: string): string | null => {
    for (const dep of found.get(n)!.deps) {
      const p = lower.get(dep.toLowerCase());
      if (p && p !== n) return p;
    }
    const prefixes = names.filter((o) => o !== n && o.length >= 3 && n.toLowerCase().startsWith(o.toLowerCase()));
    return prefixes.length ? prefixes.reduce((a, b) => (b.length > a.length ? b : a)) : null;
  };
  const roots = names.filter((n) => parentOf(n) === null);
  const matches = new Map<string, Cand[]>();
  const progress = { done: 0, total: roots.length, now: "" };
  const spin = new Spinner();
  live.start((f) => [
    `${bullet("run", f)} ${BOLD}Import${RESET}(${found.size} untracked folders)`,
    result(`matching ${progress.done}/${progress.total} on CurseForge` + (progress.now ? ` · ${progress.now}` : "")),
    "",
    spin.line(f),
  ]);
  const lim = limiter(4);
  const run = async (batch: string[]) => {
    progress.total = progress.done + batch.length;
    await Promise.all(batch.map((n) => lim(async () => {
      progress.now = found.get(n)!.title;
      matches.set(n, await matchFolder(n, found.get(n)!).catch(() => []));
      progress.done++;
    })));
  };

  const rows: Row[] = [];
  try {
    await run(roots);
    const claimed = new Set<string>();
    const claim = (n: string) => {
      const cands = matches.get(n) ?? [];
      const best = cands[0];
      const group = new Set([n]);
      if (best) {
        const mods = new Set(best.modules.map((m) => m.toLowerCase()));
        for (const f of names) if (mods.has(f.toLowerCase())) group.add(f);
      }
      const mine = [...group].filter((g) => !claimed.has(g));
      mine.forEach((g) => claimed.add(g));
      const ok = Boolean(best?.forever);
      rows.push({ main: n, meta: found.get(n)!, folders: mine.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
        cands, ci: 0, accept: ok ? best!.score >= 60 : null });
    };
    for (const n of [...roots].sort((a, b) => (matches.get(b)?.[0]?.score ?? 0) - (matches.get(a)?.[0]?.score ?? 0)))
      if (!claimed.has(n)) claim(n);
    const leftovers = names.filter((n) => !claimed.has(n));
    if (leftovers.length) {
      // sub-folders whose parent didn't claim them: try them on their own
      await run(leftovers.filter((n) => !matches.has(n)));
      for (const n of leftovers) if (!claimed.has(n)) claim(n);
    }
    await live.settle();
  } finally {
    live.stop();
  }
  rows.sort((a, b) => Number(a.accept === null) - Number(b.accept === null) || a.meta.title.toLowerCase().localeCompare(b.meta.title.toLowerCase()));

  const cand = (row: Row) => row.cands[row.ci] ?? null;
  const chip = (row: Row) =>
    row.accept === null ? `${GRAY}– skip  ${RESET}` : row.accept ? `${GREEN}✓ accept${RESET}` : `${RED}✗ deny  ${RESET}`;
  const rowLine = (row: Row, selected: boolean) => {
    const c = cand(row);
    const extra = row.folders.length > 1 ? ` +${row.folders.length - 1}` : "";
    const left = dfit(row.meta.title + extra, 28);
    let right: string;
    if (!c) right = `${GRAY}no match on CurseForge${RESET}`;
    else if (!c.forever) right = `${GRAY}${c.name} is on CurseForge, but has no WoW Forever build${RESET}`;
    else right = `${WHITE}${c.name}${RESET} ${GRAY}#${c.pid} · ${c.why}${RESET}`;
    const ptr = selected ? `${CLAUDE}❯${RESET}` : " ";
    return `  ${ptr} ${chip(row)}  ${selected ? BOLD + left + RESET : left} ${GRAY}→${RESET} ${right}`;
  };

  if (auto || !(TTY && process.stdin.isTTY)) {
    println(head);
    for (const row of rows) println(COLOR ? rowLine(row, false) : "  " + plain(rowLine(row, false)));
    if (!auto) {
      println();
      println(rich("Nothing changed. Run `wu import` in a terminal to review, or `wu import --yes` to take the ✓ ones."));
      return 0;
    }
    return finishImport(rows, cand);
  }

  const ui = { cursor: 0, top: 0 };
  live.start(() => {
    const height = Math.max(6, termRows() - 14);
    if (ui.cursor < ui.top) ui.top = ui.cursor;
    else if (ui.cursor >= ui.top + height) ui.top = ui.cursor - height + 1;
    const nAcc = rows.filter((r) => r.accept).length;
    const out = [`${head} ${GRAY}· ${rows.length} addon${rows.length !== 1 ? "s" : ""} · ${nAcc} to import${RESET}`];
    if (ui.top) out.push(`     ${GRAY}↑ ${ui.top} more${RESET}`);
    for (let i = ui.top; i < Math.min(rows.length, ui.top + height); i++) out.push(rowLine(rows[i]!, i === ui.cursor));
    const rest = rows.length - (ui.top + height);
    if (rest > 0) out.push(`     ${GRAY}↓ ${rest} more${RESET}`);
    const row = rows[ui.cursor]!;
    const c = cand(row);
    out.push("");
    const folders = row.folders.slice(0, 6).join(", ") + (row.folders.length > 6 ? ` +${row.folders.length - 6}` : "");
    out.push(`     ${GRAY}installed${RESET}  ${row.meta.title} ${GRAY}${row.meta.version} · ${folders}${RESET}`);
    if (c) {
      const st = c.forever ? (c.current ? "up to date" : `update available → ${prettyVersion(c.file!)}`) : "no WoW Forever build";
      const who = c.authors.length ? ` · by ${c.authors.join(", ")}` : "";
      out.push(`     ${GRAY}curse${RESET}      ${c.name} ${GRAY}· ${fmtCount(c.downloads)} downloads${who} · ${RESET}${c.current ? GREEN : CLAUDE}${st}${RESET}`);
      if (row.cands.length > 1) out.push(`     ${GRAY}match ${row.ci + 1}/${row.cands.length} ·${RESET} ` + rich("{←→} to see the others"));
    }
    out.push("");
    out.push("  " + rich("{↑↓} move · {y} accept · {n} deny · {space} toggle · {←→} other match · {a} accept all · {enter} import · {q} quit"));
    return out;
  });
  let go = false;
  const keys = new Keys().start();
  try {
    for (;;) {
      const k = await keys.next();
      const row = rows[ui.cursor]!;
      const c = cand(row);
      if (k === "q" || k === "Q" || k === "esc") break;
      if (k === "enter") {
        go = true;
        break;
      }
      if (k === "up" || k === "k") ui.cursor = (ui.cursor - 1 + rows.length) % rows.length;
      else if (k === "down" || k === "j") ui.cursor = (ui.cursor + 1) % rows.length;
      else if ((k === "y" || k === "Y") && c?.forever) {
        row.accept = true;
        ui.cursor = Math.min(rows.length - 1, ui.cursor + 1);
      } else if ((k === "n" || k === "N" || k === "d") && row.accept !== null) {
        row.accept = false;
        ui.cursor = Math.min(rows.length - 1, ui.cursor + 1);
      } else if (k === " " && row.accept !== null) row.accept = !row.accept;
      else if ((k === "right" || k === "left" || k === "tab") && row.cands.length > 1) {
        row.ci = (row.ci + (k === "left" ? -1 : 1) + row.cands.length) % row.cands.length;
        row.accept = cand(row)!.forever ? (row.accept ?? false) : null;
      } else if (k === "a") for (const r of rows) if (r.accept !== null) r.accept = true;
      live.refresh();
    }
  } finally {
    keys.stop();
    live.stop();
  }
  if (!go) {
    println(head);
    println(result("Nothing imported."));
    return 0;
  }
  return finishImport(rows, cand);
}

async function finishImport(rows: Row[], cand: (r: Row) => Cand | null): Promise<number> {
  acquireLock();
  const state = loadState();
  const taken: [Cand, Row][] = [];
  let skipped = 0;
  let stale = 0;
  for (const row of rows) {
    const c = cand(row);
    if (!row.accept || !c?.forever) {
      skipped++;
      continue;
    }
    const entry = state.addons[c.pid] ?? { title: c.name, file_id: null, version: null, folders: [] };
    entry.title = c.name;
    entry.folders = [...new Set([...(entry.folders ?? []), ...row.folders])].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    if (c.current) Object.assign(entry, { file_id: c.file!.id, file_name: c.file!.name, version: prettyVersion(c.file!) });
    else if (!entry.file_id) {
      entry.version = row.meta.version ? prettyVersion({ display: row.meta.version }) : null;
      stale++;
    }
    entry.updated_at = stamp();
    state.addons[c.pid] = entry;
    taken.push([c, row]);
  }
  saveState(state);
  println(`${bullet("ok")} ${BOLD}Import${RESET}(${taken.length} accepted · ${skipped} skipped)`);
  taken.forEach(([c, row], i) => {
    const status = c.current ? `${GREEN}up to date${RESET}` : `${CLAUDE}update waiting${RESET}`;
    const n = row.folders.length;
    println(`${lead(i)}${GREEN}✓${RESET} ${c.name} ${GRAY}· ${n} folder${n !== 1 ? "s" : ""} ·${RESET} ${status}`);
  });
  println();
  if (!taken.length) await finale("Nothing imported this time");
  else if (stale)
    await finale(`DING! ${taken.length} imported · run wu to update ${stale} of them`, rich(`DING! ${taken.length} imported · run \`wu\` to update ${stale} of them`, CLAUDE));
  else await finale(`DING! ${taken.length} addon${taken.length !== 1 ? "s" : ""} imported · all up to date`);
  return 0;
}
