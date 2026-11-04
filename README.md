# wu

A terminal addon manager for **World of Warcraft: Forever**. Update, search, import, share and
install addons from CurseForge.

![wu help](docs/wu-help.png)

## Install

wu runs on [Bun](https://bun.com). Each pair of lines below installs the official Bun first,
then wu.

**Windows** (PowerShell or Command Prompt, either works):

```powershell
powershell -c "irm bun.sh/install.ps1|iex"
powershell -c "& (Convert-Path ~\.bun\bin\bun.exe) add -g github:EndreJohnsen/wu"
```

The first line is Bun's own installer. The second calls Bun by its full path, because the open
window doesn't know about Bun yet. Afterwards, **open a new terminal window** so it finds `wu`.

**Linux / macOS** (any terminal):

```sh
command -v bun >/dev/null || curl -fsSL https://bun.com/install | bash
export PATH="${BUN_INSTALL:-$HOME/.bun}/bin:$PATH" && bun add -g github:EndreJohnsen/wu
```

Already have Bun? Just `bun add -g github:EndreJohnsen/wu`. Then:

```sh
wu setup    # finds WoW Forever by itself (Battle.net, Wine/Proton/Lutris/Bottles, any drive), or paste the path
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
| `wu add <code>` | install everything in a share code (plain `wu add` picks it up from the clipboard, or asks you to paste it) |
| `wu import [--yes]` | match the addons already in `Interface/AddOns` to CurseForge, then accept (`y`) or deny (`n`) each match |
| `wu share` | copy a code with your addon list to the clipboard |
| `wu share_wtf` | the same, plus your addons' settings |
| `wu restore` | bring addons and/or WTF settings back from a Soulstone (taken before every update) |
| `wu setup [path]` | find WoW Forever by itself, or take a path: Linux or Windows paths (`%ProgramFiles(x86)%` works), `file://` links, `Wow.exe`. Offers to create `Interface/AddOns` if a fresh install doesn't have it yet |
| `wu update` | update wu itself |
| `wu --version` | print the installed version |
| `wu help` | the screen above |

If WoW is running while you update, type `/reload` in game afterwards.

## Soulstones (automatic backups)

Before every real update wu casts a **Soulstone**: the WTF folder (copied with reflinks where the
filesystem supports it, so it's near free on btrfs) plus the old versions of every addon it
replaces (moved, not copied, so it's instant). The five newest are kept in
`Interface/.wu/soulstones`. `wu restore` picks one and brings back the addons, the settings, or
both; it casts a fresh Soulstone first, so a restore can be undone too.

## Sharing

`wu share` puts a code on your clipboard; your friend runs plain `wu add`. Nothing extra needs
installing anywhere:

- **Windows / macOS:** wu uses the clipboard tools built into the system.
- **Linux:** wu reads the clipboard with `wl-clipboard`, `xclip` or `xsel` if one is installed,
  or by itself on X11 sessions. On Wayland without those tools the desktop doesn't let terminal
  programs read the clipboard in the background, so `wu add` opens a box and you paste the code
  (Ctrl+Shift+V). Copying falls back to asking the terminal, and the code is printed too in case
  the terminal ignores it.

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
| WoW path | `~/.config/wu/config.json` · Windows: `%APPDATA%\wu\config.json` (or the `WU_DIR` environment variable) |
| Tracked addons | `~/.local/state/wu/state.json` · Windows: `%LOCALAPPDATA%\wu\state.json` |

Works on Linux, macOS and Windows. On Windows, use Windows Terminal (the default on Windows 11).
If a console ever shows garbled output, `WU_PLAIN=1` turns off the animations and colors.

## If wu stops starting on Windows

`wu update` from v1.4.1 or older can leave Windows with a broken `wu` command: it says
"corrupted node_modules", and `bun add` fails with `EEXIST`. (Bun couldn't replace `wu.exe`
while it was running. v1.4.2 and newer avoid this.) Close any window running wu, then paste this
one line into PowerShell:

```powershell
Remove-Item ~/.bun/bin/wu.exe -Force; Remove-Item ~/.bun/bin/wu -Force -ErrorAction Ignore; bun remove -g @endrejohnsen/wu; bun add -g github:EndreJohnsen/wu; wu --version
```

The first part matters most: until that leftover `wu.exe` is gone, every `bun add` fails with
`EEXIST`, `--force` included. (wu isn't on npm, so `bun add -g @endrejohnsen/wu` gives a 404;
always use the `github:` form.) Sending it through Discord or another chat? Put it in a code
block, or the chat eats the `@endrejohnsen` (it becomes a mention) and any backslashes.

Your addons and settings aren't touched; they live in WoW's folder and `%LOCALAPPDATA%\wu`.

## Releasing

Bump `version` in `package.json`, commit, then tag it: `git tag v<version> && git push --tags`.
`wu update` installs the tag. (It works around bun pinning GitHub installs to their first commit.)
