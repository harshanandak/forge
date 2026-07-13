# Installing Forge

Forge ships two ways to install:

1. **Standalone binary** (this page) — a single compiled executable, no Node or
   Bun runtime required. Best for a global CLI you run everywhere.
2. **npm / npx** — the `forge-workflow` package, if you already live in Node and
   want Forge as a project dev-dependency. See [npm / npx channel](#npm--npx-channel).

Both deliver the same Forge. The binary bundles Forge's own JavaScript, but **not**
its external prerequisites — see [Prerequisites](#prerequisites).

---

## One-line install

### macOS / Linux

```sh
curl -fsSL https://raw.githubusercontent.com/harshanandak/forge/master/scripts/install.sh | sh
```

Install a specific version:

```sh
curl -fsSL https://raw.githubusercontent.com/harshanandak/forge/master/scripts/install.sh | sh -s -- --version v1.2.3
```

The script detects your OS, CPU architecture and (on Linux) your libc, downloads
the matching binary from the latest [GitHub Release](https://github.com/harshanandak/forge/releases),
makes it executable, and installs it to `~/.local/bin/forge`. If that directory
is not on your `PATH`, the script prints the line to add.

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/harshanandak/forge/master/scripts/install.ps1 | iex
```

Install a specific version (download the script, then run it with an argument):

```powershell
$s = irm https://raw.githubusercontent.com/harshanandak/forge/master/scripts/install.ps1
& ([scriptblock]::Create($s)) -Version v1.2.3
```

This installs `forge.exe` to `%LOCALAPPDATA%\Programs\forge\` and prints how to
add it to your `PATH`.

After installing, run `forge setup` inside a git repository to wire Forge up for
your agent.

---

## Supported platforms

Each GitHub Release publishes these assets. The install scripts pick the right one
automatically; the table is for manual downloads.

| OS | Architecture | libc | Release asset |
|----|--------------|------|---------------|
| macOS | Apple Silicon (arm64) | — | `forge-darwin-arm64` |
| macOS | Intel (x64) | — | `forge-darwin-x64` |
| Linux | x64 | glibc | `forge-linux-x64` |
| Linux | arm64 | glibc | `forge-linux-arm64` |
| Linux | x64 | musl (e.g. Alpine) | `forge-linux-x64-musl` |
| Linux | arm64 | musl (e.g. Alpine) | `forge-linux-arm64-musl` |
| Windows | x64 | — | `forge-windows-x64.exe` |

On an unsupported platform the install script fails with a clear message. Use the
[npm / npx channel](#npm--npx-channel) instead.

---

## Manual download and run

If you prefer not to pipe a script to your shell, download the asset for your
platform directly from the [latest release](https://github.com/harshanandak/forge/releases/latest)
and run it.

### macOS / Linux

```sh
# Pick the asset for your platform from the table above (here: linux x64 glibc)
curl -fsSL -o forge \
  https://github.com/harshanandak/forge/releases/latest/download/forge-linux-x64
chmod +x forge
./forge --version
# Optionally move it onto your PATH:
mkdir -p ~/.local/bin && mv forge ~/.local/bin/forge
```

### Windows (PowerShell)

```powershell
irm https://github.com/harshanandak/forge/releases/latest/download/forge-windows-x64.exe -OutFile forge.exe
.\forge.exe --version
```

A pinned version uses the same URLs with `download/<tag>/` instead of
`latest/download/`, e.g.
`https://github.com/harshanandak/forge/releases/download/v1.2.3/forge-linux-x64`.

---

## npm / npx channel

If you already have Node.js, you can skip the binary entirely:

```sh
# Global install
npm i -g forge-workflow
forge --version

# Or run once without installing
npx forge-workflow status

# Or as a project dev-dependency (recommended for teams)
bun add -D forge-workflow   # or: npm install --save-dev forge-workflow
bunx forge setup --agents claude --yes
```

The npm package and the standalone binary are the same Forge and stay in lockstep
on every release.

---

## Prerequisites

The binary bundles Forge's JavaScript, but relies on a few external tools being
installed and on your `PATH`:

- **git** — required for all repository operations.
- **gh** (GitHub CLI) — required for the PR / review workflow.
- **Git Bash** (Windows only) — Forge's helper-backed stage flows run under Git
  Bash on Windows.

These are runtime prerequisites checked by `forge`'s own health checks; the
installer does not install them for you.

---

## Uninstall

- Binary: delete the installed file (`~/.local/bin/forge`, or
  `%LOCALAPPDATA%\Programs\forge\forge.exe` on Windows).
- npm: `npm rm -g forge-workflow`.
