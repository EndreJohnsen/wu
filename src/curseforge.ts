// CurseForge data: file lists via cfwidget, search + project details via curse.tools.
import { GAME_VERSION } from "./paths";
import { UA } from "./version";

export const CF_API = "https://api.curse.tools/v1/cf"; // keyless proxy of the official CurseForge API

export type CfFile = {
  id: number;
  name: string;
  display?: string;
  type?: string;
  versions?: string[];
  filesize?: number;
  uploaded_at?: string;
};
export type Project = { id: number; title?: string; files: CfFile[] };

export async function getJson(url: string, timeoutMs = 20000): Promise<{ status: number; data: any }> {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {}
  return { status: res.status, data };
}

/** ref: numeric project id or "wow/addons/<slug>". */
export async function fetchProject(ref: string): Promise<Project> {
  const url = `https://api.cfwidget.com/${ref}`;
  let last = "";
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const { status, data } = await getJson(url, 30000);
      if (status === 404) throw Object.assign(new Error("not found on CurseForge mirror"), { final: true });
      if (status === 200 && Array.isArray(data.files)) return data as Project;
      last = data.error || `HTTP ${status}`;
    } catch (e: any) {
      if (e?.final) throw e;
      last = e?.message ?? String(e);
    }
    await Bun.sleep(2000 + attempt * 2000); // cfwidget queues fresh lookups; give it a moment
  }
  throw new Error(`mirror didn't answer (${last})`);
}

export function pickFile(data: Project): CfFile | null {
  const files = data.files.filter((f) => (f.versions ?? []).includes(GAME_VERSION));
  for (const channel of ["release", "beta", "alpha"]) {
    const pool = files.filter((f) => f.type === channel);
    if (pool.length) return pool.reduce((a, b) => ((b.uploaded_at ?? "") > (a.uploaded_at ?? "") ? b : a));
  }
  return null;
}

export function prettyVersion(f: { display?: string; name?: string }): string {
  const s = (f.display || f.name || "?").replace(/\.zip$/, "");
  return /\d[\w.\-]*/.exec(s)?.[0] ?? s;
}

export function cdnUrl(f: CfFile): string {
  const id = Number(f.id);
  return `https://edge.forgecdn.net/files/${Math.trunc(id / 1000)}/${id % 1000}/${encodeURIComponent(f.name)}`;
}

export const SORTS: [number, string][] = [[6, "most downloads"], [3, "most recent"]]; // CurseForge sortField ids

export async function searchCf(query: string, sortField: number, page: number, size = 10, forever = true): Promise<{ items: any[]; total: number }> {
  const params = new URLSearchParams({ gameId: "1", sortField: String(sortField), sortOrder: "desc", pageSize: String(size), index: String(page * size) });
  if (forever) params.set("gameVersion", GAME_VERSION);
  if (query) params.set("searchFilter", query);
  const { status, data } = await getJson(`${CF_API}/mods/search?${params}`);
  if (status !== 200) throw new Error(`HTTP ${status}`);
  return { items: data.data ?? [], total: Number(data.pagination?.totalCount ?? 0) };
}

export async function cfMod(id: string | number): Promise<any> {
  const { status, data } = await getJson(`${CF_API}/mods/${id}`);
  if (status !== 200 || !data.data) throw new Error(`HTTP ${status}`);
  return data.data;
}

/** Latest file upload, which is what CurseForge's "most recent" sort orders by. */
export const released = (m: any) => m.dateReleased || m.dateModified;

export type ForeverFile = { id: number; name: string; display: string; modules: string[] };

/** The newest WoW Forever build of a CurseForge mod object, with the folder names it ships. */
export function foreverFile(mod: any): ForeverFile | null {
  const idx = (mod.latestFilesIndexes ?? []).filter((i: any) => i.gameVersion === GAME_VERSION);
  if (!idx.length) return null;
  const best = [...idx].sort((a: any, b: any) => (a.releaseType ?? 9) - (b.releaseType ?? 9) || Number(b.fileId) - Number(a.fileId))[0];
  const files = new Map<number, any>((mod.latestFiles ?? []).map((f: any) => [f.id, f]));
  const f = files.get(best.fileId) ?? {};
  let modules: string[] = (f.modules ?? []).map((m: any) => m.name).filter(Boolean);
  if (!modules.length) {
    // file not in latestFiles: folder names rarely change between files
    modules = [...new Set([...files.values()].flatMap((lf: any) => (lf.modules ?? []).map((m: any) => m.name)).filter(Boolean))].sort();
  }
  return { id: best.fileId, name: best.filename || f.fileName || "", display: f.displayName || best.filename || "", modules };
}
