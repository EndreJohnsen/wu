// Download a CurseForge file, unzip it (built-in reader: stored + deflate, zip64), and swap the
// addon folders in with a rollback.
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync as fsRename, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { type CfFile, cdnUrl } from "./curseforge";
import { addonsDir } from "./paths";
import { UA } from "./version";

export type Progress = { done: number; total: number; phase: string };

const BUSY = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]);

/** rename, retried for a moment: on Windows a virus scanner or Explorer can hold a fresh file briefly. */
export function renameSync(from: string, to: string): void {
  for (let i = 0; ; i++) {
    try {
      return fsRename(from, to);
    } catch (e: any) {
      if (i >= 8 || !BUSY.has(e?.code) || process.platform !== "win32") throw e;
      Bun.sleepSync(60 * (i + 1));
    }
  }
}

/** Delete a tree without ever following symlinks out of it. */
export function rmTree(p: string): void {
  let st;
  try {
    st = lstatSync(p);
  } catch {
    return;
  }
  if (st.isDirectory()) {
    for (const name of readdirSync(p)) rmTree(join(p, name));
    rmdirSync(p);
  } else {
    try {
      unlinkSync(p);
    } catch (e: any) {
      if (e?.code !== "EPERM") throw e;
      chmodSync(p, 0o666); // Windows: read-only files can't be deleted until made writable
      unlinkSync(p);
    }
  }
}

export async function download(f: CfFile, progress: Progress): Promise<Uint8Array> {
  const res = await fetch(cdnUrl(f), { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15 * 60 * 1000) });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  progress.total = Number(res.headers.get("content-length")) || Number(f.filesize) || 0;
  const chunks: Uint8Array[] = [];
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
    progress.done += chunk.length;
  }
  const buf = Buffer.concat(chunks);
  if (f.filesize && Number(f.filesize) !== buf.length) throw new Error(`size mismatch: got ${buf.length}, expected ${f.filesize}`);
  return buf;
}

type ZipEntry = { name: string; method: number; crc: number; csize: number; size: number; offset: number };

function readZip(buf: Uint8Array): ZipEntry[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u16 = (o: number) => dv.getUint16(o, true);
  const u32 = (o: number) => dv.getUint32(o, true);
  const u64 = (o: number) => Number(dv.getBigUint64(o, true));
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (u32(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file");
  let count = u16(eocd + 10);
  let cdOff = u32(eocd + 16);
  if ((count === 0xffff || cdOff === 0xffffffff) && eocd >= 20 && u32(eocd - 20) === 0x07064b50) {
    const z64 = u64(eocd - 20 + 8); // zip64 end of central directory record
    if (u32(z64) === 0x06064b50) {
      count = u64(z64 + 32);
      cdOff = u64(z64 + 48);
    }
  }
  const dec = new TextDecoder();
  const out: ZipEntry[] = [];
  let p = cdOff;
  for (let n = 0; n < count; n++) {
    if (u32(p) !== 0x02014b50) throw new Error("corrupt zip directory");
    const method = u16(p + 10);
    const crc = u32(p + 16);
    let csize = u32(p + 20);
    let size = u32(p + 24);
    const nameLen = u16(p + 28);
    const extraLen = u16(p + 30);
    const commentLen = u16(p + 32);
    let offset = u32(p + 42);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    for (let e = p + 46 + nameLen; e < p + 46 + nameLen + extraLen; ) {
      const id = u16(e);
      const len = u16(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) (size = u64(q)), (q += 8);
        if (csize === 0xffffffff) (csize = u64(q)), (q += 8);
        if (offset === 0xffffffff) offset = u64(q);
      }
      e += 4 + len;
    }
    out.push({ name, method, crc, csize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Extract addon folders; returns the top-level folder names. Rejects unsafe paths, checks CRCs. */
export async function extract(buf: Uint8Array, dest: string): Promise<string[]> {
  const entries = readZip(buf);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tops = new Set<string>();
  const keep: ZipEntry[] = [];
  for (const e of entries) {
    const parts = e.name.split("/").filter(Boolean);
    if (e.name.startsWith("/") || e.name.includes("\\") || parts.includes("..") || /^[A-Za-z]:/.test(e.name)) {
      throw new Error(`unsafe path in zip: ${e.name}`);
    }
    if (parts.length === 1 && !e.name.endsWith("/")) continue; // stray top-level file, not an addon folder
    if (!parts.length) continue;
    tops.add(parts[0]!);
    keep.push(e);
  }
  if (!tops.size) throw new Error("zip has no addon folders");
  let last = performance.now();
  for (const e of keep) {
    const target = join(dest, e.name);
    if (e.name.endsWith("/")) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    if (dv.getUint32(e.offset, true) !== 0x04034b50) throw new Error(`corrupt zip entry: ${e.name}`);
    const start = e.offset + 30 + dv.getUint16(e.offset + 26, true) + dv.getUint16(e.offset + 28, true);
    const raw = buf.subarray(start, start + e.csize);
    let data: Uint8Array;
    if (e.method === 0) data = raw;
    else if (e.method === 8) data = inflateRawSync(raw);
    else throw new Error(`unsupported zip compression (${e.method}) in ${e.name}`);
    if (data.length !== e.size || (Bun.hash.crc32(data) >>> 0) !== e.crc >>> 0) throw new Error(`checksum failed: ${e.name}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    if (performance.now() - last > 50) {
      await Bun.sleep(0); // keep the cast bar moving through big zips
      last = performance.now();
    }
  }
  return [...tops].sort();
}

/** Move old folders aside, move new ones in; on any failure put everything back. */
function swapIn(staging: string, folders: string[], oldFolders: string[], backup: string): void {
  const movedOld: string[] = [];
  const movedNew: string[] = [];
  const target = addonsDir();
  try {
    for (const name of [...new Set([...folders, ...oldFolders])].sort()) {
      const t = join(target, name);
      let exists = false;
      try {
        lstatSync(t);
        exists = true;
      } catch {}
      if (exists) {
        renameSync(t, join(backup, name));
        movedOld.push(name);
      }
    }
    for (const name of folders) {
      renameSync(join(staging, name), join(target, name));
      movedNew.push(name);
    }
  } catch (e) {
    for (const name of movedNew) rmTree(join(target, name));
    for (const name of movedOld) renameSync(join(backup, name), join(target, name));
    throw e;
  }
}

/** `keep(backupDir)` gets the old folders after a successful swap (the soulstone moves them in). */
export async function install(entry: { folders?: string[] }, f: CfFile, progress: Progress, workdir: string, keep?: (backup: string) => void): Promise<string[]> {
  mkdirSync(workdir, { recursive: true });
  const tmp = mkdtempSync(join(workdir, "job-"));
  try {
    const buf = await download(f, progress);
    progress.phase = "unpacking";
    const staging = join(tmp, "staging");
    mkdirSync(staging);
    const folders = await extract(buf, staging);
    const backup = join(tmp, "backup");
    mkdirSync(backup);
    progress.phase = "installing";
    swapIn(staging, folders, entry.folders ?? [], backup);
    try {
      keep?.(backup);
    } catch {} // a backup hiccup must never undo a good install
    return folders;
  } finally {
    rmTree(tmp);
  }
}

export function removeIfEmpty(dir: string): void {
  try {
    if (existsSync(dir) && !readdirSync(dir).length) rmdirSync(dir);
  } catch {}
}
