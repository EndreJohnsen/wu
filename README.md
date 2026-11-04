# wu

Keeps your WoW Forever addons fresh from the terminal: update, search, import and install
from CurseForge, with a spinning ASCII engram and a WoW cast-bar loading line.

Private package (`"private": true`, never published to npm). Needs `python3` (standard
library only) and a terminal; built for Linux with WoW running under Wine/Proton.

## Install

```sh
bun add -g git+https://github.com/EndreJohnsen/wu.git
```

Re-run the same command to upgrade. From a local checkout instead:

```sh
cd ~/Projects/wu && bun pm pack && bun add -g "$PWD"/endrejohnsen-wu-*.tgz
```

(`bun add -g` resolves relative paths against its own global folder, so the tarball path
must be absolute.)

## Use

```sh
wu setup             # paste where WoW Forever is installed (auto-detects Wine prefixes)
wu                   # update every tracked addon
wu --check           # only look for updates
wu search bags       # pick 1-10 to install; tab switches most downloads / most recent
wu import            # match addons already in AddOns to CurseForge, accept/deny each
wu add <slug|url|id> # track and install one addon
wu list              # what's tracked, and which version
wu help
```

## Where things live

| What | Path |
| --- | --- |
| WoW path | `~/.config/wu/config.json` (or `WU_DIR` env) |
| Tracked addons | `~/.local/state/wu/state.json` |

Data comes from `api.cfwidget.com` (CurseForge file lists) and `api.curse.tools` (CurseForge
search, keyless proxy of the official API); the CurseForge site itself blocks scripts.
Downloads come straight from `edge.forgecdn.net` and are size-checked before install.
Only WoW Forever builds (game version `1.60.1`) are ever installed. A failed install puts
the previous version back.
