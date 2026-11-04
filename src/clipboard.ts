// Clipboard on every platform without installing anything:
//   Windows: PowerShell Get-Clipboard / clip       macOS: pbpaste / pbcopy
//   Linux:   wl-paste / xclip / xsel when present, otherwise a tiny built-in X11 client that asks
//            the X server (or XWayland, which mirrors the Wayland clipboard) for CLIPBOARD as UTF-8.
// Copying falls back to OSC 52, which asks the terminal itself to set the clipboard.
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { TTY, write } from "./term";

type Tool = string[];

async function run(tool: Tool, input?: string): Promise<string | null> {
  if (!Bun.which(tool[0]!)) return null;
  try {
    const p = Bun.spawn(tool, { stdin: input !== undefined ? "pipe" : "ignore", stdout: "pipe", stderr: "ignore" });
    if (input !== undefined && p.stdin) {
      p.stdin.write(input);
      await p.stdin.end();
    }
    const out = input === undefined ? await new Response(p.stdout).text() : "";
    return (await p.exited) === 0 ? out : null;
  } catch {
    return null;
  }
}

function tools(dir: "copy" | "paste"): Tool[] {
  const t: Tool[] = [];
  if (process.platform === "win32") {
    t.push(...(dir === "copy" ? [["clip"]] : [["powershell", "-NoProfile", "-Command", "Get-Clipboard -Raw"], ["pwsh", "-NoProfile", "-Command", "Get-Clipboard -Raw"]]));
  } else if (process.platform === "darwin") {
    t.push(dir === "copy" ? ["pbcopy"] : ["pbpaste"]);
  } else {
    if (process.env.WAYLAND_DISPLAY) t.push(dir === "copy" ? ["wl-copy"] : ["wl-paste", "--no-newline"]);
    if (process.env.DISPLAY)
      t.push(...(dir === "copy" ? [["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]] : [["xclip", "-selection", "clipboard", "-o"], ["xsel", "--clipboard", "--output"]]));
  }
  return t;
}

/** Text on the clipboard, or "" if nothing readable is there. Never needs extra software. */
export async function readClipboard(): Promise<string> {
  for (const t of tools("paste")) {
    const out = await run(t);
    if (out !== null) return out.trim();
  }
  if (process.platform === "linux" && process.env.DISPLAY) return ((await x11Clipboard()) ?? "").trim();
  return "";
}

/** Copy text; returns what did it ("wl-copy", "clip", "terminal" …) or null. */
export async function copyToClipboard(text: string): Promise<string | null> {
  for (const t of tools("copy")) if ((await run(t, text)) !== null) return t[0]!;
  if (TTY && text.length < 90000) {
    write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`); // OSC 52: the terminal sets it
    return "terminal";
  }
  return null;
}

// ── a minimal X11 client: read the CLIPBOARD selection as UTF8_STRING ────────

const pad4 = (n: number) => (4 - (n % 4)) % 4;

/** MIT-MAGIC-COOKIE-1 for this display from ~/.Xauthority (or $XAUTHORITY), if there is one. */
function xauthCookie(display: string): Buffer | null {
  let buf: Buffer;
  try {
    buf = readFileSync(process.env.XAUTHORITY || join(homedir(), ".Xauthority"));
  } catch {
    return null;
  }
  const host = hostname();
  let i = 0;
  let fallback: Buffer | null = null;
  const field = () => {
    const len = buf.readUInt16BE(i);
    const v = buf.subarray(i + 2, i + 2 + len);
    i += 2 + len;
    return v;
  };
  try {
    while (i + 2 <= buf.length) {
      const family = buf.readUInt16BE(i);
      i += 2;
      const addr = field().toString("latin1");
      const num = field().toString("latin1");
      const name = field().toString("latin1");
      const data = field();
      if (name !== "MIT-MAGIC-COOKIE-1" || (num !== display && num !== "")) continue;
      if (family === 65535 || (family === 256 && addr === host)) return data; // wildcard or this host (local)
      fallback ??= data;
    }
  } catch {}
  return fallback;
}

/** Ask the X server for the clipboard. Returns null on any trouble (no X, no auth, not text, timeout). */
export function x11Clipboard(timeoutMs = 1500): Promise<string | null> {
  const m = /^(unix)?:(\d+)(\.\d+)?$/.exec(process.env.DISPLAY ?? "");
  if (!m) return Promise.resolve(null); // remote/TCP displays: not worth it
  const display = m[2]!;
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    let finished = false;
    let waiter: { n: number; resolve: () => void } | null = null;
    const sock = createConnection({ path: `/tmp/.X11-unix/X${display}` });
    const done = (v: string | null, why = "") => {
      if (process.env.WU_DEBUG && v === null) console.error(`x11 clipboard: ${why || "no result"}`);
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => done(null, "timeout"), timeoutMs);
    sock.on("error", (e) => done(null, `socket error ${e.message}`));
    sock.on("close", () => done(null, "socket closed"));
    sock.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (waiter && buf.length >= waiter.n) {
        const w = waiter;
        waiter = null;
        w.resolve();
      }
    });
    const need = async (n: number) => {
      if (buf.length < n) await new Promise<void>((r) => (waiter = { n, resolve: r }));
    };
    const take = async (n: number) => {
      await need(n);
      const out = buf.subarray(0, n);
      buf = buf.subarray(n);
      return out;
    };
    const send = (b: Buffer) => sock.write(b);

    (async () => {
      // connection setup, little-endian, protocol 11.0, optional cookie
      const cookie = xauthCookie(display);
      const authName = cookie ? Buffer.from("MIT-MAGIC-COOKIE-1") : Buffer.alloc(0);
      const authData = cookie ?? Buffer.alloc(0);
      const setup = Buffer.alloc(12 + authName.length + pad4(authName.length) + authData.length + pad4(authData.length));
      setup.write("l", 0, "latin1");
      setup.writeUInt16LE(11, 2);
      setup.writeUInt16LE(authName.length, 6);
      setup.writeUInt16LE(authData.length, 8);
      authName.copy(setup, 12);
      authData.copy(setup, 12 + authName.length + pad4(authName.length));
      send(setup);
      const head = await take(8);
      const extra = await take(head.readUInt16LE(6) * 4);
      if (head[0] !== 1) return done(null, `setup refused (${head[0]})`); // refused (auth) or needs more auth
      const idBase = extra.readUInt32LE(4);
      const vendorLen = extra.readUInt16LE(16);
      const nFormats = extra[21]!;
      const root = extra.readUInt32LE(32 + vendorLen + pad4(vendorLen) + nFormats * 8);

      let seq = 0;
      const internAtom = async (name: string) => {
        const n = Buffer.from(name, "latin1");
        const req = Buffer.alloc(8 + n.length + pad4(n.length));
        req[0] = 16; // InternAtom
        req.writeUInt16LE(req.length / 4, 2);
        req.writeUInt16LE(n.length, 4);
        n.copy(req, 8);
        send(req);
        seq++;
        const r = await take(32);
        if (r[0] !== 1) throw new Error("x11 error");
        return r.readUInt32LE(8);
      };
      const CLIPBOARD = await internAtom("CLIPBOARD");
      const UTF8 = await internAtom("UTF8_STRING");
      const PROP = await internAtom("WU_CLIPBOARD");
      const STRING = 31;

      const win = idBase | 1;
      const cw = Buffer.alloc(32);
      cw[0] = 1; // CreateWindow, depth 0 (InputOnly)
      cw.writeUInt16LE(8, 2);
      cw.writeUInt32LE(win, 4);
      cw.writeUInt32LE(root, 8);
      cw.writeUInt16LE(1, 16); // width
      cw.writeUInt16LE(1, 18); // height
      cw.writeUInt16LE(2, 22); // class InputOnly
      send(cw);
      const cs = Buffer.alloc(24);
      cs[0] = 24; // ConvertSelection
      cs.writeUInt16LE(6, 2);
      cs.writeUInt32LE(win, 4);
      cs.writeUInt32LE(CLIPBOARD, 8);
      cs.writeUInt32LE(UTF8, 12);
      cs.writeUInt32LE(PROP, 16);
      send(cs);

      for (;;) {
        // wait for SelectionNotify (event 31); an error (0) means the request failed
        const ev = await take(32);
        if (ev[0] === 0) return done(null, `x11 error ${ev[1]} on request ${ev[10]}`);
        if ((ev[0]! & 0x7f) !== 31) continue;
        if (ev.readUInt32LE(20) === 0) return done(null, "selection refused"); // nobody owns the clipboard, or not text
        break;
      }
      const gp = Buffer.alloc(24);
      gp[0] = 20; // GetProperty, delete after reading
      gp[1] = 1;
      gp.writeUInt16LE(6, 2);
      gp.writeUInt32LE(win, 4);
      gp.writeUInt32LE(PROP, 8);
      gp.writeUInt32LE(0, 12); // AnyPropertyType
      gp.writeUInt32LE(0, 16);
      gp.writeUInt32LE(4 * 1024 * 1024 / 4, 20); // up to 4 MB
      send(gp);
      const rep = await take(32);
      if (rep[0] !== 1) return done(null, "GetProperty failed");
      const body = await take(rep.readUInt32LE(4) * 4);
      const type = rep.readUInt32LE(8);
      const len = rep.readUInt32LE(16) * (rep[1]! / 8);
      if (type !== UTF8 && type !== STRING) return done(null, `property type ${type}`); // e.g. INCR for huge data
      done(body.subarray(0, len).toString(type === UTF8 ? "utf8" : "latin1"));
      void seq;
    })().catch((e) => done(null, `exception ${e?.message ?? e}`));
  });
}
