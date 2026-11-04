// `wu` / `wu --check` / `wu --force`: check every tracked addon and install what's newer.
import { join } from "node:path";
import { type CfFile, type Project, fetchProject, pickFile, prettyVersion } from "../curseforge";
import { banner, finale } from "../engram";
import { install, removeIfEmpty } from "../install";
import { type Entry, GAME_VERSION, WOW_DIR, acquireLock, addonsDir, isDir, loadState, saveState, tilde, wowRunning } from "../paths";
import {
  BOLD, CLAUDE, DONE_VERBS, GRAY, GREEN, IDLE_VERBS, RED, RESET, STRIKE, Spinner, WHITE, YELLOW, bullet, choice, fmtDur,
  fmtSize, hlCmd, lead, live, println, result, rich, stamp,
} from "../term";

type Check = { ok: true; data: Project; file: CfFile | null } | { ok: false; error: string };

/** Run at most `n` async jobs at once. */
export function limiter(n: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(job: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((r) => queue.push(r));
    active++;
    try {
      return await job();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

function startChecks(addons: Record<string, Entry>): Map<string, Promise<Check>> {
  const lim = limiter(6);
  return new Map(
    Object.keys(addons).map((pid) => [
      pid,
      lim(() => fetchProject(pid)).then(
        (data): Check => ({ ok: true, data, file: pickFile(data) }),
        (e): Check => ({ ok: false, error: e?.message ?? String(e) }),
      ),
    ]),
  );
}

async function checkAll(addons: Record<string, Entry>, checks: Map<string, Promise<Check>>): Promise<Map<string, Check>> {
  const results = new Map<string, Check>();
  const pending = new Map(Object.entries(addons).map(([pid, a]) => [pid, a.title]));
  const n = Object.keys(addons).length;
  const spin = new Spinner();
  live.start((f) => {
    const waiting = pending.values().next().value ?? "";
    return [
      `${bullet("run", f)} ${BOLD}Check${RESET}(${n} addons)`,
      result(`${results.size}/${n} checked` + (waiting ? ` · asking about ${waiting}` : "")),
      "",
      spin.line(f),
    ];
  });
  try {
    await Promise.all([...checks].map(([pid, p]) => p.then((r) => (results.set(pid, r), pending.delete(pid)))));
  } finally {
    live.stop();
  }
  return results;
}

export async function cmdUpdate(args: string[]): Promise<number> {
  acquireLock();
  const checkOnly = args.includes("--check");
  const force = args.includes("--force");
  const state = loadState();
  const addons = state.addons;
  const t0 = Date.now();
  const found = isDir(WOW_DIR);

  if (!Object.keys(addons).length) {
    await banner(0);
    println(`${bullet("ok")} ${BOLD}Welcome${RESET}`);
    println(result("wu isn't tracking any addons yet. Start with one of these:"));
    for (const [cmd, desc] of [
      ["wu import", "adopt the addons already in your AddOns folder"],
      ["wu search bags", "find WoW Forever addons and install one"],
      ["wu setup", "if wu found the wrong WoW folder"],
    ] as const) println(`     ${hlCmd(cmd)}${" ".repeat(16 - cmd.length)}${GRAY}${desc}${RESET}`);
    return 0;
  }

  const checks = found ? startChecks(addons) : null; // runs while the engram spins
  await banner(Object.keys(addons).length);
  if (!found || !checks) {
    live.log(`${bullet("err")} Can't find WoW Forever at ${tilde(WOW_DIR)}`);
    live.log(result(rich("Run `wu setup` and let it search, or paste where it lives now.", RED), RED));
    return 1;
  }
  if (wowRunning() && !checkOnly) {
    live.log(`${bullet("warn")} WoW is running`);
    live.log(result(rich("Files update on disk now; type `/reload` in game (or relog) to load them.", YELLOW), YELLOW));
    live.log();
  }

  const results = await checkAll(addons, checks);
  const todo: { pid: string; a: Entry; f: CfFile }[] = [];
  const errors: [string, string][] = [];
  const fresh: string[] = [];
  for (const [pid, a] of Object.entries(addons)) {
    const r = results.get(pid) ?? { ok: false, error: "no answer" };
    if (!r.ok) errors.push([a.title, r.error]);
    else if (!r.file) errors.push([a.title, `no WoW Forever (${GAME_VERSION}) build published`]);
    else {
      a.title = r.data.title || a.title;
      const folders = a.folders ?? [];
      const missing = !folders.length || !folders.every((d) => isDir(join(addonsDir(), d)));
      if (force || missing || a.file_id !== r.file.id) todo.push({ pid, a, f: r.file });
      else fresh.push(a.title);
    }
  }

  live.log(`${bullet(errors.length ? "warn" : "ok")} ${BOLD}Check${RESET}(${Object.keys(addons).length} addons)`);
  live.log(result(`${todo.length} update${todo.length !== 1 ? "s" : ""} available · ${fresh.length} up to date`));
  for (const [title, why] of errors) live.log(`     ${RED}✗ ${title}: ${why}${RESET}`);
  live.log();

  if (checkOnly) {
    for (const { a, f } of todo) live.log(`  ${CLAUDE}↑${RESET} ${a.title}  ${GRAY}${a.version || "new"} → ${RESET}${prettyVersion(f)}`);
    if (todo.length) {
      live.log();
      live.log(rich("Run `wu` to install them."));
    }
    saveState(state);
    return errors.length ? 1 : 0;
  }

  const done: string[] = [];
  const failed: [string, string][] = [];
  if (todo.length) {
    const width = Math.max(...todo.map((t) => t.a.title.length));
    const prev = new Map(todo.map((t) => [t.pid, t.a.version || "new"])); // before install overwrites it
    const status = new Map(todo.map((t) => [t.pid, "todo" as "todo" | "run" | "done" | "fail"]));
    const notes = new Map<string, string>();
    const progress = { done: 0, total: 0, phase: "downloading" };
    const spin = new Spinner();
    const workdir = join(WOW_DIR, "Interface", ".wu");

    const todoLines = (frame: number, final = false) => {
      const head = final ? (failed.length ? "err" : "ok") : "run";
      const out = [`${bullet(head, frame)} ${BOLD}Update Todos${RESET}`];
      todo.forEach(({ pid, a, f }, i) => {
        const pad = a.title.padEnd(width);
        const ver = `${prev.get(pid)} → ${prettyVersion(f)}`;
        const st = status.get(pid);
        let body: string;
        if (st === "done") body = `${GREEN}☒ ${STRIKE}${pad}${RESET}  ${GRAY}${ver}${RESET}`;
        else if (st === "fail") body = `${RED}✗ ${pad}  ${notes.get(pid) ?? ""}${RESET}`;
        else if (st === "run") {
          const frac = Math.min(1, progress.done / (progress.total || 1));
          const bar = "▰".repeat(Math.round(frac * 10)) + "▱".repeat(10 - Math.round(frac * 10));
          body = `${CLAUDE}■ ${BOLD}${pad}${RESET}  ${GRAY}${ver}${RESET}  ${CLAUDE}${bar}${RESET} ${GRAY}${progress.phase}${RESET}`;
        } else body = `${WHITE}☐ ${pad}${RESET}  ${GRAY}${ver}${RESET}`;
        out.push(lead(i) + body);
      });
      return out;
    };

    live.start((f) => {
      const extras = progress.total ? [`↓ ${fmtSize(progress.done)}/${fmtSize(progress.total)}`] : [];
      return [...todoLines(f), "", spin.line(f, extras)];
    });
    try {
      for (const { pid, a, f } of todo) {
        status.set(pid, "run");
        Object.assign(progress, { done: 0, total: Number(f.filesize) || 0, phase: "downloading" });
        try {
          const folders = await install(a, f, progress, workdir);
          Object.assign(a, { file_id: f.id, file_name: f.name, version: prettyVersion(f), folders, updated_at: stamp() });
          saveState(state);
          status.set(pid, "done");
          done.push(a.title);
        } catch (e: any) {
          status.set(pid, "fail");
          notes.set(pid, String(e?.message ?? e).slice(0, 80));
          failed.push([a.title, String(e?.message ?? e)]);
        }
      }
    } finally {
      live.stop();
      removeIfEmpty(workdir);
    }
    for (const l of todoLines(0, true)) live.log(l);
    live.log();
  }

  saveState(state);
  const took = fmtDur((Date.now() - t0) / 1000);
  if (failed.length || errors.length) {
    await finale(`${choice(DONE_VERBS)} for ${took} · ${done.length} updated · ${failed.length + errors.length} had trouble (see above)`);
    return 1;
  }
  if (done.length) {
    await finale(`${choice(DONE_VERBS)} for ${took} · DING! ${done.length} addon${done.length !== 1 ? "s" : ""} leveled up · ${fresh.length} already fresh`);
  } else await finale(`${choice(IDLE_VERBS)} for ${took} · all ${fresh.length} addons are already fresh`);
  return 0;
}
