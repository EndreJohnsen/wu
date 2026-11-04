// `wu help`
import { banner, finale } from "../engram";
import { CONFIG_FILE, GAME_VERSION, STATE_FILE, WOW_DIR, loadState, shortPath, tilde } from "../paths";
import { BOLD, CLAUDE, GRAY, RESET, bullet, hlCmd, lead, println, rich } from "../term";
import { versionLine } from "../version";

const COMMANDS: [string, string][] = [
  ["wu", "update every tracked addon"],
  ["wu --check", "look for updates, change nothing"],
  ["wu --force", "reinstall everything, even if up to date"],
  ["wu list", "show tracked addons and their versions"],
  ["wu search [words]", "find WoW Forever addons, pick 1-10 to install"],
  ["wu add <addon>", "install and track a new addon"],
  ["", "(a CurseForge link, slug, project id, or a share code)"],
  ["wu import", "match addons already in AddOns to CurseForge"],
  ["wu share", "copy a code with your addon list"],
  ["wu share_wtf", "the same, plus your addons' settings"],
  ["wu restore", "bring back addons/settings from before an update"],
  ["wu setup", "find WoW Forever by itself, or paste where it is"],
  ["wu update", "update wu itself"],
  ["wu --version", "print the installed version"],
  ["wu help", "this screen"],
];

const TIPS = [
  "If WoW is open while you update, type `/reload` in game afterwards",
  "In `wu search`: {↑↓} move · {1-9}/{0} install · {tab} most downloads ⇄ most recent · {←→} page",
  "In `wu import`: {y} accept · {n} deny · {←→} other matches · {enter} import",
  "Every real update casts a Soulstone first (old addons + WTF), the 5 newest are kept",
  "Shared settings land in your own WTF account folder, old files are backed up first",
  `Only WoW Forever builds (${GAME_VERSION}) are installed, newest stable first`,
  `Settings: \`${tilde(CONFIG_FILE)}\` · state: \`${tilde(STATE_FILE)}\``,
];

export async function cmdHelp(): Promise<number> {
  let n = 0;
  try {
    n = Object.keys(loadState().addons).length;
  } catch {}
  await banner(n, [versionLine(), `${GRAY}Keeps your WoW Forever addons fresh${RESET}`, `${GRAY}${n} addons tracked · ${shortPath(WOW_DIR)}${RESET}`]);
  const width = Math.max(...COMMANDS.map(([c]) => c.length)) + 3;
  println(`${bullet("ok")} ${BOLD}Commands${RESET}`);
  COMMANDS.forEach(([cmd, desc], i) => println(`${lead(i)}${hlCmd(cmd)}${" ".repeat(width - cmd.length)}${GRAY}${desc}${RESET}`));
  println();
  println(`${bullet("ok")} ${BOLD}Tips${RESET}`);
  TIPS.forEach((tip, i) => println(`${lead(i)}${rich(tip)}`));
  println();
  await finale("Try: wu search bags", `${CLAUDE}Try:${RESET} ${hlCmd("wu search bags", RESET)}`);
  return 0;
}
