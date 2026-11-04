// `wu add <slug|url|id>` and the shared install flow (used by search too). Also `wu list`.
import { join } from "node:path";
import { fetchProject, pickFile, prettyVersion } from "../curseforge";
import { finale } from "../engram";
import { install, removeIfEmpty } from "../install";
import { type Entry, WOW_DIR, acquireLock, isDir, loadState, saveState, tilde } from "../paths";
import { BOLD, CLAUDE, GRAY, RED, RESET, Spinner, bullet, fmtSize, hlCmd, lead, live, println, result, rich, stamp } from "../term";

export async function cmdAdd(args: string[]): Promise<number> {
  if (!args.length) {
    println(`${RED}●${RESET} usage: ${hlCmd("wu add <slug|curseforge-url|project-id>", RESET)}`);
    return 2;
  }
  const raw = args[0]!.trim();
  const m = /curseforge\.com\/wow\/addons\/([\w-]+)/.exec(raw);
  const ref = m ? `wow/addons/${m[1]}` : /^\d+$/.test(raw) ? raw : `wow/addons/${raw}`;
  return installProject(ref, raw);
}

export async function installProject(ref: string, label: string): Promise<number> {
  acquireLock();
  const state = loadState();
  if (!isDir(WOW_DIR)) {
    println(`${bullet("err")} Can't find WoW Forever at ${tilde(WOW_DIR)}`);
    println(result(rich("Run `wu setup` first.", RED), RED));
    return 1;
  }
  let spin = new Spinner();
  live.start((f) => [`${bullet("run", f)} ${BOLD}Lookup${RESET}(${label})`, "", spin.line(f)]);
  let data;
  try {
    data = await fetchProject(ref);
  } catch (e: any) {
    live.stop();
    println(`${bullet("err")} ${BOLD}Lookup${RESET}(${label})\n${result(e?.message ?? String(e), RED)}`);
    return 1;
  }
  live.stop();
  const pid = String(data.id);
  const title = data.title || label;
  const f = pickFile(data);
  println(`${bullet("ok")} ${BOLD}Lookup${RESET}(${label})`);
  if (state.addons[pid]) {
    println(result(rich(`${title} is already tracked. Run \`wu\` to update it.`)));
    return 0;
  }
  if (!f) {
    println(result(`${title} has no WoW Forever build yet.`, RED));
    return 1;
  }
  println(result(`${title} ${prettyVersion(f)} · ${fmtSize(Number(f.filesize) || 0)}`));
  println();

  const entry: Entry = { title, file_id: null, version: null, folders: [] };
  const progress = { done: 0, total: Number(f.filesize) || 0, phase: "downloading" };
  const workdir = join(WOW_DIR, "Interface", ".wu");
  spin = new Spinner();
  live.start((fr) => [
    `${bullet("run", fr)} ${BOLD}Install${RESET}(${title})`,
    result(progress.phase),
    "",
    spin.line(fr, [`↓ ${fmtSize(progress.done)}/${fmtSize(progress.total || 1)}`]),
  ]);
  let folders: string[];
  try {
    folders = await install(entry, f, progress, workdir);
  } catch (e: any) {
    live.stop();
    println(`${bullet("err")} ${BOLD}Install${RESET}(${title})\n${result(e?.message ?? String(e), RED)}`);
    return 1;
  } finally {
    live.stop();
    removeIfEmpty(workdir);
  }
  Object.assign(entry, { file_id: f.id, file_name: f.name, version: prettyVersion(f), folders, updated_at: stamp() });
  state.addons[pid] = entry;
  saveState(state);
  println(`${bullet("ok")} ${BOLD}Install${RESET}(${title})`);
  println(result(`${folders.length} folder${folders.length !== 1 ? "s" : ""}: ${folders.join(", ")}`));
  println();
  await finale(`DING! ${title} joined the party · wu now tracks ${Object.keys(state.addons).length} addons`);
  return 0;
}

export function cmdList(): number {
  const state = loadState();
  const addons = Object.entries(state.addons).sort((a, b) => a[1].title.toLowerCase().localeCompare(b[1].title.toLowerCase()));
  const width = Math.max(0, ...addons.map(([, a]) => a.title.length));
  const vwidth = Math.max(0, ...addons.map(([, a]) => (a.version || "not installed").length));
  println(`${bullet("ok")} ${BOLD}Tracked addons${RESET}(${addons.length})`);
  if (!addons.length) println(result(rich("Nothing yet. Try `wu import` or `wu search`.")));
  addons.forEach(([pid, a], i) => {
    const ver = (a.version || "not installed").padEnd(vwidth);
    const when = a.updated_at ? `  ${GRAY}${a.updated_at}${RESET}` : "";
    println(`${lead(i)}${a.title.padEnd(width)}  ${CLAUDE}${ver}${RESET}${when}  ${GRAY}#${pid}${RESET}`);
  });
  return 0;
}
