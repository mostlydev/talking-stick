# Install and update Talking Stick

See the [Quickstart](../README.md#quickstart) to open your first room.

| Method | Command |
|---|---|
| Standalone binary (recommended) | `curl -fsSL https://raw.githubusercontent.com/mostlydev/talking-stick/master/scripts/install.sh \| sh` |
| A specific release | Pass `--version VERSION` to the installer (see below) |
| Windows (x64) | Download `talking-stick_<version>_windows_x64.tar.gz` from [Releases](https://github.com/mostlydev/talking-stick/releases) (see below) |
| From source | [Build and link a checkout](#install-from-source) |

## Install on Windows

1. Download the Windows x64 archive and `checksums.txt` from [GitHub Releases](https://github.com/mostlydev/talking-stick/releases).
2. In PowerShell, run `Get-FileHash .\talking-stick_VERSION_windows_x64.tar.gz -Algorithm SHA256`. Replace `VERSION` with the downloaded version and compare the hash with the line for that archive.
3. In a dedicated install folder, run `tar -xzf PATH_TO_ARCHIVE` with the actual archive path. Put the install folder on your user `PATH` and keep `tt.exe` beside the bundled `skills` directory.
4. Open a new terminal and run `tt --version` and `tt install --all`. To upgrade, repeat these steps with the new archive.

Codex's Windows sandbox runs commands as a separate account that cannot reach
`%APPDATA%\talking-stick`. Let it write there in `~/.codex/config.toml`:

```toml
[sandbox_workspace_write]
writable_roots = ['C:\Users\<you>\AppData\Roaming\talking-stick']
```

## macOS and Linux options

To pin the standalone installer, append `--version VERSION` as shown below.

```sh
curl -fsSL https://raw.githubusercontent.com/mostlydev/talking-stick/master/scripts/install.sh |
  sh -s -- --version X.Y.Z
```

The installer accepts `--bin-dir DIR` (default `~/.local/bin`) and `--install-dir DIR` (default
`~/.local/share/talking-stick`). Each release lives in its own directory under `releases/`, with
the skill files beside the binary. `tt` links to the active release, and skill links go through the
`current` link, so updates keep them pointing at the right files.

```bash
tt install --all --print       # preview every change without touching anything
tt install claude-code codex   # install into a subset
tt self-update                 # reinstall the latest release with the same directories
tt uninstall --all             # remove
```

## Install from source

With Node 22 or later, run:

```sh
git clone https://github.com/mostlydev/talking-stick.git
cd talking-stick
npm install
npm link
tt install --all
```

## Updating

An installed release checks for a new version at most once every 24–30 hours, when you start an
interactive command such as `tt chat`. The check has a five-second network deadline; if a newer release
exists, `tt` downloads and installs it, then asks you to rerun the command. Agent commands, hooks,
JSON output, redirected terminals, and source checkouts never auto-update. The automatic download
and install get up to two minutes.

The bottom chat status bar shows a newer available version with `tt self-update`, or
“installed · restart chat” when an update is already on disk. Windows and hand-extracted copies
show “available · download from GitHub”. Running chats never install
updates. Panes share one cached check of the public release asset, with jitter and cached
failures. `TT_NO_AUTO_UPDATE=1` turns off both startup and chat checks. `tt self-update` still works.

**After any update,** restart running harnesses so they load the new skill and hooks, and reopen
`tt chat`.

## Harness hooks

All of them merge into existing settings, fail open, and are
removed by `tt uninstall`.

- Claude Code gets lifecycle hooks, a stop guard (skip it with `--no-guard`), and tool-boundary
  hooks for `!@claude` steering.
- Codex gets lifecycle and turn hooks in `$CODEX_HOME/hooks.json` (default `~/.codex/hooks.json`).
  Trust the entries in Codex `/hooks`.
- Grok Build gets lifecycle, session identity, stop-guard, and active-turn delivery hooks.
- `tt install herdr` adds the optional Ctrl-click shortcut for the unread bar in Herdr.

## Moving from npm

The npm package stopped updating after 0.23.0. Run the installer: it moves
skill links that still point into the npm package (only ones Talking Stick made and you haven't
edited), then offers to run `npm uninstall -g talking-stick`. It answers No by default, and
`--remove-npm` answers yes. It never offers for an `npm link`ed checkout.
