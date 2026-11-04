# wu

A terminal addon manager for **World of Warcraft: Forever**. Update, search, import, share and
install addons from CurseForge, with a spinning ASCII engram and a WoW cast bar while it works.

![wu help](docs/wu-help.png)

## Install

All you need is [Bun](https://bun.sh).

```sh
bun add -g github:EndreJohnsen/wu
```

Then:

```sh
wu setup    # searches your disks for WoW Forever (Wine/Proton/Lutris/Bottles too), or paste the path
wu import   # adopt the addons you already have
wu          # keep everything up to date
```

When a new wu is out, it shows an **UPDATE AVAILABLE** badge and asks whether to update when
it starts. `wu update` does it any time.

## Commands

| Command | What it does |
| --- | --- |
| `wu` | update every tracked addon |
| `wu --check` | look for updates, change nothing |
| `wu --force` | reinstall everything, even if up to date |
| `wu list` | tracked addons and their installed versions |
| `wu search [words]` | top 10 WoW Forever addons for a search; `1`–`9`/`0` installs, `tab` switches most downloads ⇄ most recent, `←→` pages |
| `wu add <addon>` | install and track one addon (CurseForge link, slug or project id) |
| `wu add <code>` | install everything in a share code (plain `wu add` reads it from the clipboard) |
| `wu import [--yes]` | match the addons already in `Interface/AddOns` to CurseForge, then accept (`y`) or deny (`n`) each match |
| `wu share` | copy a code with your addon list to the clipboard |
| `wu share_wtf` | the same, plus your addons' settings |
| `wu setup [path]` | find WoW Forever by itself, or take a path: Linux, `C:\…` Windows paths, `file://` links, `Wow.exe` |
| `wu update` | update wu itself |
| `wu --version` | print the installed version |
| `wu help` | the screen above |

If WoW is running while you update, type `/reload` in game afterwards.

## Sharing settings safely

`wu share_wtf` shows every addon's saved settings before anything is copied, and you pick what
goes in. It never shares Blizzard's own settings, per-character files, or anything that looks
like private data: chat and whisper logs, ignore and friend lists, inventories and alts, price
and scan databases, or anything too big to be settings.

On the receiving side the settings go into **your own** WTF account folder, whatever it's called.
Only the shared variables are replaced, everything else in the file stays (your chat history,
your inventories). The old file is kept as `*.wu-backup-<date>`, and wu won't write while WoW
is running, because WoW rewrites those files when you log out.

## How it works

- Only **WoW Forever builds** (CurseForge game version `1.60.1`) are installed, newest stable first.
- File lists come from [cfwidget](https://api.cfwidget.com) and search from
  [curse.tools](https://api.curse.tools), a keyless proxy of the official CurseForge API.
  The CurseForge website itself blocks scripts.
- Downloads come straight from CurseForge's CDN (`edge.forgecdn.net`), are size- and
  CRC-checked, and swapped in with a rollback, so a failed install puts the previous version back.
- `wu import` matches folders by the CurseForge project id in their `.toc`, then by the folder
  names each project ships (so `Details_*` modules group under Details), then by name.

| What | Where |
| --- | --- |
| WoW path | `~/.config/wu/config.json` (or the `WU_DIR` environment variable) |
| Tracked addons | `~/.local/state/wu/state.json` |

Works on Linux and macOS terminals. Windows isn't supported; there the CurseForge app does the job.

## Releasing

Bump `version` in `package.json`, commit, then tag it: `git tag v<version> && git push --tags`.
`wu update` installs the tag. (It works around bun pinning GitHub installs to their first commit.)
