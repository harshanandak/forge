# Contributing to Forge

Read [AGENTS.md](AGENTS.md) and the [coding standards](CODING_STANDARDS.md) before
editing. Use a worktree based on the fetched default branch. For tracked work,
start with `forge lane start <issue> --branch <name> --brief <file>`. Use
`bun tools/lane.ts` for the repository's `run`, `tier`, `list` and `auto` commands.

## Checks before pushing

Use Git, Node.js 24.15 or later in the 24.x series or Node.js 26 and later, and
Bun 1.4.4, the stable version in [package.json](package.json). From the repository
root, run these checks in Bash (Git Bash on Windows). Fix the first failure.

```sh
bun install --frozen-lockfile
bun install --cwd=cloud --frozen-lockfile --ignore-scripts
bun run gen
bun run build
bun x tsc -p tsconfig.json
bun run check
bun run fmt --check
```

Lint requires the exact canary listed in
[tools/bun-lint-version.json](tools/bun-lint-version.json).
Like [CI](.github/workflows/ci.yml), install the pinned Bun package for your platform
in a separate directory and put its `bin` first on PATH for lint. The revision printed by
`bun --revision` must match the file's `revision` field. Lint checks that match
before running.

```sh
(
  set -e
  lint_package=$(node -p '
    const platform = process.platform === "win32" ? "windows" : process.platform;
    const arch = process.arch === "arm64" ? "aarch64" : process.arch;
    `@oven/bun-${platform}-${arch}@${require("./tools/bun-lint-version.json").package}`')
  lint_dir=node_modules/.forge-lint-runtime
  npm install --prefix "$lint_dir" --ignore-scripts --no-save "$lint_package"
  export PATH="$PWD/$lint_dir/node_modules/${lint_package%@*}/bin:$PATH"
  bun --revision
  bun run lint
)
```

CI is the test gate. Run test suites in hosted CI. For a behavior change,
write the regression check first, show it fail in CI, then show it pass with the
fix. Fix the cause when a check fails.

## Pull requests

Use a plain, conventional title and fill in the
[pull request template](.github/pull_request_template.md). Explain the problem,
the fix, and the evidence from the current head. Runtime, template and release
changes get strict review because they can affect code or instructions users run.

After merge, close tracked work with a PASS receipt for the merge commit. In a
plain terminal, set `FORGE_SESSION` to a stable ID before claiming and closing.
Agent sessions can derive their session identity automatically.

```sh
forge issue claim <issue>
forge lane close <issue> --pr <number> --receipt <id>
```

Close checks the PR, head, worktree and receipt before writing. It links and
closes the issue, then removes the lane's worktree, branch and registry entry.
Run history stays. Use `--keep-open` to comment and clean up while leaving the issue
open. Retry the same arguments after an interrupted close. Move any ignored
files you need before closing. Close refuses ignored files other than
`node_modules/` and `dist/` unless you pass `--discard-ignored`.

See [the release runbook](docs/release.md) for the owner-operated publish process.
Report vulnerabilities privately as described in the [security policy](SECURITY.md).
Follow the [code of conduct](CODE_OF_CONDUCT.md).
