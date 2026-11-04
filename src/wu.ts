#!/usr/bin/env bun
// wu: a terminal addon manager for World of Warcraft: Forever.
import { writeSync } from "node:fs";
import { cmdAdd, cmdList } from "./commands/add";
import { cmdHelp } from "./commands/help";
import { cmdImport } from "./commands/import";
import { cmdRestore } from "./commands/restore";
import { cmdSearch } from "./commands/search";
import { cmdSetup } from "./commands/setup";
import { applyShare, cmdShare, isShareCode } from "./commands/share";
import { readClipboard } from "./clipboard";
import { cmdUpdate } from "./commands/update";
import { autodetectWowDir } from "./paths";
import { BOLD, RED, RESET, TTY, bullet, hlCmd, interrupt, println, promptBox, result, rich } from "./term";
import { VERSION, bootPrompt, checkForUpdate, selfUpdate } from "./version";

const HELP = ["-h", "--help", "help", "-help", "?"];
const VERSIONS = ["--version", "-V", "version"];

async function main(argv: string[]): Promise<number> {
  const cmd = argv[0] ?? "";
  if (VERSIONS.includes(cmd)) {
    const newer = await checkForUpdate(false, 800);
    println(`wu ${VERSION}` + (newer ? rich(` (v${newer} is out · run \`wu update\`)`) : ""));
    return 0;
  }
  if (cmd === "update" || cmd === "self-update" || cmd === "upgrade") {
    const ok = await selfUpdate();
    if (ok) println(rich("Run `wu` to update your addons with the new version."));
    return ok ? 0 : 1;
  }

  await checkForUpdate(); // cached for an hour; feeds the banner badge and the boot prompt
  if (!argv.includes("--yes")) {
    const rc = await bootPrompt(argv);
    if (rc !== null) return rc;
  }
  if (!HELP.includes(cmd) && cmd !== "setup") autodetectWowDir();

  if (HELP.includes(cmd)) return cmdHelp();
  switch (cmd) {
    case "list":
      return cmdList();
    case "add": {
      const rest = argv.slice(1).filter((a) => a !== "--yes");
      const code = rest.find(isShareCode);
      if (code) return applyShare(code, argv);
      if (!rest.length) {
        // a friend's share code on the clipboard? use it; otherwise ask for one (or an addon)
        const clip = await readClipboard();
        if (isShareCode(clip)) return applyShare(clip, argv);
        if (TTY && process.stdin.isTTY) {
          println(`${bullet("ok")} ${BOLD}Add${RESET}`);
          println(result("No share code on your clipboard. Paste one, or an addon name or CurseForge link:"));
          println();
          const typed = (await promptBox("e.g. wu1.… from a friend, questie, or https://www.curseforge.com/wow/addons/…")).trim();
          if (!typed) return 0;
          if (isShareCode(typed)) return applyShare(typed, argv);
          return cmdAdd([typed]);
        }
      }
      return cmdAdd(rest);
    }
    case "search":
    case "find":
    case "s":
      return cmdSearch(argv.slice(1));
    case "setup":
      return cmdSetup(argv.slice(1));
    case "import":
      return cmdImport(argv.slice(1));
    case "share":
      return cmdShare(argv.includes("--wtf") || argv.includes("wtf"));
    case "restore":
    case "soulstone":
      return cmdRestore(argv.slice(1));
    case "share_wtf":
    case "share-wtf":
      return cmdShare(true);
  }
  const unknown = argv.filter((a) => a !== "--check" && a !== "--force");
  if (unknown.length) {
    println(`${RED}●${RESET} unknown command: ${hlCmd(unknown.join(" "), RESET)}  ` + rich("(try `wu help`)"));
    return 2;
  }
  return cmdUpdate(argv);
}

process.on("SIGINT", () => interrupt());
process.on("exit", () => {
  if (TTY) writeSync(1, "\x1b[?25h");
});

let code = 1;
try {
  code = await main(process.argv.slice(2));
} catch (e: any) {
  println(`${RED}●${RESET} ${e?.message ?? e}`);
  if (process.env.WU_DEBUG) console.error(e);
}
process.exit(code);
