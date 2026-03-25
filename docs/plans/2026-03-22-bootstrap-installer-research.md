# Research: Bootstrap Installer vs npm Package Patterns

**Date:** 2026-03-22
**Purpose:** Understand how popular CLI/workflow tools handle installation DX, to inform Forge's setup strategy.

---

## Tool-by-Tool Analysis

### 1. Husky (git hooks)

| Aspect | Pattern |
|--------|---------|
| **Separate install.sh?** | No. Everything is in the npm package. |
| **Setup command** | `npm install --save-dev husky` then `npx husky init` |
| **First-time setup** | `npx husky init` creates `.husky/` dir, adds `prepare` script to package.json, creates default pre-commit hook |
| **Upgrade** | `npm update husky` — no re-init needed, `.husky/` hooks are user-owned files |
| **postinstall?** | **Removed in v5+**. Husky explicitly moved away from postinstall. Uses `prepare` script instead (`"prepare": "husky"`) |
| **Interactive vs CI** | Not interactive — `husky init` is deterministic. For CI, set `HUSKY=0` env var to skip hook installation. Provides `.husky/install.mjs` pattern to check `process.env.CI` |

**Key insight:** Husky's creator wrote a [blog post](https://blog.typicode.com/posts/husky-git-hooks-autoinstall/) explaining why autoinstall via postinstall was removed:
- Package managers cache postinstall, making it unreliable
- Package managers hide postinstall output, so no feedback on success/failure
- npm docs explicitly say postinstall should only be used for compilation
- The `prepare` lifecycle hook is the correct place for setup-after-install

---

### 2. lint-staged

| Aspect | Pattern |
|--------|---------|
| **Separate install.sh?** | No. npm package only. |
| **Setup command** | `npx mrm lint-staged` (uses mrm as a separate setup tool) OR manual: `npm install --save-dev lint-staged` + config in package.json |
| **First-time setup** | mrm auto-detects your existing ESLint/Prettier config and generates lint-staged config + husky pre-commit hook |
| **Upgrade** | `npm update lint-staged` — config is user-owned, unaffected |
| **postinstall?** | No |
| **Interactive vs CI** | mrm setup is non-interactive (infers from package.json). The tool itself has no interactive mode. |

**Key insight:** lint-staged delegates setup scaffolding to a separate tool (mrm) rather than building it in. The core package is purely a runtime.

---

### 3. Turborepo

| Aspect | Pattern |
|--------|---------|
| **Separate install.sh?** | No. Two npm packages: `create-turbo` (scaffolding) and `turbo` (runtime). |
| **Setup command** | New project: `npx create-turbo@latest`. Existing project: `npm install turbo` |
| **First-time setup** | `create-turbo` scaffolds a complete monorepo structure with example apps, shared packages, turbo.json config |
| **Upgrade** | `npm update turbo` for existing. `create-turbo` is one-time scaffolding only. |
| **postinstall?** | No (turbo uses a platform-specific binary download, but via npm's standard optionalDependencies pattern, not postinstall) |
| **Interactive vs CI** | `create-turbo` asks for project name and package manager. Supports `--` flags for non-interactive. |

**Key insight:** Clear separation between **scaffolding** (`create-turbo`, used once) and **runtime** (`turbo`, installed as dependency). This is the `npm create` / `npm init` convention.

---

### 4. ESLint

| Aspect | Pattern |
|--------|---------|
| **Separate install.sh?** | No. Separate npm package `@eslint/create-config` for init. |
| **Setup command** | `npm init @eslint/config@latest` (which runs `npx @eslint/create-config`) |
| **First-time setup** | Interactive wizard asks about usage, framework, TypeScript, style preferences. Generates `eslint.config.mjs` and installs needed plugins. |
| **Upgrade** | `npm update eslint` — config file is user-owned. Migration guides for major versions. |
| **postinstall?** | No |
| **Interactive vs CI** | Interactive by default. Non-interactive via flags: `npm init @eslint/config@latest -- --config eslint-config-xo` |

**Key insight:** ESLint extracted its `--init` into a **separate `create-*` package** (`@eslint/create-config`). This follows the `npm init` initializer convention and keeps the core package lean.

---

### 5. Prettier

| Aspect | Pattern |
|--------|---------|
| **Separate install.sh?** | No. Pure npm package. |
| **Setup command** | `npm install --save-dev --save-exact prettier` then manually create `.prettierrc` and `.prettierignore` |
| **First-time setup** | Completely manual. Docs provide copy-paste commands. No init/scaffolding command at all. |
| **Upgrade** | `npm update prettier` — uses `--save-exact` to pin versions (formatting changes between versions) |
| **postinstall?** | No |
| **Interactive vs CI** | N/A — no interactive setup. Everything is manual config file creation. |

**Key insight:** Prettier is the simplest pattern — install package, create config, done. No scaffolding, no init command. Works because the tool has minimal configuration needs. A third-party `prettier-install` package exists for automated setup.

---

### 6. Changesets

| Aspect | Pattern |
|--------|---------|
| **Separate install.sh?** | No. Everything in `@changesets/cli` npm package. |
| **Setup command** | `npm install --save-dev @changesets/cli` then `npx changeset init` |
| **First-time setup** | `changeset init` creates `.changeset/` directory with `config.json` and a README. One-time operation. |
| **Upgrade** | `npm update @changesets/cli` — `.changeset/` dir and config are user-owned |
| **postinstall?** | No |
| **Interactive vs CI** | `changeset init` is non-interactive (deterministic). `changeset` (add) is interactive (prompts for bump type and summary). CI uses `changeset version` and `changeset publish` which are non-interactive. |

**Key insight:** Init is bundled in the same package (not a separate `create-*` package). This works because the init step is trivial (create one directory + two files).

---

### 7. Create React App / Vite

| Aspect | Pattern |
|--------|---------|
| **Separate install.sh?** | No. Uses `create-vite` npm package via `npm create` convention. |
| **Setup command** | `npm create vite@latest` (runs `npx create-vite`) |
| **First-time setup** | Interactive: asks project name, framework (React/Vue/Svelte/etc.), variant (TS/JS). Scaffolds full project. |
| **Upgrade** | N/A — scaffolding is one-time. Vite itself upgrades via `npm update vite`. |
| **postinstall?** | No |
| **Interactive vs CI** | Supports `--template` flag for non-interactive: `npm create vite@latest my-app -- --template react-ts`. Also has `--no-interactive` flag for CI. |

**Key insight:** The gold standard for the `create-*` pattern. Scaffolding package is separate from the runtime. Non-interactive mode via explicit flags.

---

## Pattern Summary

| Tool | install.sh? | postinstall? | Init in same pkg? | Separate create-* pkg? | Interactive? | CI detection? |
|------|------------|-------------|-------------------|----------------------|-------------|--------------|
| Husky | No | **Removed** | Yes (`husky init`) | No | No | `HUSKY=0` env var |
| lint-staged | No | No | No (uses mrm) | No (third-party) | No | N/A |
| Turborepo | No | No | No | Yes (`create-turbo`) | Yes | CLI flags |
| ESLint | No | No | No | Yes (`@eslint/create-config`) | Yes | CLI flags |
| Prettier | No | No | No init at all | No | No | N/A |
| Changesets | No | No | Yes (`changeset init`) | No | Partial | N/A |
| Vite | No | No | No | Yes (`create-vite`) | Yes | `--no-interactive` |

### Universal findings:

1. **Zero tools use a separate bash install.sh** — every single one is a pure npm package
2. **Zero tools use postinstall for setup** — Husky explicitly removed it and blogged about why
3. **The `prepare` lifecycle hook** is the standard for "run after install" (Husky pattern)
4. **Two-package pattern** (`create-*` + runtime) is used when scaffolding is complex (Turborepo, ESLint, Vite)
5. **Single-package with init subcommand** is used when scaffolding is simple (Husky, Changesets)
6. **CI/non-interactive** is handled via env vars (`CI=true`, `HUSKY=0`) or CLI flags (`--no-interactive`, `--yes`)

---

## Recommendation for Forge

### Current state question: Should Forge keep a separate install.sh?

**No. The industry standard is clear: everything should go through the npm CLI.**

### Recommended pattern for Forge:

**Single package with init subcommand** (Husky/Changesets pattern), because:

1. **Forge's setup is lightweight** — it creates config files, detects the environment, installs optional tooling. This is comparable to `husky init` or `changeset init`, not to scaffolding a full project (where `create-*` would be appropriate).

2. **The existing `bunx forge setup` already works** — this is the correct pattern. It's the npm-native way.

3. **A bash install.sh adds problems:**
   - Not cross-platform (Windows developers need WSL or Git Bash)
   - Not versioned with the package (users might curl an old script)
   - Can't leverage Node.js APIs (detect package.json, read config, etc.)
   - Goes against every tool in the ecosystem

### Specific implementation guidance:

| Concern | Recommended Pattern | Example |
|---------|-------------------|---------|
| **First-time setup** | `bunx forge setup` (interactive prompts) | Like `npx husky init` |
| **Upgrade** | `npm update forge` — config files are user-owned, not regenerated | Like every tool above |
| **CI environments** | Detect `process.env.CI` and skip interactive prompts, use defaults | Like Vite's `--no-interactive` |
| **Post-install hook setup** | Use `prepare` script in user's package.json: `"prepare": "forge setup --yes"` | Like Husky's `"prepare": "husky"` |
| **Never use postinstall** | Follow npm/Yarn best practices — postinstall is for compilation only | Husky's explicit stance |
| **Non-interactive flag** | Support `bunx forge setup --yes` or `--non-interactive` for scripted environments | Like `npm init -y` |

### The two legitimate patterns:

```
Pattern A: Simple init (RECOMMENDED for Forge)
  npm install forge → bunx forge setup
  (single package, init subcommand)
  Used by: Husky, Changesets, lint-staged

Pattern B: Scaffolding + runtime (NOT needed for Forge)
  npm create forge@latest → creates whole project
  (separate create-forge package)
  Used by: Vite, Turborepo, ESLint
```

Pattern B would only make sense if Forge were scaffolding entire new projects. Since Forge is added to existing projects as a workflow harness, Pattern A is correct.

### Bottom line:

**Kill the install.sh. Keep `bunx forge setup`. Add `--yes`/`--non-interactive` flag and `process.env.CI` detection. This is what every successful tool in the ecosystem does.**

---

## Sources

- [Husky Get Started](https://typicode.github.io/husky/get-started.html)
- [Husky How To (CI/Docker)](https://typicode.github.io/husky/how-to.html)
- [Why Husky Doesn't Autoinstall Anymore](https://blog.typicode.com/posts/husky-git-hooks-autoinstall/)
- [ESLint Getting Started](https://eslint.org/docs/latest/use/getting-started)
- [Prettier Install Docs](https://prettier.io/docs/install)
- [Turborepo Installation](https://turborepo.dev/docs/getting-started/installation)
- [Turborepo create-turbo](https://turborepo.dev/docs/reference/create-turbo)
- [Changesets CLI README](https://github.com/changesets/changesets/blob/main/packages/cli/README.md)
- [npm init docs](https://docs.npmjs.com/cli/v11/commands/npm-init/)
- [Vite Getting Started](https://vite.dev/guide/)
- [npm Security Best Practices (OWASP)](https://cheatsheetseries.owasp.org/cheatsheets/NPM_Security_Cheat_Sheet.html)
- [npm ci-detect](https://github.com/npm/ci-detect)
- [is-in-ci package](https://www.npmjs.com/package/is-in-ci)
