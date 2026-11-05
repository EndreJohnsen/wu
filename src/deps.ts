// Required dependencies, the way the CurseForge app handles them: Questie needs QuestieDB, so
// installing or updating Questie brings QuestieDB along. (Embedded libraries aren't separate installs.)
import { type CfFile, type Project, fetchProject, pickFile, requiredDeps } from "./curseforge";

export type Needed = { pid: string; title: string; data: Project | null; file: CfFile | null; neededBy: string };
type Root = { pid: string; file: CfFile; title: string };

/** Required dependencies of `roots` that aren't in `tracked`, followed down a few levels. */
export async function missingDeps(roots: Root[], tracked: Set<string>): Promise<Needed[]> {
  const out: Needed[] = [];
  const seen = new Set(tracked);
  let wave = roots;
  for (let depth = 0; wave.length && depth < 4; depth++) {
    const lists = await Promise.all(wave.map((r) => requiredDeps(r.pid, r.file))); // usually known already
    const asks: Promise<void>[] = [];
    const next: Root[] = [];
    wave.forEach((r, i) => {
      for (const d of lists[i]!.map(String)) {
        if (seen.has(d)) continue;
        seen.add(d);
        asks.push(
          fetchProject(d).then(
            (data) => {
              const file = pickFile(data);
              const title = data.title || `project ${d}`;
              out.push({ pid: d, title, data, file, neededBy: r.title });
              if (file) next.push({ pid: d, file, title });
            },
            () => void out.push({ pid: d, title: `project ${d}`, data: null, file: null, neededBy: r.title }),
          ),
        );
      }
    });
    await Promise.all(asks);
    wave = next;
  }
  return out;
}
