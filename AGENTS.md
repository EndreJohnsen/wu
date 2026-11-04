# Agent notes for wu

wu is a terminal addon manager for WoW Forever, written in TypeScript and run by Bun only
(no Python, no runtime npm dependencies). It supports Linux, macOS and Windows. Users install it
from this GitHub repo with `bun add -g github:EndreJohnsen/wu` (which takes `main`, so `main` must
always work) and upgrade with `wu update` (which takes the newest tag).

## Releasing a new version

Every change that users should get must be released, or nobody receives it: `wu update`, the
UPDATE AVAILABLE badge and the startup prompt all look at **git tags**, not at `main`.

1. Make the change, then run the checks below. Both must pass.
2. Bump `version` in `package.json` (semver: patch for fixes, minor for new features or
   commands). The running version is read from `package.json`, so this is the only place to change.
3. Commit: `git commit -am "wu X.Y.Z: <what changed>"`
4. Tag it with the same version, prefixed with `v`: `git tag vX.Y.Z`
5. Push both: `git push origin main --tags`
6. Confirm the tag is visible:
   `curl -s https://api.github.com/repos/EndreJohnsen/wu/tags | grep '"name"' | head -3`

Users then see the badge and the "update now?" prompt within an hour (the check is cached that
long), and `wu update` installs `github:EndreJohnsen/wu#vX.Y.Z`.

Rules:
- The tag must equal `package.json`'s version exactly (`1.3.0` → `v1.3.0`).
- Never move, reuse or delete a published tag; installed copies are pinned to them. Fix forward
  with a new patch version.
- Docs-only changes (README, this file) need no version bump or tag; commit and push.

## Checks before every release

```sh
bunx tsc --noEmit --noUnusedLocals   # must print nothing
bun src/wu.ts --version              # prints the new version
bun src/wu.ts help                   # banner + help render without errors
```

Test anything that touches files in a sandbox, never against a real WoW install or the real
`~/.local/state/wu`. The shell profile may export `XDG_STATE_HOME`/`XDG_CONFIG_HOME`, so
overriding `HOME` alone is not enough. Set all of these:

```sh
export WU_DIR=/tmp/wu-sandbox/_forever_ XDG_STATE_HOME=/tmp/wu-sandbox/state \
       XDG_CONFIG_HOME=/tmp/wu-sandbox/config HOME=/tmp/wu-sandbox/home WU_NO_UPDATE_CHECK=1
unset WAYLAND_DISPLAY DISPLAY   # so share tests don't overwrite the real clipboard
```

Use copied addon folders in the sandbox, not symlinks to a real `AddOns` folder.

**Windows** can be tested from Linux by running Bun's Windows build under Wine, where
`process.platform` really is `win32`: download `bun-windows-x64-baseline.zip` from Bun's GitHub
releases, make a fresh `WINEPREFIX` (`wineboot -i`), copy `src/` and `package.json` to its
`drive_c`, fake a WoW install at `drive_c/Program Files (x86)/World of Warcraft/_forever_`, unset
the `XDG_*` variables, and run `wine bun.exe 'C:\wu\src\wu.ts' <command>`. Ignore Wine's
`MESA-EGL` lines and Bun's "directory mismatch" notes; Wine's console also garbles some redraws,
so judge the interactive look on real Windows Terminal, not Wine.

Keep paths portable: build them with `node:path` `join`, split with `/[\\/]/`, and never assume
`/` or a home-relative layout (Windows keeps config in `%APPDATA%\wu` and state in
`%LOCALAPPDATA%\wu`).

## Things that look odd but are deliberate

- **Self-update scrubs bun's lockfile.** Bun 1.4 keeps global GitHub installs pinned to their
  first commit, and `bun remove -g` leaves the lock entry behind. `selfUpdate()` in
  `src/version.ts` removes only the lines mentioning `@endrejohnsen/wu` from
  `~/.bun/install/global/bun.lock`, then adds the new tag. Don't touch other packages there.
- **On Windows, self-update renames the running `wu.exe` aside first** (`parkShim()` in
  `src/version.ts`). Bun's `wu.exe` shim waits for wu, so it's locked: `bun remove` would delete
  `wu.bunx` but not `wu.exe`, and Bun refuses (`EEXIST`) to link over an `.exe` that has no `.bunx`.
  A running `.exe` can be renamed, just not deleted. Leftover `wu.exe.old-*` files are removed on
  the next update.
- **Old Windows consoles get look-alike symbols** (`SAFE` in `src/term.ts`): outside Windows
  Terminal, conhost's bitmap fonts print `?` for `●`, `⎿`, `❯` and friends. New symbols in the UI
  need an entry there (one character for one).
- **Version check uses the GitHub tags API**, with `raw.githubusercontent.com` only as a
  fallback; the raw CDN serves stale files for minutes after a push.
- **CurseForge's own site blocks scripts.** File lists come from `api.cfwidget.com`, search from
  `api.curse.tools/v1/cf`, downloads from `edge.forgecdn.net`. WoW Forever is game version
  `1.60.1` (TOC interface `16001`, flavor suffix `_Camelot`).
- **Zip extraction is built in** (`src/install.ts`) with CRC checks; don't add an unzip dependency.

## Look and feel (keep it)

- The banner is a spinning ASCII dodecahedron "engram". Each run spins differently, but it must
  always settle on the same orange/gold resting frame, and the spin stays short (under a second).
- Loading lines are WoW cast bars: spell names in spell-school colors (`CASTS` in `src/term.ts`),
  not generic spinner verbs.
- The UPDATE AVAILABLE badge uses the Noctalia palette (`NOCT_*` in `src/term.ts`).
- Commands shown on screen are syntax-highlighted with `hlCmd()` / `rich()`.
- Every real addon update casts a Soulstone backup first (`src/soulstone.ts`); keep it fast.

## Layout

| Path | What |
| --- | --- |
| `src/wu.ts` | entry point and command routing |
| `src/commands/` | one file per command (update, add/list, search, import, remove, share, restore, setup, help) |
| `src/term.ts` | colors, live redraw region, cast bar, keys, input box, menus |
| `src/engram.ts` | the banner and the final ✻ line |
| `src/version.ts` | version, update check, badge, boot prompt, self-update |
| `src/paths.ts` | config/state paths, lock, finding WoW Forever |
| `src/curseforge.ts`, `src/install.ts`, `src/soulstone.ts` | data, downloads + unzip, backups |
