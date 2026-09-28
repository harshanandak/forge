# Package slim audit: ship only runtime files

Issue: 46d25e0a. Base: origin/master 3bc4eb44. Method and evidence rules are at the end.

## Totals (every path in `npm pack --dry-run --json --ignore-scripts` at 3bc4eb44)

| Class | Files | Bytes (unpacked) |
|---|---:|---:|
| KEEP-RUNTIME | 437 | 4,602,041 (4494.2 KB) |
| MOVE-OUT | 116 | 1,005,410 (981.8 KB) |
| DELETE | 33 | 177,859 (173.7 KB) |
| DUPLICATE | 82 | 200,042 (195.4 KB) |
| **Total** | **668** | **5,985,352** |

KEEP-RUNTIME includes the 57 bundled `node_modules/@forge/*` files (288,949 bytes): they are governed by
`bundleDependencies`, not `files`, and are left to PR #577 together with the DUPLICATE copies.

## Package before and after (this PR)

| | Tarball | Unpacked | Files |
|---|---:|---:|---:|
| origin/master 3bc4eb44 | 1.61 MB | 5.99 MB | 668 |
| allow-list (this PR) | 1.27 MB | 4.80 MB | 519 |

The new `files` ships exactly KEEP-RUNTIME + DUPLICATE (437 + 82 = 519).
MOVE-OUT and DELETE paths stay in the repo but no longer ship. Nothing is deleted in this PR.

## DELETE candidates (PR 2 input)

| Files | Tests that go with them |
|---|---|
| lib/beta5-compatibility-evidence.js + lib/fixtures/beta5-corpus/** (10 files) | test/beta5-compatibility-evidence.test.js |
| lib/capabilities/index.js, model.js, probes.js | test/capabilities/index.test.js, test/capabilities/model.test.js, test/capabilities/probes.test.js, test/capability/harness-probes.test.js (+ test/capability/fixtures.js if unused elsewhere) |
| lib/forge-context.js | test/forge-context.test.js |
| lib/freshness-token.js | test/freshness-token.test.js (+ its entry in lib/commands/test.js:63) |
| lib/task-ownership.js | test/task-ownership.test.js |
| lib/frontmatter.js | none |
| lib/validation-utils.js | none |
| lib/kernel/planning-buckets-schema.js | test/kernel/planning-buckets-schema.test.js (+ prose in docs/reference/KERNEL_TAXONOMY_VALIDATION.md:117) |
| lib/issue-sync/{github-pull,import-primitives,legacy-link-bridge,link-store,reconcile,schema}.js | test/issue-sync/{github-pull,import-primitives,legacy-link-bridge,link-store,reconcile,schema}.test.js |
| lib/setup.js | test/e2e/setup-workflow.test.js, test/setup-resumability.test.js (+ assertion removed from test/integration/package-distribution.test.js in this PR) |
| scripts/migrate-to-bun-test.js | none |
| scripts/run-command-eval.js, scripts/improve-command.js, scripts/lib/{eval-schema,eval-storage,grading}.js | test/eval/{eval-pipeline,improve-command,eval-history,eval-schema,eval-sets,eval-storage,grading}.test.js |

Total: 33 shipped files, 177,859 bytes. Per-file sizes are in the DELETE table below.
`scripts/test-weights.json` lists several of these tests and needs regenerating when they go.

## Unsure (kept, flagged)

- **Helpers of setup-copied scripts** (`lib/dep-guard/*`, `lib/smart-status/*`, `scripts/dep-guard-render-review.js`,
  `scripts/dep-guard-keyword-ripple.js`, `scripts/smart-status-score.js`, `scripts/smart-status-sessions.js`,
  `scripts/bootstrap-windows-tools.sh`). Setup copies `dep-guard.sh`, `dep-guard-analyze.js` and `smart-status.sh` into
  the project but not these dependencies, so in a consumer project they are missing today. Kept so the fix can resolve them
  from the package root. Filed as 2fcdfaa1.
- **scripts/preflight-sonar.eslint.config.mjs**: `forge preflight` passes it to eslint (lib/preflight/gates.js:167) but resolves
  it under projectRoot, so the packaged copy is not read today. Kept for the same fix (2fcdfaa1).
- **scripts/legacy-claim-repair.js**: an operator repair tool for kernel stores, documented as a command to run
  (docs/reference/LEGACY_CLAIM_REPAIR.md:39). No CLI caller. Kept because consumer stores are the ones it repairs.
- **lib/memory/usage-evidence.js**: a 4-line compatibility require-path shim onto `@forge/memory`. No CLI reader, kept for deep importers.
- **Deep imports in general**: package.json has no `exports`, so every shipped lib file can be imported directly. The only
  documented deep import is `forge-workflow/lib/context-merge` (docs/guides/ENHANCED_ONBOARDING.md:453), which still ships.
  An undocumented deep importer of a MOVE-OUT/DELETE lib file would break.
- **Runtime messages that name repo docs** (`docs/reference/control-plane-guarantees.md` in lib/control-plane.js:27,
  `docs/guides/memory-backends.md` in lib/memory/router.js:194): they only print the path, never read it. After this PR
  the path points at the repo, not the installed package.

## Pre-existing gaps found (not changed here)

- `copyEssentialDocs` (lib/docs-copy.js:7,24) reads `docs/TOOLCHAIN.md` and `docs/VALIDATION.md`, which never existed at
  docs/ root, so setup never creates `docs/forge/`. Already tracked as 9c481b97 (my duplicate 447bd66f is closed).
- The setup-copied script dependencies above, the sonar config path, and `skills/review/SKILL.md:85` pointing at
  `.claude/rules/review-process.md`, which setup never installs: 2fcdfaa1.

## Method

- **Pack list**: `npm pack --dry-run --json --ignore-scripts` at 3bc4eb44 (668 files). The supplied `pack-now.json` was 3 files
  behind HEAD (missing `scripts/build-test-weights.js`, `scripts/lib/ci-shard-partition.js`, `scripts/test-weights.json`
  from #591). All three are MOVE-OUT.
- **Require graph**: a static walk of `require`/`import` from the `bin` entry points plus every `lib/commands/*.js`
  (the registry loads them by readdir, lib/commands/_registry.js:185-194; the generated manifest escapes `/` as `\u002f`,
  which the walk decodes). Result: 86 shipped JS files unreachable. This matches `unreachable.txt` plus the 2 new #591
  files plus `lib/kernel/windows-private-acl.js`, which is spawned by path. Dynamic requires checked by hand:
  `lib/commands/_registry.js:194`, `lib/adapter-cli.js:157` (project adapters), `lib/migrate-dry-run.js:314`
  (`test/fixtures`, not shipped).
- **By-name search** for every non-reachable path: every line of every `git ls-files` text file (binary and the two input
  files excluded) was searched for the full path, the path without extension, and the basename (when 6+ characters).
  Hits were split by the referring file: runtime (bin, lib, .forge/hooks, skills, rules, .claude, shipped scripts),
  lefthook.yml, package.json, .github, tests, docs. Every runtime hit was read to tell a real read or exec from a comment or
  a projectRoot path string. The by-name surfaces checked: lefthook.yml, lib/workflow-templates/test.yml, `.github/`,
  setup/init copy lists (WORKFLOW_RUNTIME_ASSETS lib/commands/setup.js:267-287, hook copy :2835, AGENTS/CODING_STANDARDS/
  load-env copies), `lib/package-root.js` ASSET_ROOTS, `lib/rules-sync.js`, `lib/skills-sync.js`, `lib/docs-command.js`,
  skills and rules.
- **Zero-hit claims** (`lib/frontmatter.js`, `scripts/migrate-to-bun-test.js`, `scripts/parity-check.test.mjs` by name) mean
  zero hits across that whole tracked corpus for all three tokens.
- **Install proof**: the allow-listed tarball was installed into a temp project with npm and with Bun
  (test/integration/standalone-package-smoke.test.js: `--version`, `--help`, `setup --help`, `setup --quick --yes`), and
  by hand: `forge docs toolchain|validation|setup|examples|roadmap`, `forge setup --quick --yes --agents claude,cursor,codex`
  (copied all WORKFLOW_RUNTIME_ASSETS, .forge/hooks, .claude/scripts, 25 skills, 6 Cursor rules), `forge team --help`,
  `forge skill coverage`, `forge skill for`. All exit 0.

## KEEP-RUNTIME (437 files, 4,602,041 bytes)

| Path | Bytes | Evidence |
|---|---:|---|
| `.claude/scripts/load-env.sh` | 977 | copied into projects: lib/commands/setup.js:1841-1842, bin/forge.js:1797 |
| `.claude/scripts/review-resolve.sh` | 20,332 | setup-copied WORKFLOW_RUNTIME_ASSETS lib/commands/setup.js:287 (copy loop :664); invoked by lib/adapters/pr-state-adapter.js:418 |
| `.forge/hooks/check-tdd.js` | 10,817 | copied into projects: lib/commands/setup.js:2835 (`for (const name of ['check-tdd.js', 'forge-native-hook.js'])`), bin/forge.js:2816; executed by generated lefthook.yml (lib/lefthook-wiring.js FORGE_USER_LEFTHOOK_YML) |
| `.forge/hooks/forge-native-hook.js` | 18,310 | copied into projects: lib/commands/setup.js:2835 (`for (const name of ['check-tdd.js', 'forge-native-hook.js'])`), bin/forge.js:2816; executed by generated lefthook.yml (lib/lefthook-wiring.js FORGE_USER_LEFTHOOK_YML) |
| `AGENTS.md` | 23,680 | copied into projects: lib/commands/setup.js:1798, :2526, :3618, :3710, :4156 (`path.join(getPackageRoot(packageDir), 'AGENTS.md')`) |
| `bin/forge-cmd.js` | 14,947 | read as data by `forge skill` coverage lint: lib/skill-eval.js:472 (`path.join(getPackageRoot(), 'bin')`) + :486 extractor for forge-cmd.js |
| `bin/forge-gh-proxy.js` | 609 | required by bin/forge.js:3663 |
| `bin/forge-github-credential.js` | 854 | required by bin/forge.js:3658 |
| `bin/forge-preflight.js` | 7,934 | package.json `bin` entry point |
| `bin/forge.js` | 160,377 | package.json `bin` entry point |
| `CODING_STANDARDS.md` | 4,052 | copied into projects: lib/commands/setup.js:1746; ASSET_ROOTS lib/package-root.js:70 |
| `docs/guides/SETUP.md` | 3,799 | `forge docs setup` reads it: lib/docs-command.js:12,17-19 (setup searches guides/ first) + :49, called at bin/forge.js:3999 |
| `docs/reference/EXAMPLES.md` | 17,222 | `forge docs <topic>` reads it from the package: lib/docs-command.js:9-19 (TOPICS) + :49 (`path.join(packageDir, 'docs', dir, filename)`), called at bin/forge.js:3999 |
| `docs/reference/ROADMAP.md` | 12,100 | `forge docs <topic>` reads it from the package: lib/docs-command.js:9-19 (TOPICS) + :49 (`path.join(packageDir, 'docs', dir, filename)`), called at bin/forge.js:3999 |
| `docs/reference/TOOLCHAIN.md` | 22,210 | `forge docs <topic>` reads it from the package: lib/docs-command.js:9-19 (TOPICS) + :49 (`path.join(packageDir, 'docs', dir, filename)`), called at bin/forge.js:3999 |
| `docs/reference/VALIDATION.md` | 2,990 | `forge docs <topic>` reads it from the package: lib/docs-command.js:9-19 (TOPICS) + :49 (`path.join(packageDir, 'docs', dir, filename)`), called at bin/forge.js:3999 |
| `lib/activation/ensure-forge-home.js` | 6,106 | required by lib/commands/_registry.js:15 |
| `lib/adapter-cli.js` | 9,701 | required by lib/commands/adapter.js:3 |
| `lib/adapters/beads-kernel-compat.js` | 40,421 | required by lib/commands/migrate.js:15 |
| `lib/adapters/greptile-review-adapter.js` | 4,030 | required by lib/adapter-cli.js:5 |
| `lib/adapters/kernel-issue-adapter.js` | 2,867 | required by lib/forge-issues.js:4 |
| `lib/adapters/pr-state-adapter.js` | 36,323 | required by lib/commands/merge.js:47 |
| `lib/adoption-profiles.js` | 4,319 | required by lib/commands/init.js:10 |
| `lib/agents-config.js` | 25,568 | required by lib/commands/setup.js:89 |
| `lib/agents/claude.plugin.json` | 440 | read by lib/plugin-manager.js:231-240 (readdir of lib/agents for *.plugin.json) |
| `lib/agents/codex.plugin.json` | 595 | read by lib/plugin-manager.js:231-240 (readdir of lib/agents for *.plugin.json) |
| `lib/agents/cursor.plugin.json` | 434 | read by lib/plugin-manager.js:231-240 (readdir of lib/agents for *.plugin.json) |
| `lib/agents/hermes.plugin.json` | 547 | read by lib/plugin-manager.js:231-240 (readdir of lib/agents for *.plugin.json) |
| `lib/audit-evidence.js` | 6,837 | required by lib/commands/dev.js:14 |
| `lib/base-remote.js` | 4,403 | required by lib/commands/ship.js:17 |
| `lib/beads-detect.js` | 2,163 | required by lib/upgrade-safety.js:10 |
| `lib/bun-workflow-pins.js` | 22,315 | required by lib/commands/release.js:13 |
| `lib/capped-jsonl-log.js` | 8,143 | required by lib/audit-evidence.js:3 |
| `lib/codex-skills.js` | 5,451 | required by lib/commands/setup.js:86 |
| `lib/commands/_aliases.js` | 10,270 | required by bin/forge.js:77 |
| `lib/commands/_issue.js` | 38,809 | required by lib/commands/blocked.js:3 |
| `lib/commands/_manifest.js` | 24,415 | required by lib/commands/_registry.js:26 |
| `lib/commands/_registry.js` | 12,594 | required by bin/forge.js:67 |
| `lib/commands/_resolve-command-opts.js` | 9,073 | required by bin/forge.js:78 |
| `lib/commands/_serve-security.js` | 10,226 | required by lib/commands/serve.js:39 |
| `lib/commands/adapter.js` | 326 | command module loaded by the registry: lib/commands/_manifest.js:33 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/add.js` | 3,446 | command module loaded by the registry: lib/commands/_manifest.js:40 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/audit.js` | 1,683 | command module loaded by the registry: lib/commands/_manifest.js:48 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/blocked.js` | 122 | command module loaded by the registry: lib/commands/_manifest.js:55 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/claim.js` | 846 | command module loaded by the registry: lib/commands/_manifest.js:63 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/claims.js` | 295 | command module loaded by the registry: lib/commands/_manifest.js:71 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/clean.js` | 34,316 | command module loaded by the registry: lib/commands/_manifest.js:79 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/close.js` | 120 | command module loaded by the registry: lib/commands/_manifest.js:87 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/comment.js` | 122 | command module loaded by the registry: lib/commands/_manifest.js:95 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/control.js` | 5,558 | command module loaded by the registry: lib/commands/_manifest.js:103 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/create.js` | 121 | command module loaded by the registry: lib/commands/_manifest.js:110 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/dev.js` | 23,949 | command module loaded by the registry: lib/commands/_manifest.js:118 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/doc-gate.js` | 13,641 | command module loaded by the registry: lib/commands/_manifest.js:124 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/doctor.js` | 6,585 | command module loaded by the registry: lib/commands/_manifest.js:132 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/explain.js` | 383 | command module loaded by the registry: lib/commands/_manifest.js:139 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/export.js` | 8,509 | command module loaded by the registry: lib/commands/_manifest.js:147 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/gate.js` | 15,105 | command module loaded by the registry: lib/commands/_manifest.js:155 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/github.js` | 22,337 | command module loaded by the registry: lib/commands/_manifest.js:162 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/hooks.js` | 36,520 | command module loaded by the registry: lib/commands/_manifest.js:169 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/inbox.js` | 4,781 | command module loaded by the registry: lib/commands/_manifest.js:177 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/init.js` | 21,116 | command module loaded by the registry: lib/commands/_manifest.js:185 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/insights.js` | 2,826 | command module loaded by the registry: lib/commands/_manifest.js:193 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/issue.js` | 701 | command module loaded by the registry: lib/commands/_manifest.js:200 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/issues.js` | 2,254 | command module loaded by the registry: lib/commands/_manifest.js:208 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/lint.js` | 119 | command module loaded by the registry: lib/commands/_manifest.js:217 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/list.js` | 119 | command module loaded by the registry: lib/commands/_manifest.js:225 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/memory.js` | 6,182 | command module loaded by the registry: lib/commands/_manifest.js:233 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/merge.js` | 66,122 | command module loaded by the registry: lib/commands/_manifest.js:240 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/migrate.js` | 12,570 | command module loaded by the registry: lib/commands/_manifest.js:247 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/new.js` | 327 | command module loaded by the registry: lib/commands/_manifest.js:255 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/options.js` | 7,814 | command module loaded by the registry: lib/commands/_manifest.js:262 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/orient.js` | 379 | command module loaded by the registry: lib/commands/_manifest.js:270 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/orphans.js` | 122 | command module loaded by the registry: lib/commands/_manifest.js:277 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/patch.js` | 1,694 | command module loaded by the registry: lib/commands/_manifest.js:285 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/plan.js` | 38,525 | command module loaded by the registry: lib/commands/_manifest.js:292 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/pr.js` | 18,702 | command module loaded by the registry: lib/commands/_manifest.js:298 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/preflight.js` | 8,955 | command module loaded by the registry: lib/commands/_manifest.js:305 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/prime.js` | 1,375 | command module loaded by the registry: lib/commands/_manifest.js:313 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/push.js` | 23,112 | command module loaded by the registry: lib/commands/_manifest.js:320 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/ready.js` | 120 | command module loaded by the registry: lib/commands/_manifest.js:328 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/recall.js` | 10,403 | command module loaded by the registry: lib/commands/_manifest.js:336 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/recap.js` | 2,926 | command module loaded by the registry: lib/commands/_manifest.js:344 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/recommend.js` | 3,867 | command module loaded by the registry: lib/commands/_manifest.js:351 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/release.js` | 5,435 | command module loaded by the registry: lib/commands/_manifest.js:357 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/remember.js` | 6,394 | command module loaded by the registry: lib/commands/_manifest.js:365 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/role.js` | 3,419 | command module loaded by the registry: lib/commands/_manifest.js:373 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/serve.js` | 25,412 | command module loaded by the registry: lib/commands/_manifest.js:380 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/setup.js` | 167,959 | command module loaded by the registry: lib/commands/_manifest.js:387 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/shepherd.js` | 42,297 | command module loaded by the registry: lib/commands/_manifest.js:393 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/ship.js` | 18,959 | command module loaded by the registry: lib/commands/_manifest.js:400 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/show.js` | 119 | command module loaded by the registry: lib/commands/_manifest.js:406 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/skill.js` | 18,313 | command module loaded by the registry: lib/commands/_manifest.js:414 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/stage.js` | 7,119 | command module loaded by the registry: lib/commands/_manifest.js:422 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/stale.js` | 120 | command module loaded by the registry: lib/commands/_manifest.js:430 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/status.js` | 26,125 | command module loaded by the registry: lib/commands/_manifest.js:438 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/sync.js` | 2,346 | command module loaded by the registry: lib/commands/_manifest.js:446 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/team.js` | 3,489 | command module loaded by the registry: lib/commands/_manifest.js:454 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/test.js` | 19,817 | command module loaded by the registry: lib/commands/_manifest.js:460 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/update.js` | 121 | command module loaded by the registry: lib/commands/_manifest.js:468 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/upgrade.js` | 1,294 | command module loaded by the registry: lib/commands/_manifest.js:476 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/validate.js` | 34,346 | command module loaded by the registry: lib/commands/_manifest.js:484 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/commands/worktree.js` | 40,662 | command module loaded by the registry: lib/commands/_manifest.js:492 (static manifest) / lib/commands/_registry.js:185-194 (readdir fallback) |
| `lib/config-writer.js` | 7,074 | required by lib/commands/control.js:26 |
| `lib/context-merge.js` | 11,170 | required by bin/forge.js:85 |
| `lib/control-plane.js` | 9,211 | required by lib/commands/control.js:34 |
| `lib/core/runtime-graph.js` | 37,392 | required by lib/commands/control.js:27 |
| `lib/dep-guard/analyzer.js` | 8,621 | required (transitively) by scripts/dep-guard-analyze.js:5 (`require('../lib/dep-guard/analyzer.js')`), a setup-copied runtime asset (lib/commands/setup.js:269); analyzer.js:1-6 requires the siblings |
| `lib/dep-guard/behavior-detector.js` | 2,825 | required (transitively) by scripts/dep-guard-analyze.js:5 (`require('../lib/dep-guard/analyzer.js')`), a setup-copied runtime asset (lib/commands/setup.js:269); analyzer.js:1-6 requires the siblings |
| `lib/dep-guard/contract-detector.js` | 4,037 | required (transitively) by scripts/dep-guard-analyze.js:5 (`require('../lib/dep-guard/analyzer.js')`), a setup-copied runtime asset (lib/commands/setup.js:269); analyzer.js:1-6 requires the siblings |
| `lib/dep-guard/import-detector.js` | 12,395 | required (transitively) by scripts/dep-guard-analyze.js:5 (`require('../lib/dep-guard/analyzer.js')`), a setup-copied runtime asset (lib/commands/setup.js:269); analyzer.js:1-6 requires the siblings |
| `lib/dep-guard/keyword-ripple.js` | 3,426 | required by scripts/dep-guard-keyword-ripple.js:7, which scripts/dep-guard.sh:371 runs (dep-guard.sh is copied into projects: lib/commands/setup.js:270) |
| `lib/dep-guard/path-utils.js` | 269 | required (transitively) by scripts/dep-guard-analyze.js:5 (`require('../lib/dep-guard/analyzer.js')`), a setup-copied runtime asset (lib/commands/setup.js:269); analyzer.js:1-6 requires the siblings |
| `lib/dep-guard/rubric.js` | 3,077 | required (transitively) by scripts/dep-guard-analyze.js:5 (`require('../lib/dep-guard/analyzer.js')`), a setup-copied runtime asset (lib/commands/setup.js:269); analyzer.js:1-6 requires the siblings |
| `lib/dep-guard/task-parser.js` | 7,173 | required (transitively) by scripts/dep-guard-analyze.js:5 (`require('../lib/dep-guard/analyzer.js')`), a setup-copied runtime asset (lib/commands/setup.js:269); analyzer.js:1-6 requires the siblings |
| `lib/deprecated-sync-cleanup.js` | 13,283 | required by lib/commands/setup.js:31 |
| `lib/detect-agent.js` | 5,683 | required by bin/forge.js:92 |
| `lib/detect-worktree.js` | 3,242 | required by lib/commands/status.js:11 |
| `lib/detection-utils.js` | 11,370 | required by lib/commands/setup.js:92 |
| `lib/doc-assertions.js` | 11,473 | required by lib/commands/test.js:19 |
| `lib/doc-gate/declaration.js` | 7,709 | required by lib/commands/doc-gate.js:25 |
| `lib/doc-gate/detect.js` | 17,402 | required by lib/commands/doc-gate.js:23 |
| `lib/doc-gate/gate.js` | 15,181 | required by lib/commands/doc-gate.js:24 |
| `lib/doc-gate/okf-config.js` | 4,417 | required by lib/commands/doc-gate.js:26 |
| `lib/doc-gate/okf.js` | 17,350 | required by lib/commands/doc-gate.js:27 |
| `lib/docs-command.js` | 35,196 | required by bin/forge.js:65 |
| `lib/docs-copy.js` | 1,471 | required by bin/forge.js:58 |
| `lib/existing-tdd-gate.js` | 9,781 | required by lib/commands/setup.js:78 |
| `lib/file-hash.js` | 762 | required by bin/forge.js:93 |
| `lib/file-utils.js` | 8,568 | required by lib/commands/setup.js:91 |
| `lib/forge-issues.js` | 15,440 | required by lib/commands/clean.js:584 |
| `lib/forge-lock.js` | 7,330 | required by lib/commands/add.js:4 |
| `lib/gate-events.js` | 10,783 | required by lib/commands/gate.js:31 |
| `lib/gh-proxy.js` | 14,061 | required by bin/forge-gh-proxy.js:9 |
| `lib/git-defaults.js` | 1,746 | required by lib/commands/worktree.js:6 |
| `lib/github-context.js` | 17,494 | required by lib/commands/github.js:10 |
| `lib/github-credential.js` | 1,927 | required by bin/forge-github-credential.js:11 |
| `lib/github-router.js` | 33,638 | required by lib/commands/github.js:13 |
| `lib/global-flags.js` | 3,424 | required by bin/forge.js:82 |
| `lib/greptile-match.js` | 1,069 | required by shipped .claude/scripts/review-resolve.sh:379-382 via `$(dirname "$0")/../../lib/greptile-match.js` (package-relative layout) |
| `lib/grounding/context-events.js` | 9,460 | required by lib/commands/recap.js:7 |
| `lib/grounding/read-first.js` | 4,420 | required by lib/commands/_issue.js:15 |
| `lib/hook-global-installer.js` | 13,368 | required by lib/commands/hooks.js:29 |
| `lib/hook-renderer.js` | 33,601 | required by lib/commands/hooks.js:32 |
| `lib/husky-migration.js` | 16,723 | required by bin/forge.js:105 |
| `lib/inbox.js` | 17,709 | required by lib/commands/hooks.js:34 |
| `lib/insights.js` | 13,889 | required by lib/commands/insights.js:7 |
| `lib/issue-adapter.js` | 3,637 | required by lib/adapters/kernel-issue-adapter.js:7 |
| `lib/issue-backend.js` | 6,245 | required by lib/commands/plan.js:14 |
| `lib/issue-render.js` | 9,587 | required by lib/commands/_issue.js:13 |
| `lib/issue-sync/authority.js` | 2,202 | required by lib/issue-sync/project-github.js:3 |
| `lib/issue-sync/project-github.js` | 2,859 | required by lib/forge-issues.js:5 |
| `lib/kernel/backing-issue.js` | 13,506 | required by lib/commands/push.js:127 |
| `lib/kernel/broker.js` | 98,371 | required by lib/commands/doctor.js:11 |
| `lib/kernel/claim-reconciler.js` | 7,270 | required by lib/commands/clean.js:650 |
| `lib/kernel/cli-broker-factory.js` | 5,352 | required by lib/commands/clean.js:583 |
| `lib/kernel/close-on-merge.js` | 6,666 | required by lib/commands/clean.js:605 |
| `lib/kernel/conflict-signal.js` | 3,983 | required by lib/kernel/broker.js:9 |
| `lib/kernel/evaluators.js` | 5,985 | required by lib/kernel/broker.js:8 |
| `lib/kernel/fs-class.js` | 19,068 | required by lib/commands/doctor.js:12 |
| `lib/kernel/issue-command-contract.js` | 20,481 | required by lib/commands/_issue.js:11 |
| `lib/kernel/issue-id-resolver.js` | 8,411 | required by lib/commands/pr.js:12 |
| `lib/kernel/lease-enforcer.js` | 8,547 | required by lib/forge-issues.js:9 |
| `lib/kernel/legacy-claim-repair.js` | 16,831 | required by lib/kernel/sqlite-driver.js:29 |
| `lib/kernel/live-claim-projection.js` | 932 | required by lib/kernel/broker.js:12 |
| `lib/kernel/migrations.js` | 19,956 | required by lib/kernel/broker.js:10 |
| `lib/kernel/owned-kernel.js` | 1,979 | required by lib/commands/pr.js:11 |
| `lib/kernel/projection-jsonl-writer.js` | 15,697 | required by lib/commands/export.js:10 |
| `lib/kernel/readiness-model.js` | 19,047 | required by lib/kernel/close-on-merge.js:37 |
| `lib/kernel/schema.js` | 17,977 | required by lib/kernel/migrations.js:1 |
| `lib/kernel/sqlite-driver.js` | 252,425 | required by lib/kernel/cli-broker-factory.js:29 |
| `lib/kernel/taxonomy-validator.js` | 14,497 | required by lib/kernel/broker.js:26 |
| `lib/kernel/windows-private-acl.js` | 10,425 | spawned by path: lib/kernel/sqlite-driver.js:5608 (`path.join(__dirname, 'windows-private-acl.js')`); also ASSET_ROOTS lib/package-root.js:73 |
| `lib/lefthook-check.js` | 2,761 | required by bin/forge.js:98 |
| `lib/lefthook-wiring.js` | 19,063 | required by bin/forge.js:104 |
| `lib/mcp-config-renderer.js` | 10,316 | required by lib/commands/setup.js:36 |
| `lib/memory-digest.js` | 11,743 | required by lib/commands/hooks.js:33 |
| `lib/memory-recall-events.js` | 4,835 | required by lib/commands/hooks.js:39 |
| `lib/memory-recall.js` | 9,266 | required by lib/commands/hooks.js:38 |
| `lib/memory/graphiti-mcp.js` | 3,772 | required by lib/commands/setup.js:1987 |
| `lib/memory/hygiene.js` | 6,660 | required by lib/commands/memory.js:8 |
| `lib/memory/router.js` | 18,932 | required by lib/commands/doctor.js:13 |
| `lib/memory/typed-api.js` | 3,054 | required by lib/insights.js:5 |
| `lib/memory/usage-evidence.js` | 134 | UNSURE: compatibility require-path shim (`module.exports = require('@forge/memory')`, lib/memory/usage-evidence.js:3-4); no CLI reader, kept for deep importers |
| `lib/merge-rules.js` | 23,562 | required by lib/commands/merge.js:45 |
| `lib/migrate-dry-run.js` | 13,604 | required by lib/commands/migrate.js:11 |
| `lib/native-gh.js` | 7,552 | required by bin/forge-gh-proxy.js:4 |
| `lib/npm-publish-workflow.js` | 15,385 | required by lib/commands/release.js:11 |
| `lib/orientation.js` | 45,567 | required by lib/commands/orient.js:6 |
| `lib/package-manager-remediation.js` | 3,406 | required by lib/lefthook-check.js:8 |
| `lib/package-root.js` | 14,717 | required by bin/forge.js:79 |
| `lib/patch-intent.js` | 29,740 | required by lib/commands/patch.js:6 |
| `lib/plugin-catalog.js` | 11,026 | required by lib/commands/recommend.js:10 |
| `lib/plugin-manager.js` | 8,552 | required by bin/forge.js:56 |
| `lib/plugin-recommender.js` | 4,386 | required by lib/commands/recommend.js:8 |
| `lib/pr-bundle.js` | 7,919 | required by lib/commands/shepherd.js:33 |
| `lib/pr-monitor/differ.js` | 10,531 | required by lib/pr-monitor/flow-monitor.js:15 |
| `lib/pr-monitor/digest.js` | 7,387 | required by lib/commands/hooks.js:35 |
| `lib/pr-monitor/events.js` | 5,742 | required by lib/commands/shepherd.js:46 |
| `lib/pr-monitor/flow-monitor.js` | 57,053 | required by lib/commands/shepherd.js:38 |
| `lib/pr-monitor/gather.js` | 11,560 | required by lib/commands/shepherd.js:37 |
| `lib/pr-monitor/journal.js` | 10,630 | required by lib/commands/shepherd.js:44 |
| `lib/pr-monitor/monitor.js` | 10,395 | required by lib/commands/shepherd.js:39 |
| `lib/pr-monitor/process-identity.js` | 4,863 | required by lib/pr-monitor/reconcile-executor.js:22 |
| `lib/pr-monitor/reconcile-executor.js` | 56,459 | required by lib/commands/hooks.js:41 |
| `lib/pr-monitor/reconcile-tick.js` | 5,191 | required by lib/pr-monitor/reconcile-executor.js:19 |
| `lib/pr-monitor/reconcile.js` | 11,473 | required by lib/pr-monitor/reconcile-executor.js:18 |
| `lib/pr-monitor/review-preflight.js` | 9,958 | required by lib/commands/shepherd.js:48 |
| `lib/pr-monitor/shepherd-lease.js` | 10,179 | required by lib/pr-monitor/reconcile-executor.js:16 |
| `lib/pr-monitor/verdict.js` | 16,100 | required by lib/merge-rules.js:66 |
| `lib/pr-monitor/watch-lifecycle.js` | 8,891 | required by lib/commands/serve.js:34 |
| `lib/pr-monitor/watch-owner.js` | 62,812 | required by lib/commands/shepherd.js:42 |
| `lib/pr-monitor/watch.js` | 12,078 | required by lib/commands/shepherd.js:40 |
| `lib/pr-pull.js` | 62,602 | required by lib/commands/shepherd.js:34 |
| `lib/pr-shepherd.js` | 20,424 | required by lib/commands/shepherd.js:32 |
| `lib/pr-state-validator.js` | 1,601 | required by lib/commands/shepherd.js:36 |
| `lib/preflight/gates.js` | 10,262 | required by lib/commands/preflight.js:20 |
| `lib/preflight/runner.js` | 3,883 | required by lib/commands/preflight.js:21 |
| `lib/project-discovery.js` | 15,613 | required by bin/forge.js:86 |
| `lib/project-memory.js` | 13,513 | required by lib/commands/hooks.js:37 |
| `lib/protected-state-authority.js` | 53,297 | required by lib/commands/setup.js:97 |
| `lib/protected-state-surfaces.js` | 19,888 | required by lib/commands/worktree.js:12 |
| `lib/release-readiness.js` | 65,561 | required by lib/commands/release.js:8 |
| `lib/reset.js` | 8,837 | required by bin/forge.js:66 |
| `lib/review-adapter.js` | 3,620 | required by lib/adapter-cli.js:6 |
| `lib/rules-sync.js` | 9,787 | required by lib/agents-config.js:4 |
| `lib/runtime-health.js` | 16,944 | required by lib/commands/setup.js:79 |
| `lib/safety-config-renderer.js` | 9,725 | required by lib/commands/setup.js:37 |
| `lib/setup-action-log.js` | 3,452 | required by bin/forge.js:94 |
| `lib/setup-summary-renderer.js` | 3,532 | required by bin/forge.js:96 |
| `lib/setup-utils.js` | 2,363 | required by bin/forge.js:95 |
| `lib/shell-utils.js` | 5,793 | required by bin/forge.js:126 |
| `lib/skill-eval.js` | 36,894 | required by lib/commands/skill.js:21 |
| `lib/skills-sync.js` | 14,144 | required by bin/forge.js:57 |
| `lib/smart-merge.js` | 3,827 | required by bin/forge.js:97 |
| `lib/smart-status/conflicts.js` | 5,150 | required by scripts/smart-status-sessions.js:11, run by scripts/smart-status.sh:229 (setup-copied: lib/commands/setup.js:273) |
| `lib/smart-status/scoring.js` | 4,371 | required by scripts/smart-status-score.js:6, run by scripts/smart-status.sh:204 (setup-copied: lib/commands/setup.js:273) |
| `lib/status/identity.js` | 1,293 | required by lib/status/snapshot.js:5 |
| `lib/status/presenter.js` | 6,870 | required by lib/commands/status.js:17 |
| `lib/status/snapshot.js` | 6,797 | required by lib/commands/status.js:12 |
| `lib/symlink-utils.js` | 4,461 | required by bin/forge.js:89 |
| `lib/sync-backend.js` | 6,542 | required by lib/commands/setup.js:59 |
| `lib/test-workflow.js` | 15,913 | required by lib/commands/release.js:12 |
| `lib/ui-utils.js` | 1,432 | required by lib/commands/setup.js:51 |
| `lib/untrusted-content.js` | 2,128 | required by lib/commands/inbox.js:23 |
| `lib/upgrade-safety.js` | 9,575 | required by lib/commands/upgrade.js:7 |
| `lib/using-forge.js` | 17,167 | required by lib/commands/hooks.js:36 |
| `lib/validation-receipt.js` | 10,787 | required by lib/commands/push.js:22 |
| `lib/workflow/enforce-stage.js` | 19,910 | required by bin/forge.js:80 |
| `lib/workflow/plan-authority.js` | 8,716 | required by lib/commands/plan.js:19 |
| `lib/workflow/stage-transition.js` | 4,608 | required by lib/commands/_issue.js:14 |
| `lib/workflow/stages.js` | 6,417 | required by bin/forge.js:81 |
| `lib/workflow/state-manager.js` | 9,349 | required by lib/commands/status.js:22 |
| `lib/workflow/state.js` | 11,138 | required by lib/commands/status.js:9 |
| `LICENSE` | 1,070 | npm always includes README/LICENSE regardless of `files` (registry page + license terms) |
| `node_modules/@forge/contracts/compatibility-matrix.v1.json` | 959 | bundled workspace (package.json `bundleDependencies`), not governed by `files`; entry required from lib (see sub-file evidence) — untouched here, owned by PR #577 |
| `node_modules/@forge/contracts/contract-baseline.v1.json` | 4,974 | bundled workspace (package.json `bundleDependencies`), not governed by `files`; entry required from lib (see sub-file evidence) — untouched here, owned by PR #577 |
| `node_modules/@forge/contracts/fixtures/v1/canonical-hash.json` | 227 | bundled workspace (package.json `bundleDependencies`), not governed by `files`; entry required from lib (see sub-file evidence) — untouched here, owned by PR #577 |
| `node_modules/@forge/contracts/fixtures/v1/contract-inputs.v1.json` | 9,767 | bundled workspace (package.json `bundleDependencies`), not governed by `files`; entry required from lib (see sub-file evidence) — untouched here, owned by PR #577 |
| `node_modules/@forge/contracts/fixtures/v1/feedback-secret-reject.json` | 369 | bundled workspace (package.json `bundleDependencies`), not governed by `files`; entry required from lib (see sub-file evidence) — untouched here, owned by PR #577 |
| `node_modules/@forge/contracts/fixtures/v1/identity-conflict.json` | 420 | bundled workspace (package.json `bundleDependencies`), not governed by `files`; entry required from lib (see sub-file evidence) — untouched here, owned by PR #577 |
| `node_modules/@forge/contracts/fixtures/v1/malformed-envelope-inputs.v1.json` | 1,137 | bundled workspace (package.json `bundleDependencies`), not governed by `files`; entry required from lib (see sub-file evidence) — untouched here, owned by PR #577 |
| `node_modules/@forge/contracts/fixtures/v1/malformed-missing-required.json` | 188 | bundled workspace (package.json `bundleDependencies`), not governed by `files`; entry required from lib (see sub-file evidence) — untouched here, owned by PR #577 |
| `node_modules/@forge/contracts/fixtures/v1/monitor-bounds-reject.json` | 389 | bundled workspace (package.json `bundleDependencies`), not governed by `files`; entry required from lib (see sub-file evidence) — untouched here, owned by PR #577 |
| `node_modules/@forge/contracts/fixtures/v1/monitor-receipt-privacy-reject.json` | 359 | bundled workspace (package.json `bundleDependencies`), not governed by `files`; entry required from lib (see sub-file evidence) — untouched here, owned by PR #577 |
| `node_modules/@forge/contracts/fixtures/v1/not-executed-receipt.json` | 372 | bundled workspace (package.json `bundleDependencies`), not governed by `files`; entry required from lib (see sub-file evidence) — untouched here, owned by PR #577 |
| `node_modules/@forge/contracts/fixtures/v1/privacy-redaction.json` | 505 | bundled workspace (package.json `bundleDependencies`), not governed by `files`; entry required from lib (see sub-file evidence) — untouched here, owned by PR #577 |
| `node_modules/@forge/contracts/fixtures/v1/retry-identical.json` | 298 | bundled workspace (package.json `bundleDependencies`), not governed by `files`; entry required from lib (see sub-file evidence) — untouched here, owned by PR #577 |
| `node_modules/@forge/contracts/fixtures/v1/stale-authority-reject.json` | 425 | bundled workspace (package.json `bundleDependencies`), not governed by `files`; entry required from lib (see sub-file evidence) — untouched here, owned by PR #577 |
| `node_modules/@forge/contracts/fixtures/v1/structured-error-privacy-reject.json` | 373 | bundled workspace (package.json `bundleDependencies`), not governed by `files`; entry required from lib (see sub-file evidence) — untouched here, owned by PR #577 |
| `node_modules/@forge/contracts/fixtures/v1/structured-error-stripe-live-reject.json` | 361 | bundled workspace (package.json `bundleDependencies`), not governed by `files`; entry required from lib (see sub-file evidence) — untouched here, owned by PR #577 |
| `node_modules/@forge/contracts/fixtures/v1/structured-error-stripe-test-reject.json` | 361 | bundled workspace (package.json `bundleDependencies`), not governed by `files`; entry required from lib (see sub-file evidence) — untouched here, owned by PR #577 |
| `node_modules/@forge/contracts/fixtures/v1/unknown-advisory-roundtrip.json` | 363 | bundled workspace (package.json `bundleDependencies`), not governed by `files`; entry required from lib (see sub-file evidence) — untouched here, owned by PR #577 |
| `node_modules/@forge/contracts/fixtures/v1/unknown-consequential-reject.json` | 390 | bundled workspace (package.json `bundleDependencies`), not governed by `files`; entry required from lib (see sub-file evidence) — untouched here, owned by PR #577 |
| `node_modules/@forge/contracts/fixtures/v1/valid-full.json` | 380 | bundled workspace (package.json `bundleDependencies`), not governed by `files`; entry required from lib (see sub-file evidence) — untouched here, owned by PR #577 |
| `node_modules/@forge/contracts/fixtures/v1/valid-minimal.json` | 200 | bundled workspace (package.json `bundleDependencies`), not governed by `files`; entry required from lib (see sub-file evidence) — untouched here, owned by PR #577 |
| `node_modules/@forge/contracts/fixtures/v1/wrong-capability-digest.json` | 429 | bundled workspace (package.json `bundleDependencies`), not governed by `files`; entry required from lib (see sub-file evidence) — untouched here, owned by PR #577 |
| `node_modules/@forge/contracts/index.js` | 881 | bundled workspace (package.json `bundleDependencies`); required by lib/commands/merge.js:50 |
| `node_modules/@forge/contracts/package.json` | 817 | bundled workspace (package.json `bundleDependencies`), not governed by `files`; entry required from lib (see sub-file evidence) — untouched here, owned by PR #577 |
| `node_modules/@forge/contracts/schemas/v1/capability-manifest.schema.json` | 2,741 | bundled workspace (package.json `bundleDependencies`), not governed by `files`; entry required from lib (see sub-file evidence) — untouched here, owned by PR #577 |
| `node_modules/@forge/contracts/schemas/v1/claim-request.schema.json` | 2,184 | bundled workspace (package.json `bundleDependencies`), not governed by `files`; entry required from lib (see sub-file evidence) — untouched here, owned by PR #577 |
| `node_modules/@forge/contracts/schemas/v1/context-packet.schema.json` | 3,320 | bundled workspace (package.json `bundleDependencies`), not governed by `files`; entry required from lib (see sub-file evidence) — untouched here, owned by PR #577 |
| `node_modules/@forge/contracts/schemas/v1/delivery-receipt.schema.json` | 2,274 | bundled workspace (package.json `bundleDependencies`), not governed by `files`; entry required from lib (see sub-file evidence) — untouched here, owned by PR #577 |
| `node_modules/@forge/contracts/schemas/v1/feedback-report.schema.json` | 3,764 | bundled workspace (package.json `bundleDependencies`), not governed by `files`; entry required from lib (see sub-file evidence) — untouched here, owned by PR #577 |
| `node_modules/@forge/contracts/schemas/v1/lease-receipt.schema.json` | 2,329 | bundled workspace (package.json `bundleDependencies`), not governed by `files`; entry required from lib (see sub-file evidence) — untouched here, owned by PR #577 |
| `node_modules/@forge/contracts/schemas/v1/monitor-event.schema.json` | 2,750 | bundled workspace (package.json `bundleDependencies`), not governed by `files`; entry required from lib (see sub-file evidence) — untouched here, owned by PR #577 |
| `node_modules/@forge/contracts/schemas/v1/monitor-receipt.schema.json` | 3,264 | bundled workspace (package.json `bundleDependencies`), not governed by `files`; entry required from lib (see sub-file evidence) — untouched here, owned by PR #577 |
| `node_modules/@forge/contracts/schemas/v1/run-receipt.schema.json` | 4,316 | bundled workspace (package.json `bundleDependencies`), not governed by `files`; entry required from lib (see sub-file evidence) — untouched here, owned by PR #577 |
| `node_modules/@forge/contracts/schemas/v1/structured-error.schema.json` | 2,659 | bundled workspace (package.json `bundleDependencies`), not governed by `files`; entry required from lib (see sub-file evidence) — untouched here, owned by PR #577 |
| `node_modules/@forge/contracts/schemas/v1/work-packet.schema.json` | 3,437 | bundled workspace (package.json `bundleDependencies`), not governed by `files`; entry required from lib (see sub-file evidence) — untouched here, owned by PR #577 |
| `node_modules/@forge/contracts/src/baseline.js` | 789 | bundled workspace (package.json `bundleDependencies`); required by node_modules/@forge/contracts/index.js:4 |
| `node_modules/@forge/contracts/src/canonical.js` | 6,204 | bundled workspace (package.json `bundleDependencies`); required by node_modules/@forge/contracts/index.js:3 |
| `node_modules/@forge/contracts/src/definitions.js` | 11,388 | bundled workspace (package.json `bundleDependencies`); required by node_modules/@forge/contracts/index.js:5 |
| `node_modules/@forge/contracts/src/identity.js` | 1,400 | bundled workspace (package.json `bundleDependencies`); required by node_modules/@forge/contracts/index.js:6 |
| `node_modules/@forge/contracts/src/schema.js` | 2,910 | bundled workspace (package.json `bundleDependencies`); required by node_modules/@forge/contracts/index.js:7 |
| `node_modules/@forge/contracts/src/validate.js` | 19,348 | bundled workspace (package.json `bundleDependencies`); required by node_modules/@forge/contracts/index.js:15 |
| `node_modules/@forge/flow/index.js` | 3,445 | bundled workspace (package.json `bundleDependencies`); required by lib/pr-monitor/flow-monitor.js:14 |
| `node_modules/@forge/flow/package.json` | 754 | bundled workspace (package.json `bundleDependencies`), not governed by `files`; entry required from lib (see sub-file evidence) — untouched here, owned by PR #577 |
| `node_modules/@forge/flow/src/bounded-loop.js` | 16,653 | bundled workspace (package.json `bundleDependencies`); required by node_modules/@forge/flow/index.js:19 |
| `node_modules/@forge/flow/src/efficiency-supervisor.js` | 2,706 | bundled workspace (package.json `bundleDependencies`); required by node_modules/@forge/flow/index.js:12 |
| `node_modules/@forge/flow/src/executor.js` | 11,483 | bundled workspace (package.json `bundleDependencies`); required by node_modules/@forge/flow/index.js:4 |
| `node_modules/@forge/flow/src/monitor-durability.js` | 14,532 | bundled workspace (package.json `bundleDependencies`); required by node_modules/@forge/flow/index.js:29 |
| `node_modules/@forge/flow/src/monitor-runtime.js` | 18,907 | bundled workspace (package.json `bundleDependencies`); required by node_modules/@forge/flow/index.js:11 |
| `node_modules/@forge/flow/src/process-lifecycle.js` | 20,132 | bundled workspace (package.json `bundleDependencies`); required by node_modules/@forge/flow/index.js:25 |
| `node_modules/@forge/flow/src/skill-runtime.js` | 11,047 | bundled workspace (package.json `bundleDependencies`); required by node_modules/@forge/flow/index.js:13 |
| `node_modules/@forge/memory/index.js` | 12,067 | bundled workspace (package.json `bundleDependencies`); required by lib/commands/merge.js:592 |
| `node_modules/@forge/memory/package.json` | 723 | bundled workspace (package.json `bundleDependencies`), not governed by `files`; entry required from lib (see sub-file evidence) — untouched here, owned by PR #577 |
| `node_modules/@forge/memory/src/authority-provider.js` | 2,346 | bundled workspace (package.json `bundleDependencies`); required by node_modules/@forge/memory/index.js:320 |
| `node_modules/@forge/memory/src/backend-registry.js` | 5,293 | bundled workspace (package.json `bundleDependencies`); required by node_modules/@forge/memory/index.js:321 |
| `node_modules/@forge/memory/src/feedback-intake.js` | 8,970 | bundled workspace (package.json `bundleDependencies`); required by node_modules/@forge/memory/index.js:322 |
| `node_modules/@forge/memory/src/pr-lifecycle-authority.js` | 49,062 | bundled workspace (package.json `bundleDependencies`); required by node_modules/@forge/memory/index.js:323 |
| `node_modules/@forge/memory/src/usage-evidence.js` | 10,808 | bundled workspace (package.json `bundleDependencies`); required by node_modules/@forge/memory/index.js:324 |
| `package.json` | 5,246 | required by bin/forge.js:47 |
| `README.md` | 17,416 | npm always includes README/LICENSE regardless of `files` (registry page + license terms) |
| `rules/documentation.md` | 739 | read by lib/rules-sync.js:108 (`path.join(sourceRoot, CANONICAL_RULES_DIR, `${name}.md`)`) for every name in CURSOR_RULE_FILES lib/rules-sync.js:45-54 |
| `rules/kernel-tracking.md` | 1,231 | read by lib/rules-sync.js:108 (`path.join(sourceRoot, CANONICAL_RULES_DIR, `${name}.md`)`) for every name in CURSOR_RULE_FILES lib/rules-sync.js:45-54 |
| `rules/security.md` | 831 | read by lib/rules-sync.js:108 (`path.join(sourceRoot, CANONICAL_RULES_DIR, `${name}.md`)`) for every name in CURSOR_RULE_FILES lib/rules-sync.js:45-54 |
| `rules/tdd.md` | 777 | read by lib/rules-sync.js:108 (`path.join(sourceRoot, CANONICAL_RULES_DIR, `${name}.md`)`) for every name in CURSOR_RULE_FILES lib/rules-sync.js:45-54 |
| `rules/using-forge.md` | 1,234 | read by lib/rules-sync.js:108 (`path.join(sourceRoot, CANONICAL_RULES_DIR, `${name}.md`)`) for every name in CURSOR_RULE_FILES lib/rules-sync.js:45-54 |
| `rules/workflow.md` | 1,236 | read by lib/rules-sync.js:108 (`path.join(sourceRoot, CANONICAL_RULES_DIR, `${name}.md`)`) for every name in CURSOR_RULE_FILES lib/rules-sync.js:45-54 |
| `scripts/bootstrap-windows-tools.sh` | 1,527 | sourced as a sibling by shipped runtime scripts: scripts/conflict-detect.sh:20-21, dep-guard.sh:17-18, file-index.sh:24-25, pr-coordinator.sh:18-19, smart-status.sh:28-29, .claude/scripts/review-resolve.sh:14-15 |
| `scripts/check-forge-token.js` | 3,990 | required by lib/commands/push.js:7 |
| `scripts/conflict-detect.sh` | 10,491 | setup-copied WORKFLOW_RUNTIME_ASSETS lib/commands/setup.js:267-275 (copy loop :664) |
| `scripts/dep-guard-analyze.js` | 2,686 | setup-copied WORKFLOW_RUNTIME_ASSETS lib/commands/setup.js:269; run by scripts/dep-guard.sh:240 |
| `scripts/dep-guard-keyword-ripple.js` | 652 | run by scripts/dep-guard.sh:371 (setup-copied runtime script) |
| `scripts/dep-guard-render-review.js` | 2,504 | run by scripts/dep-guard.sh:252 (setup-copied runtime script) |
| `scripts/dep-guard.sh` | 18,831 | setup-copied WORKFLOW_RUNTIME_ASSETS lib/commands/setup.js:267-275 (copy loop :664) |
| `scripts/file-index.sh` | 15,501 | setup-copied WORKFLOW_RUNTIME_ASSETS lib/commands/setup.js:267-275 (copy loop :664) |
| `scripts/forge-team/index.sh` | 2,614 | executed from the package by `forge team`: lib/commands/team.js:47; setup-copied lib/commands/setup.js:278 |
| `scripts/forge-team/lib/agent-prompt.sh` | 1,553 | setup-copied WORKFLOW_RUNTIME_ASSETS lib/commands/setup.js:279-286; sourced by scripts/forge-team/index.sh (run by lib/commands/team.js:47) |
| `scripts/forge-team/lib/claim.sh` | 8,380 | setup-copied WORKFLOW_RUNTIME_ASSETS lib/commands/setup.js:279-286; sourced by scripts/forge-team/index.sh (run by lib/commands/team.js:47) |
| `scripts/forge-team/lib/epic.sh` | 6,941 | setup-copied WORKFLOW_RUNTIME_ASSETS lib/commands/setup.js:279-286; sourced by scripts/forge-team/index.sh (run by lib/commands/team.js:47) |
| `scripts/forge-team/lib/hooks.sh` | 7,441 | setup-copied WORKFLOW_RUNTIME_ASSETS lib/commands/setup.js:279-286; sourced by scripts/forge-team/index.sh (run by lib/commands/team.js:47) |
| `scripts/forge-team/lib/identity.sh` | 6,843 | setup-copied WORKFLOW_RUNTIME_ASSETS lib/commands/setup.js:279-286; sourced by scripts/forge-team/index.sh (run by lib/commands/team.js:47) |
| `scripts/forge-team/lib/sync-github.sh` | 12,403 | setup-copied WORKFLOW_RUNTIME_ASSETS lib/commands/setup.js:279-286; sourced by scripts/forge-team/index.sh (run by lib/commands/team.js:47) |
| `scripts/forge-team/lib/verify.sh` | 11,660 | setup-copied WORKFLOW_RUNTIME_ASSETS lib/commands/setup.js:279-286; sourced by scripts/forge-team/index.sh (run by lib/commands/team.js:47) |
| `scripts/forge-team/lib/workload.sh` | 9,103 | setup-copied WORKFLOW_RUNTIME_ASSETS lib/commands/setup.js:279-286; sourced by scripts/forge-team/index.sh (run by lib/commands/team.js:47) |
| `scripts/github-context-bridge.sh` | 366 | executed from the package by `forge team`: lib/commands/team.js:61 (`GH_CMD: path.join(packageRoot, 'scripts', 'github-context-bridge.sh')`) |
| `scripts/legacy-claim-repair.js` | 4,806 | UNSURE: operator repair tool for kernel stores, documented as a command to run in docs/reference/LEGACY_CLAIM_REPAIR.md:39; no CLI caller |
| `scripts/lib/behavioral-eval-runner.js` | 10,350 | required by lib/commands/skill.js:22 |
| `scripts/lib/behavioral-eval-runtime.js` | 15,534 | required by lib/commands/skill.js:23 |
| `scripts/lib/eval-evidence.js` | 12,738 | required by scripts/lib/behavioral-eval-runner.js:4 |
| `scripts/lib/eval-runner.js` | 11,573 | required by scripts/lib/behavioral-eval-runtime.js:15 |
| `scripts/lib/immutable-eval-corpus.js` | 11,915 | required by scripts/lib/behavioral-eval-runner.js:3 |
| `scripts/lib/jsonl-lock.sh` | 1,680 | setup-copied WORKFLOW_RUNTIME_ASSETS lib/commands/setup.js:276-277; sourced by scripts/forge-team/lib/identity.sh:31,37 |
| `scripts/lib/promotion-evidence-loader.js` | 3,450 | required by lib/commands/skill.js:24 |
| `scripts/lib/promotion-scorecard.js` | 10,579 | required by lib/commands/skill.js:25 |
| `scripts/lib/sanitize.sh` | 4,829 | setup-copied WORKFLOW_RUNTIME_ASSETS lib/commands/setup.js:276-277; sourced by scripts/forge-team/lib/identity.sh:31,37 |
| `scripts/lib/transcript-parser.js` | 1,616 | required by scripts/lib/behavioral-eval-runtime.js:16 |
| `scripts/pr-coordinator.sh` | 23,297 | setup-copied WORKFLOW_RUNTIME_ASSETS lib/commands/setup.js:267-275 (copy loop :664) |
| `scripts/preflight-sonar.eslint.config.mjs` | 1,745 | UNSURE: `forge preflight` sonar gate passes it to eslint, lib/preflight/gates.js:167 — but resolves it under projectRoot, not the package root |
| `scripts/process-tree.js` | 26,516 | required by lib/commands/push.js:20 |
| `scripts/smart-status-score.js` | 747 | run by scripts/smart-status.sh:204 (setup-copied runtime script) |
| `scripts/smart-status-sessions.js` | 1,122 | run by scripts/smart-status.sh:229 (setup-copied runtime script) |
| `scripts/smart-status.sh` | 30,033 | setup-copied WORKFLOW_RUNTIME_ASSETS lib/commands/setup.js:267-275 (copy loop :664) |
| `scripts/sync-utils.sh` | 16,419 | setup-copied WORKFLOW_RUNTIME_ASSETS lib/commands/setup.js:267-275 (copy loop :664) |
| `scripts/test.js` | 24,466 | required by lib/commands/push.js:14 |
| `scripts/validate.sh` | 3,122 | setup-copied WORKFLOW_RUNTIME_ASSETS lib/commands/setup.js:267-275 (copy loop :664) |
| `skills/claim-safety/evals/evals.json` | 1,326 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/claim-safety/evals/scorecard.json` | 965 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/claim-safety/SKILL.md` | 6,081 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/coverage.json` | 4,286 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/dev/evals/evals.json` | 1,481 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/dev/evals/scorecard.json` | 957 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/dev/SKILL.md` | 12,269 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/gates/evals/evals.json` | 973 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/gates/evals/scorecard.json` | 955 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/gates/SKILL.md` | 4,518 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/hermes-forge/evals/evals.json` | 1,867 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/hermes-forge/evals/scorecard.json` | 966 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/hermes-forge/SKILL.md` | 9,089 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/issue-basics/evals/evals.json` | 1,155 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/issue-basics/evals/scorecard.json` | 963 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/issue-basics/SKILL.md` | 6,272 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/kernel/evals/evals.json` | 2,041 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/kernel/evals/scorecard.json` | 958 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/kernel/SKILL.md` | 10,486 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/memory/evals/scorecard.json` | 968 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/memory/SKILL.md` | 6,384 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/parallel-deep-research/evals/evals.json` | 2,397 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/parallel-deep-research/evals/README.md` | 715 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/parallel-deep-research/evals/scorecard.json` | 974 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/parallel-deep-research/SKILL.md` | 3,983 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/plan/evals/evals.json` | 1,761 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/plan/evals/scorecard.json` | 956 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/plan/SKILL.md` | 24,457 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/portability/evals/evals.json` | 847 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/portability/evals/scorecard.json` | 961 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/portability/SKILL.md` | 3,320 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/research/evals/evals.json` | 1,831 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/research/evals/scorecard.json` | 962 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/research/SKILL.md` | 9,596 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/review/evals/evals.json` | 1,618 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/review/evals/scorecard.json` | 959 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/review/SKILL.md` | 16,349 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/rollback/evals/evals.json` | 1,263 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/rollback/evals/scorecard.json` | 961 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/rollback/references/methods.md` | 4,597 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/rollback/references/workflow-integration.md` | 9,863 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/rollback/SKILL.md` | 3,523 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/setup/evals/evals.json` | 1,108 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/setup/evals/scorecard.json` | 956 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/setup/SKILL.md` | 5,557 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/shepherd/evals/evals.json` | 1,592 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/shepherd/evals/scorecard.json` | 962 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/shepherd/SKILL.md` | 8,844 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/ship/evals/evals.json` | 1,427 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/ship/evals/scorecard.json` | 957 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/ship/SKILL.md` | 10,036 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/smith/evals/evals.json` | 2,144 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/smith/evals/scorecard.json` | 957 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/smith/references/autonomy-and-gates.md` | 5,284 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/smith/SKILL.md` | 8,290 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/sonarcloud-analysis/evals/evals.json` | 1,702 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/sonarcloud-analysis/evals/README.md` | 715 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/sonarcloud-analysis/evals/scorecard.json` | 971 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/sonarcloud-analysis/references/api-reference.md` | 11,401 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/sonarcloud-analysis/SKILL.md` | 8,114 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/sonarcloud/evals/evals.json` | 1,485 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/sonarcloud/evals/scorecard.json` | 961 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/sonarcloud/SKILL.md` | 5,206 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/status/evals/evals.json` | 1,357 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/status/evals/scorecard.json` | 959 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/status/SKILL.md` | 3,959 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/triage-ready/evals/evals.json` | 1,281 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/triage-ready/evals/scorecard.json` | 965 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/triage-ready/SKILL.md` | 5,895 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/using-forge/evals/scorecard.json` | 974 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/using-forge/SKILL.md` | 5,679 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/validate/evals/evals.json` | 1,203 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/validate/evals/scorecard.json` | 961 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/validate/SKILL.md` | 11,506 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/verify/evals/evals.json` | 1,316 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/verify/evals/scorecard.json` | 960 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/verify/SKILL.md` | 10,599 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/worktree/evals/evals.json` | 1,033 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/worktree/evals/scorecard.json` | 959 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |
| `skills/worktree/SKILL.md` | 5,044 | canonical skills tree copied recursively into each harness by lib/skills-sync.js:230-271 (populateAgentSkills, listFilesRecursive); evals/scorecard/coverage JSON read by lib/skill-eval.js:215, :368, :426 |

## MOVE-OUT (116 files, 1,005,410 bytes)

| Path | Bytes | Evidence |
|---|---:|---|
| `.claude/rules/review-process.md` | 9,108 | not copied by setup (claude.plugin.json has no rules dir, lib/release-readiness.js:19-20); lib/reset.js:26 only removes the project path; skills reference the project-relative path |
| `.cursor/rules/permissions-guidance.mdc` | 1,452 | no runtime reader; Cursor rules are generated from rules/ by lib/rules-sync.js; only test/release-readiness.test.js:211 fixture |
| `.forge/protected-paths.yaml` | 4,536 | only reader is lib/protected-path-manifest.js:37, which is unreachable from the CLI; `forge init` renders its own (lib/commands/init.js:312, :393) |
| `.github/PLUGIN_TEMPLATE.json` | 809 | contributor template referenced from lib/agents/README.md:117 (prose); lib/protected-state-surfaces.js:111 only classifies the repo path |
| `.mcp.json.example` | 224 | no runtime reader; setup renders MCP config via lib/mcp-config-renderer.js; referenced only by .gitignore:83 and tests |
| `CHANGELOG.md` | 88,654 | no package read: lib/docs-command.js:93 lists it but validateDocs is called with projectRoot (bin/forge.js:3977); skills/ship/SKILL.md:217 edits the project CHANGELOG |
| `CLAUDE.md` | 11 | setup creates the project CLAUDE.md from AGENTS.md via createSymlinkOrCopy (lib/commands/setup.js:2156), never from the package copy |
| `docs/architecture/index.md` | 2,071 | not read at runtime: `forge docs` reads only TOOLCHAIN/VALIDATION/SETUP/EXAMPLES/ROADMAP (lib/docs-command.js:9-19); runtime messages that name docs paths only print the string |
| `docs/architecture/notes/README.md` | 764 | not read at runtime: `forge docs` reads only TOOLCHAIN/VALIDATION/SETUP/EXAMPLES/ROADMAP (lib/docs-command.js:9-19); runtime messages that name docs paths only print the string |
| `docs/architecture/subsystems/README.md` | 857 | not read at runtime: `forge docs` reads only TOOLCHAIN/VALIDATION/SETUP/EXAMPLES/ROADMAP (lib/docs-command.js:9-19); runtime messages that name docs paths only print the string |
| `docs/forge/TOOLCHAIN.md` | 20,498 | not read at runtime: `forge docs` reads only TOOLCHAIN/VALIDATION/SETUP/EXAMPLES/ROADMAP (lib/docs-command.js:9-19); runtime messages that name docs paths only print the string |
| `docs/forge/VALIDATION.md` | 1,859 | not read at runtime: `forge docs` reads only TOOLCHAIN/VALIDATION/SETUP/EXAMPLES/ROADMAP (lib/docs-command.js:9-19); runtime messages that name docs paths only print the string |
| `docs/guides/AGENT_INSTALL_PROMPT.md` | 7,883 | not read at runtime: `forge docs` reads only TOOLCHAIN/VALIDATION/SETUP/EXAMPLES/ROADMAP (lib/docs-command.js:9-19); runtime messages that name docs paths only print the string |
| `docs/guides/BEADS_GITHUB_SYNC.md` | 861 | not read at runtime: `forge docs` reads only TOOLCHAIN/VALIDATION/SETUP/EXAMPLES/ROADMAP (lib/docs-command.js:9-19); runtime messages that name docs paths only print the string |
| `docs/guides/ENHANCED_ONBOARDING.md` | 12,936 | not read at runtime: `forge docs` reads only TOOLCHAIN/VALIDATION/SETUP/EXAMPLES/ROADMAP (lib/docs-command.js:9-19); runtime messages that name docs paths only print the string |
| `docs/guides/GREPTILE_SETUP.md` | 1,753 | not read at runtime: `forge docs` reads only TOOLCHAIN/VALIDATION/SETUP/EXAMPLES/ROADMAP (lib/docs-command.js:9-19); runtime messages that name docs paths only print the string |
| `docs/guides/MANUAL_REVIEW_GUIDE.md` | 1,952 | not read at runtime: `forge docs` reads only TOOLCHAIN/VALIDATION/SETUP/EXAMPLES/ROADMAP (lib/docs-command.js:9-19); runtime messages that name docs paths only print the string |
| `docs/guides/memory-backends.md` | 8,516 | not read at runtime: `forge docs` reads only TOOLCHAIN/VALIDATION/SETUP/EXAMPLES/ROADMAP (lib/docs-command.js:9-19); runtime messages that name docs paths only print the string |
| `docs/guides/MIGRATION.md` | 2,389 | not read at runtime: `forge docs` reads only TOOLCHAIN/VALIDATION/SETUP/EXAMPLES/ROADMAP (lib/docs-command.js:9-19); runtime messages that name docs paths only print the string |
| `docs/guides/SUPPORT.md` | 7,497 | not read at runtime: `forge docs` reads only TOOLCHAIN/VALIDATION/SETUP/EXAMPLES/ROADMAP (lib/docs-command.js:9-19); runtime messages that name docs paths only print the string |
| `docs/guides/WORKFLOW_TEMPLATES.md` | 3,733 | not read at runtime: `forge docs` reads only TOOLCHAIN/VALIDATION/SETUP/EXAMPLES/ROADMAP (lib/docs-command.js:9-19); runtime messages that name docs paths only print the string |
| `docs/INDEX.md` | 7,602 | not read at runtime: `forge docs` reads only TOOLCHAIN/VALIDATION/SETUP/EXAMPLES/ROADMAP (lib/docs-command.js:9-19); runtime messages that name docs paths only print the string |
| `docs/PROJECT_DESIGN.md` | 31,893 | not read at runtime: `forge docs` reads only TOOLCHAIN/VALIDATION/SETUP/EXAMPLES/ROADMAP (lib/docs-command.js:9-19); runtime messages that name docs paths only print the string |
| `docs/reference/ADAPTERS.md` | 4,920 | not read at runtime: `forge docs` reads only TOOLCHAIN/VALIDATION/SETUP/EXAMPLES/ROADMAP (lib/docs-command.js:9-19); runtime messages that name docs paths only print the string |
| `docs/reference/AGENT_SKILL_PARITY.md` | 16,899 | not read at runtime: `forge docs` reads only TOOLCHAIN/VALIDATION/SETUP/EXAMPLES/ROADMAP (lib/docs-command.js:9-19); runtime messages that name docs paths only print the string |
| `docs/reference/agent-permissions.md` | 8,292 | not read at runtime: `forge docs` reads only TOOLCHAIN/VALIDATION/SETUP/EXAMPLES/ROADMAP (lib/docs-command.js:9-19); runtime messages that name docs paths only print the string |
| `docs/reference/beads-to-kernel-migration-ux.md` | 3,743 | not read at runtime: `forge docs` reads only TOOLCHAIN/VALIDATION/SETUP/EXAMPLES/ROADMAP (lib/docs-command.js:9-19); runtime messages that name docs paths only print the string |
| `docs/reference/COMMANDS.md` | 11,807 | not read at runtime: `forge docs` reads only TOOLCHAIN/VALIDATION/SETUP/EXAMPLES/ROADMAP (lib/docs-command.js:9-19); runtime messages that name docs paths only print the string |
| `docs/reference/control-plane-guarantees.md` | 9,002 | not read at runtime: `forge docs` reads only TOOLCHAIN/VALIDATION/SETUP/EXAMPLES/ROADMAP (lib/docs-command.js:9-19); runtime messages that name docs paths only print the string |
| `docs/reference/DECISION_DRIFT_GUARDS.md` | 5,161 | not read at runtime: `forge docs` reads only TOOLCHAIN/VALIDATION/SETUP/EXAMPLES/ROADMAP (lib/docs-command.js:9-19); runtime messages that name docs paths only print the string |
| `docs/reference/dependency-chain.md` | 13,195 | not read at runtime: `forge docs` reads only TOOLCHAIN/VALIDATION/SETUP/EXAMPLES/ROADMAP (lib/docs-command.js:9-19); runtime messages that name docs paths only print the string |
| `docs/reference/FORGE_KERNEL_STORAGE_MODEL.md` | 6,780 | not read at runtime: `forge docs` reads only TOOLCHAIN/VALIDATION/SETUP/EXAMPLES/ROADMAP (lib/docs-command.js:9-19); runtime messages that name docs paths only print the string |
| `docs/reference/forge-kernel-issue-command-contract.md` | 5,563 | not read at runtime: `forge docs` reads only TOOLCHAIN/VALIDATION/SETUP/EXAMPLES/ROADMAP (lib/docs-command.js:9-19); runtime messages that name docs paths only print the string |
| `docs/reference/forge-kernel-schema.md` | 3,127 | not read at runtime: `forge docs` reads only TOOLCHAIN/VALIDATION/SETUP/EXAMPLES/ROADMAP (lib/docs-command.js:9-19); runtime messages that name docs paths only print the string |
| `docs/reference/github-accounts.md` | 11,730 | not read at runtime: `forge docs` reads only TOOLCHAIN/VALIDATION/SETUP/EXAMPLES/ROADMAP (lib/docs-command.js:9-19); runtime messages that name docs paths only print the string |
| `docs/reference/HERMES_INTEGRATION.md` | 5,729 | not read at runtime: `forge docs` reads only TOOLCHAIN/VALIDATION/SETUP/EXAMPLES/ROADMAP (lib/docs-command.js:9-19); runtime messages that name docs paths only print the string |
| `docs/reference/INSIGHTS_RECAP.md` | 2,207 | not read at runtime: `forge docs` reads only TOOLCHAIN/VALIDATION/SETUP/EXAMPLES/ROADMAP (lib/docs-command.js:9-19); runtime messages that name docs paths only print the string |
| `docs/reference/INSTALL.md` | 5,585 | not read at runtime: `forge docs` reads only TOOLCHAIN/VALIDATION/SETUP/EXAMPLES/ROADMAP (lib/docs-command.js:9-19); runtime messages that name docs paths only print the string |
| `docs/reference/KERNEL_TAXONOMY_VALIDATION.md` | 8,306 | not read at runtime: `forge docs` reads only TOOLCHAIN/VALIDATION/SETUP/EXAMPLES/ROADMAP (lib/docs-command.js:9-19); runtime messages that name docs paths only print the string |
| `docs/reference/kernel-conflict-evaluators.md` | 1,385 | not read at runtime: `forge docs` reads only TOOLCHAIN/VALIDATION/SETUP/EXAMPLES/ROADMAP (lib/docs-command.js:9-19); runtime messages that name docs paths only print the string |
| `docs/reference/LEGACY_CLAIM_REPAIR.md` | 5,307 | not read at runtime: `forge docs` reads only TOOLCHAIN/VALIDATION/SETUP/EXAMPLES/ROADMAP (lib/docs-command.js:9-19); runtime messages that name docs paths only print the string |
| `docs/reference/patch-md-format.md` | 2,998 | not read at runtime: `forge docs` reads only TOOLCHAIN/VALIDATION/SETUP/EXAMPLES/ROADMAP (lib/docs-command.js:9-19); runtime messages that name docs paths only print the string |
| `docs/reference/PROTECTED_PATH_MANIFEST.md` | 1,135 | not read at runtime: `forge docs` reads only TOOLCHAIN/VALIDATION/SETUP/EXAMPLES/ROADMAP (lib/docs-command.js:9-19); runtime messages that name docs paths only print the string |
| `docs/reference/protected-state-surfaces.md` | 4,125 | not read at runtime: `forge docs` reads only TOOLCHAIN/VALIDATION/SETUP/EXAMPLES/ROADMAP (lib/docs-command.js:9-19); runtime messages that name docs paths only print the string |
| `docs/reference/RELEASE.md` | 3,517 | not read at runtime: `forge docs` reads only TOOLCHAIN/VALIDATION/SETUP/EXAMPLES/ROADMAP (lib/docs-command.js:9-19); runtime messages that name docs paths only print the string |
| `docs/reference/RESEARCH_TEMPLATE.md` | 9,655 | not read at runtime: `forge docs` reads only TOOLCHAIN/VALIDATION/SETUP/EXAMPLES/ROADMAP (lib/docs-command.js:9-19); runtime messages that name docs paths only print the string |
| `docs/reference/shepherd.md` | 18,915 | not read at runtime: `forge docs` reads only TOOLCHAIN/VALIDATION/SETUP/EXAMPLES/ROADMAP (lib/docs-command.js:9-19); runtime messages that name docs paths only print the string |
| `docs/reference/SKILLS.md` | 1,880 | not read at runtime: `forge docs` reads only TOOLCHAIN/VALIDATION/SETUP/EXAMPLES/ROADMAP (lib/docs-command.js:9-19); runtime messages that name docs paths only print the string |
| `docs/reference/STATUS_BOARD.md` | 2,158 | not read at runtime: `forge docs` reads only TOOLCHAIN/VALIDATION/SETUP/EXAMPLES/ROADMAP (lib/docs-command.js:9-19); runtime messages that name docs paths only print the string |
| `docs/reference/superpowers-analysis.md` | 16,266 | not read at runtime: `forge docs` reads only TOOLCHAIN/VALIDATION/SETUP/EXAMPLES/ROADMAP (lib/docs-command.js:9-19); runtime messages that name docs paths only print the string |
| `docs/reference/superpowers-integration-options.md` | 19,741 | not read at runtime: `forge docs` reads only TOOLCHAIN/VALIDATION/SETUP/EXAMPLES/ROADMAP (lib/docs-command.js:9-19); runtime messages that name docs paths only print the string |
| `docs/reference/TEMPLATES.md` | 4,221 | not read at runtime: `forge docs` reads only TOOLCHAIN/VALIDATION/SETUP/EXAMPLES/ROADMAP (lib/docs-command.js:9-19); runtime messages that name docs paths only print the string |
| `docs/reference/test-environment.md` | 15,094 | not read at runtime: `forge docs` reads only TOOLCHAIN/VALIDATION/SETUP/EXAMPLES/ROADMAP (lib/docs-command.js:9-19); runtime messages that name docs paths only print the string |
| `docs/reference/upgrade-safety.md` | 2,164 | not read at runtime: `forge docs` reads only TOOLCHAIN/VALIDATION/SETUP/EXAMPLES/ROADMAP (lib/docs-command.js:9-19); runtime messages that name docs paths only print the string |
| `install.sh` | 1,067 | bootstrapper fetched before the package exists (install.sh:4-5); nothing inside the installed package runs it |
| `lefthook.yml` | 2,936 | repo dev hooks; setup writes FORGE_USER_LEFTHOOK_YML instead (lib/lefthook-wiring.js:36-50, lib/commands/setup.js:3063-3081) because this file references repo-only scripts |
| `lib/agents/README.md` | 7,998 | contributor doc; plugin-manager reads only *.plugin.json (lib/plugin-manager.js:239-240) |
| `lib/bun-lockfile-proof.js` | 16,005 | unreachable from CLI; required by scripts/protected-state-check.js:14 (repo lefthook pre-commit, lefthook.yml:33) |
| `lib/harness-capability-matrix.js` | 28,858 | unreachable from CLI; required by scripts/spikes/harness-capability-matrix.js:4 and tests; lib/release-readiness.js:1943 scans the repo path |
| `lib/pr-monitor/auto-actions.js` | 13,410 | CI-only: auto-actions.js is required by scripts/pr-auto-actions.js:24, run by .github/workflows/pr-monitor.yml:318; render-summary.js is required inline by .github/workflows/pr-monitor.yml:225 |
| `lib/pr-monitor/render-summary.js` | 12,092 | CI-only: auto-actions.js is required by scripts/pr-auto-actions.js:24, run by .github/workflows/pr-monitor.yml:318; render-summary.js is required inline by .github/workflows/pr-monitor.yml:225 |
| `lib/protected-path-manifest.js` | 10,082 | unreachable from CLI; required by scripts/spikes/protected-path-manifest.js:8 and test/protected-path-manifest.test.js |
| `lib/validation/risk-manifest.js` | 15,266 | unreachable from CLI; required by scripts/generate-risk-manifest.js:8 (repo tooling) and tests |
| `lib/workflow-profiles.js` | 6,784 | unreachable from CLI; only a path string scanned in the repo by lib/release-readiness.js:1938 and tests (test/workflow-profiles.test.js) |
| `lib/workflow-templates/test.yml` | 26,982 | read from projectRoot by `forge release generate-test-workflow` (lib/test-workflow.js:25, :200) — the Forge repo CI source, not a consumer template |
| `QUICKSTART.md` | 6,814 | no runtime reader; only doc-lane mapping strings in lib/commands/test.js:373 (repo test routing) |
| `scripts/auto-backing-issue.js` | 1,955 | repo lefthook.yml job (lefthook.yml:11/47/55/20/29/33/79); push.js:207 runs projectRoot/scripts/branch-protection.js, never the package copy |
| `scripts/behavioral-judge.sh` | 16,010 | repo CI / eval tooling (.github/workflows/behavioral-test.md:57; preflight.sh only listed as a scan path in lib/release-readiness.js:98; eval_win.py only named in skills/*/evals/README.md) |
| `scripts/benchmark.js` | 10,513 | repo test/CI runner tooling (package.json scripts, .github/workflows/test.yml); lib/commands/push.js:49-50 and validate.js:651-652 only use a projectRoot copy when the project itself has it |
| `scripts/branch-protection.js` | 6,143 | repo lefthook.yml job (lefthook.yml:11/47/55/20/29/33/79); push.js:207 runs projectRoot/scripts/branch-protection.js, never the package copy |
| `scripts/build-test-weights.js` | 3,100 | repo test/CI runner tooling (package.json scripts, .github/workflows/test.yml); lib/commands/push.js:49-50 and validate.js:651-652 only use a projectRoot copy when the project itself has it |
| `scripts/check-agents.js` | 5,535 | repo CI / maintainer tooling (.github/workflows or package.json `check`); any lib mention resolves it under projectRoot (e.g. lib/preflight/gates.js:116, lib/npm-publish-workflow.js:252) |
| `scripts/commitlint.js` | 1,222 | repo lefthook.yml job (lefthook.yml:11/47/55/20/29/33/79); push.js:207 runs projectRoot/scripts/branch-protection.js, never the package copy |
| `scripts/doc-asserting-tests.js` | 5,209 | repo CI / maintainer tooling (.github/workflows or package.json `check`); any lib mention resolves it under projectRoot (e.g. lib/preflight/gates.js:116, lib/npm-publish-workflow.js:252) |
| `scripts/eval_win.py` | 8,331 | repo CI / eval tooling (.github/workflows/behavioral-test.md:57; preflight.sh only listed as a scan path in lib/release-readiness.js:98; eval_win.py only named in skills/*/evals/README.md) |
| `scripts/forge-team/tests/agent-prompt.test.sh` | 2,444 | shell test files (the `!scripts/**/*.test.js` exclusion missed *.test.sh) |
| `scripts/forge-team/tests/claim.test.sh` | 6,327 | shell test files (the `!scripts/**/*.test.js` exclusion missed *.test.sh) |
| `scripts/forge-team/tests/dispatcher.test.sh` | 2,051 | shell test files (the `!scripts/**/*.test.js` exclusion missed *.test.sh) |
| `scripts/forge-team/tests/epic.test.sh` | 8,236 | shell test files (the `!scripts/**/*.test.js` exclusion missed *.test.sh) |
| `scripts/forge-team/tests/hooks.test.sh` | 7,875 | shell test files (the `!scripts/**/*.test.js` exclusion missed *.test.sh) |
| `scripts/forge-team/tests/identity.test.sh` | 6,610 | shell test files (the `!scripts/**/*.test.js` exclusion missed *.test.sh) |
| `scripts/forge-team/tests/integration.test.sh` | 10,652 | shell test files (the `!scripts/**/*.test.js` exclusion missed *.test.sh) |
| `scripts/forge-team/tests/sync-github.test.sh` | 9,468 | shell test files (the `!scripts/**/*.test.js` exclusion missed *.test.sh) |
| `scripts/forge-team/tests/verify.test.sh` | 9,633 | shell test files (the `!scripts/**/*.test.js` exclusion missed *.test.sh) |
| `scripts/forge-team/tests/workflow-integration.test.sh` | 1,365 | shell test files (the `!scripts/**/*.test.js` exclusion missed *.test.sh) |
| `scripts/forge-team/tests/workload.test.sh` | 8,856 | shell test files (the `!scripts/**/*.test.js` exclusion missed *.test.sh) |
| `scripts/gen-command-manifest.js` | 7,841 | build tooling (package.json gen:manifest / gen:assets / build:binary / parity:binary) |
| `scripts/gen-embedded-assets.mjs` | 6,540 | build tooling (package.json gen:manifest / gen:assets / build:binary / parity:binary) |
| `scripts/generate-risk-manifest.js` | 3,222 | repo CI / maintainer tooling (.github/workflows or package.json `check`); any lib mention resolves it under projectRoot (e.g. lib/preflight/gates.js:116, lib/npm-publish-workflow.js:252) |
| `scripts/install.ps1` | 5,535 | binary installers fetched from GitHub releases; nothing in the installed package runs them |
| `scripts/install.sh` | 10,032 | binary installers fetched from GitHub releases; nothing in the installed package runs them |
| `scripts/lib/ci-shard-partition.js` | 7,578 | repo test/CI runner tooling (package.json scripts, .github/workflows/test.yml); lib/commands/push.js:49-50 and validate.js:651-652 only use a projectRoot copy when the project itself has it |
| `scripts/lib/release-asset.mjs` | 3,844 | used by scripts/install.sh:18 / install.ps1:43 and .github/workflows/build-binary.yml:190 |
| `scripts/lint.js` | 1,618 | repo lefthook.yml job (lefthook.yml:11/47/55/20/29/33/79); push.js:207 runs projectRoot/scripts/branch-protection.js, never the package copy |
| `scripts/npm-release-receipt.js` | 3,783 | repo CI / maintainer tooling (.github/workflows or package.json `check`); any lib mention resolves it under projectRoot (e.g. lib/preflight/gates.js:116, lib/npm-publish-workflow.js:252) |
| `scripts/parity-check.mjs` | 6,189 | build tooling (package.json gen:manifest / gen:assets / build:binary / parity:binary) |
| `scripts/parity-check.test.mjs` | 2,624 | test file |
| `scripts/pin-agentic-workflow-images.js` | 2,821 | repo CI / maintainer tooling (.github/workflows or package.json `check`); any lib mention resolves it under projectRoot (e.g. lib/preflight/gates.js:116, lib/npm-publish-workflow.js:252) |
| `scripts/pr-auto-actions.js` | 3,439 | repo CI / maintainer tooling (.github/workflows or package.json `check`); any lib mention resolves it under projectRoot (e.g. lib/preflight/gates.js:116, lib/npm-publish-workflow.js:252) |
| `scripts/pr-verdict-label.js` | 1,727 | repo CI / maintainer tooling (.github/workflows or package.json `check`); any lib mention resolves it under projectRoot (e.g. lib/preflight/gates.js:116, lib/npm-publish-workflow.js:252) |
| `scripts/preflight.sh` | 2,421 | repo CI / eval tooling (.github/workflows/behavioral-test.md:57; preflight.sh only listed as a scan path in lib/release-readiness.js:98; eval_win.py only named in skills/*/evals/README.md) |
| `scripts/protected-state-check.js` | 20,652 | repo lefthook.yml job (lefthook.yml:11/47/55/20/29/33/79); push.js:207 runs projectRoot/scripts/branch-protection.js, never the package copy |
| `scripts/spikes/config-race-bench.js` | 3,431 | spike/evidence scripts; only referenced by tests under test/ and docs/work |
| `scripts/spikes/harness-capability-matrix.js` | 294 | spike/evidence scripts; only referenced by tests under test/ and docs/work |
| `scripts/spikes/patch-anchor-stability-bench.js` | 3,585 | spike/evidence scripts; only referenced by tests under test/ and docs/work |
| `scripts/spikes/protected-path-manifest.js` | 704 | spike/evidence scripts; only referenced by tests under test/ and docs/work |
| `scripts/spikes/skill-auto-invoke-parity.js` | 9,392 | spike/evidence scripts; only referenced by tests under test/ and docs/work |
| `scripts/sync-agent-skills.js` | 15,328 | repo lefthook.yml job (lefthook.yml:11/47/55/20/29/33/79); push.js:207 runs projectRoot/scripts/branch-protection.js, never the package copy |
| `scripts/sync-agentic-workflow.js` | 1,585 | repo CI / maintainer tooling (.github/workflows or package.json `check`); any lib mention resolves it under projectRoot (e.g. lib/preflight/gates.js:116, lib/npm-publish-workflow.js:252) |
| `scripts/sync-d20-audit.js` | 6,612 | repo lefthook.yml job (lefthook.yml:11/47/55/20/29/33/79); push.js:207 runs projectRoot/scripts/branch-protection.js, never the package copy |
| `scripts/test-ci-shard.js` | 6,928 | repo test/CI runner tooling (package.json scripts, .github/workflows/test.yml); lib/commands/push.js:49-50 and validate.js:651-652 only use a projectRoot copy when the project itself has it |
| `scripts/test-dashboard.js` | 8,498 | repo test/CI runner tooling (package.json scripts, .github/workflows/test.yml); lib/commands/push.js:49-50 and validate.js:651-652 only use a projectRoot copy when the project itself has it |
| `scripts/test-full-suite.js` | 48,951 | repo test/CI runner tooling (package.json scripts, .github/workflows/test.yml); lib/commands/push.js:49-50 and validate.js:651-652 only use a projectRoot copy when the project itself has it |
| `scripts/test-profile.js` | 9,724 | repo test/CI runner tooling (package.json scripts, .github/workflows/test.yml); lib/commands/push.js:49-50 and validate.js:651-652 only use a projectRoot copy when the project itself has it |
| `scripts/test-weights.json` | 67,693 | repo test/CI runner tooling (package.json scripts, .github/workflows/test.yml); lib/commands/push.js:49-50 and validate.js:651-652 only use a projectRoot copy when the project itself has it |
| `scripts/validate.js` | 4,525 | repo CI / maintainer tooling (.github/workflows or package.json `check`); any lib mention resolves it under projectRoot (e.g. lib/preflight/gates.js:116, lib/npm-publish-workflow.js:252) |

## DELETE (33 files, 177,859 bytes)

| Path | Bytes | Evidence |
|---|---:|---|
| `lib/beta5-compatibility-evidence.js` | 45,415 | only reference: test/beta5-compatibility-evidence.test.js:14; no CLI/CI/hook caller |
| `lib/capabilities/index.js` | 133 | only references: test/capabilities/{index,model,probes}.test.js, test/capability/harness-probes.test.js; no CLI/CI/hook caller (added #518) |
| `lib/capabilities/model.js` | 4,867 | only references: test/capabilities/{index,model,probes}.test.js, test/capability/harness-probes.test.js; no CLI/CI/hook caller (added #518) |
| `lib/capabilities/probes.js` | 12,621 | only references: test/capabilities/{index,model,probes}.test.js, test/capability/harness-probes.test.js; no CLI/CI/hook caller (added #518) |
| `lib/fixtures/beta5-corpus/v1/contract/command-contract.json` | 1,960 | only reader is lib/beta5-compatibility-evidence.js:12 (BETA5_CORPUS_ROOT), itself a DELETE candidate; `git grep beta5-corpus` hits only those two files + the manifest |
| `lib/fixtures/beta5-corpus/v1/contract/package-contract.json` | 304 | only reader is lib/beta5-compatibility-evidence.js:12 (BETA5_CORPUS_ROOT), itself a DELETE candidate; `git grep beta5-corpus` hits only those two files + the manifest |
| `lib/fixtures/beta5-corpus/v1/contract/workflow-stage-matrix.json` | 298 | only reader is lib/beta5-compatibility-evidence.js:12 (BETA5_CORPUS_ROOT), itself a DELETE candidate; `git grep beta5-corpus` hits only those two files + the manifest |
| `lib/fixtures/beta5-corpus/v1/manifest.json` | 1,701 | only reader is lib/beta5-compatibility-evidence.js:12 (BETA5_CORPUS_ROOT), itself a DELETE candidate; `git grep beta5-corpus` hits only those two files + the manifest |
| `lib/fixtures/beta5-corpus/v1/README.md` | 461 | only reader is lib/beta5-compatibility-evidence.js:12 (BETA5_CORPUS_ROOT), itself a DELETE candidate; `git grep beta5-corpus` hits only those two files + the manifest |
| `lib/fixtures/beta5-corpus/v1/state/comments.jsonl` | 105 | only reader is lib/beta5-compatibility-evidence.js:12 (BETA5_CORPUS_ROOT), itself a DELETE candidate; `git grep beta5-corpus` hits only those two files + the manifest |
| `lib/fixtures/beta5-corpus/v1/state/config.yaml` | 98 | only reader is lib/beta5-compatibility-evidence.js:12 (BETA5_CORPUS_ROOT), itself a DELETE candidate; `git grep beta5-corpus` hits only those two files + the manifest |
| `lib/fixtures/beta5-corpus/v1/state/dependencies.jsonl` | 71 | only reader is lib/beta5-compatibility-evidence.js:12 (BETA5_CORPUS_ROOT), itself a DELETE candidate; `git grep beta5-corpus` hits only those two files + the manifest |
| `lib/fixtures/beta5-corpus/v1/state/issues.jsonl` | 183 | only reader is lib/beta5-compatibility-evidence.js:12 (BETA5_CORPUS_ROOT), itself a DELETE candidate; `git grep beta5-corpus` hits only those two files + the manifest |
| `lib/fixtures/beta5-corpus/v1/state/kernel.sql` | 2,193 | only reader is lib/beta5-compatibility-evidence.js:12 (BETA5_CORPUS_ROOT), itself a DELETE candidate; `git grep beta5-corpus` hits only those two files + the manifest |
| `lib/forge-context.js` | 1,690 | only reference: its own test (test/<name>.test.js); no CLI/CI/hook caller |
| `lib/freshness-token.js` | 5,097 | only reference: its own test (test/<name>.test.js); no CLI/CI/hook caller |
| `lib/frontmatter.js` | 2,379 | zero references anywhere (`git grep lib/frontmatter` and basename: 0 hits outside itself) |
| `lib/issue-sync/github-pull.js` | 3,841 | closed cluster: these 6 require only each other; outside callers are only test/issue-sync/<name>.test.js |
| `lib/issue-sync/import-primitives.js` | 2,466 | closed cluster: these 6 require only each other; outside callers are only test/issue-sync/<name>.test.js |
| `lib/issue-sync/legacy-link-bridge.js` | 11,827 | closed cluster: these 6 require only each other; outside callers are only test/issue-sync/<name>.test.js |
| `lib/issue-sync/link-store.js` | 7,065 | closed cluster: these 6 require only each other; outside callers are only test/issue-sync/<name>.test.js |
| `lib/issue-sync/reconcile.js` | 5,037 | closed cluster: these 6 require only each other; outside callers are only test/issue-sync/<name>.test.js |
| `lib/issue-sync/schema.js` | 2,592 | closed cluster: these 6 require only each other; outside callers are only test/issue-sync/<name>.test.js |
| `lib/kernel/planning-buckets-schema.js` | 4,095 | only reference: test/kernel/planning-buckets-schema.test.js:12 (+ prose in docs/reference/KERNEL_TAXONOMY_VALIDATION.md:117) |
| `lib/setup.js` | 4,765 | no runtime caller (init.js:564 requires ./setup = lib/commands/setup.js); only test/e2e/setup-workflow.test.js, test/setup-resumability.test.js and a package-distribution assertion |
| `lib/task-ownership.js` | 3,927 | only reference: its own test (test/<name>.test.js); no CLI/CI/hook caller |
| `lib/validation-utils.js` | 5,413 | zero code references (`git grep validation-utils`: only a historical docs/work note) |
| `scripts/improve-command.js` | 12,036 | unwired dev CLI: no package.json script, CI, hook or lib caller; only test/eval/*.test.js |
| `scripts/lib/eval-schema.js` | 4,245 | only callers: scripts/run-command-eval.js / improve-command.js (DELETE candidates) and their test/eval/*.test.js |
| `scripts/lib/eval-storage.js` | 2,494 | only callers: scripts/run-command-eval.js / improve-command.js (DELETE candidates) and their test/eval/*.test.js |
| `scripts/lib/grading.js` | 6,464 | only callers: scripts/run-command-eval.js / improve-command.js (DELETE candidates) and their test/eval/*.test.js |
| `scripts/migrate-to-bun-test.js` | 12,880 | zero references anywhere (`git grep migrate-to-bun-test`: 0 hits) |
| `scripts/run-command-eval.js` | 9,136 | unwired dev CLI: no package.json script, CI, hook or lib caller; only test/eval/*.test.js |

## DUPLICATE (82 files, 200,042 bytes)

| Path | Bytes | Evidence |
|---|---:|---|
| `packages/flow/node_modules/@forge/contracts/compatibility-matrix.v1.json` | 959 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/flow/node_modules/@forge/contracts/contract-baseline.v1.json` | 4,974 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/flow/node_modules/@forge/contracts/fixtures/v1/canonical-hash.json` | 227 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/flow/node_modules/@forge/contracts/fixtures/v1/contract-inputs.v1.json` | 9,767 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/flow/node_modules/@forge/contracts/fixtures/v1/feedback-secret-reject.json` | 369 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/flow/node_modules/@forge/contracts/fixtures/v1/identity-conflict.json` | 420 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/flow/node_modules/@forge/contracts/fixtures/v1/malformed-envelope-inputs.v1.json` | 1,137 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/flow/node_modules/@forge/contracts/fixtures/v1/malformed-missing-required.json` | 188 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/flow/node_modules/@forge/contracts/fixtures/v1/monitor-bounds-reject.json` | 389 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/flow/node_modules/@forge/contracts/fixtures/v1/monitor-receipt-privacy-reject.json` | 359 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/flow/node_modules/@forge/contracts/fixtures/v1/not-executed-receipt.json` | 372 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/flow/node_modules/@forge/contracts/fixtures/v1/privacy-redaction.json` | 505 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/flow/node_modules/@forge/contracts/fixtures/v1/retry-identical.json` | 298 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/flow/node_modules/@forge/contracts/fixtures/v1/stale-authority-reject.json` | 425 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/flow/node_modules/@forge/contracts/fixtures/v1/structured-error-privacy-reject.json` | 373 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/flow/node_modules/@forge/contracts/fixtures/v1/structured-error-stripe-live-reject.json` | 361 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/flow/node_modules/@forge/contracts/fixtures/v1/structured-error-stripe-test-reject.json` | 361 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/flow/node_modules/@forge/contracts/fixtures/v1/unknown-advisory-roundtrip.json` | 363 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/flow/node_modules/@forge/contracts/fixtures/v1/unknown-consequential-reject.json` | 390 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/flow/node_modules/@forge/contracts/fixtures/v1/valid-full.json` | 380 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/flow/node_modules/@forge/contracts/fixtures/v1/valid-minimal.json` | 200 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/flow/node_modules/@forge/contracts/fixtures/v1/wrong-capability-digest.json` | 429 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/flow/node_modules/@forge/contracts/index.js` | 881 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/flow/node_modules/@forge/contracts/package.json` | 817 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/flow/node_modules/@forge/contracts/schemas/v1/capability-manifest.schema.json` | 2,741 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/flow/node_modules/@forge/contracts/schemas/v1/claim-request.schema.json` | 2,184 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/flow/node_modules/@forge/contracts/schemas/v1/context-packet.schema.json` | 3,320 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/flow/node_modules/@forge/contracts/schemas/v1/delivery-receipt.schema.json` | 2,274 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/flow/node_modules/@forge/contracts/schemas/v1/feedback-report.schema.json` | 3,764 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/flow/node_modules/@forge/contracts/schemas/v1/lease-receipt.schema.json` | 2,329 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/flow/node_modules/@forge/contracts/schemas/v1/monitor-event.schema.json` | 2,750 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/flow/node_modules/@forge/contracts/schemas/v1/monitor-receipt.schema.json` | 3,264 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/flow/node_modules/@forge/contracts/schemas/v1/run-receipt.schema.json` | 4,316 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/flow/node_modules/@forge/contracts/schemas/v1/structured-error.schema.json` | 2,659 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/flow/node_modules/@forge/contracts/schemas/v1/work-packet.schema.json` | 3,437 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/flow/node_modules/@forge/contracts/src/baseline.js` | 789 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/flow/node_modules/@forge/contracts/src/canonical.js` | 6,204 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/flow/node_modules/@forge/contracts/src/definitions.js` | 11,388 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/flow/node_modules/@forge/contracts/src/identity.js` | 1,400 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/flow/node_modules/@forge/contracts/src/schema.js` | 2,910 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/flow/node_modules/@forge/contracts/src/validate.js` | 19,348 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/memory/node_modules/@forge/contracts/compatibility-matrix.v1.json` | 959 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/memory/node_modules/@forge/contracts/contract-baseline.v1.json` | 4,974 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/memory/node_modules/@forge/contracts/fixtures/v1/canonical-hash.json` | 227 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/memory/node_modules/@forge/contracts/fixtures/v1/contract-inputs.v1.json` | 9,767 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/memory/node_modules/@forge/contracts/fixtures/v1/feedback-secret-reject.json` | 369 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/memory/node_modules/@forge/contracts/fixtures/v1/identity-conflict.json` | 420 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/memory/node_modules/@forge/contracts/fixtures/v1/malformed-envelope-inputs.v1.json` | 1,137 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/memory/node_modules/@forge/contracts/fixtures/v1/malformed-missing-required.json` | 188 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/memory/node_modules/@forge/contracts/fixtures/v1/monitor-bounds-reject.json` | 389 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/memory/node_modules/@forge/contracts/fixtures/v1/monitor-receipt-privacy-reject.json` | 359 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/memory/node_modules/@forge/contracts/fixtures/v1/not-executed-receipt.json` | 372 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/memory/node_modules/@forge/contracts/fixtures/v1/privacy-redaction.json` | 505 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/memory/node_modules/@forge/contracts/fixtures/v1/retry-identical.json` | 298 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/memory/node_modules/@forge/contracts/fixtures/v1/stale-authority-reject.json` | 425 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/memory/node_modules/@forge/contracts/fixtures/v1/structured-error-privacy-reject.json` | 373 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/memory/node_modules/@forge/contracts/fixtures/v1/structured-error-stripe-live-reject.json` | 361 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/memory/node_modules/@forge/contracts/fixtures/v1/structured-error-stripe-test-reject.json` | 361 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/memory/node_modules/@forge/contracts/fixtures/v1/unknown-advisory-roundtrip.json` | 363 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/memory/node_modules/@forge/contracts/fixtures/v1/unknown-consequential-reject.json` | 390 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/memory/node_modules/@forge/contracts/fixtures/v1/valid-full.json` | 380 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/memory/node_modules/@forge/contracts/fixtures/v1/valid-minimal.json` | 200 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/memory/node_modules/@forge/contracts/fixtures/v1/wrong-capability-digest.json` | 429 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/memory/node_modules/@forge/contracts/index.js` | 881 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/memory/node_modules/@forge/contracts/package.json` | 817 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/memory/node_modules/@forge/contracts/schemas/v1/capability-manifest.schema.json` | 2,741 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/memory/node_modules/@forge/contracts/schemas/v1/claim-request.schema.json` | 2,184 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/memory/node_modules/@forge/contracts/schemas/v1/context-packet.schema.json` | 3,320 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/memory/node_modules/@forge/contracts/schemas/v1/delivery-receipt.schema.json` | 2,274 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/memory/node_modules/@forge/contracts/schemas/v1/feedback-report.schema.json` | 3,764 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/memory/node_modules/@forge/contracts/schemas/v1/lease-receipt.schema.json` | 2,329 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/memory/node_modules/@forge/contracts/schemas/v1/monitor-event.schema.json` | 2,750 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/memory/node_modules/@forge/contracts/schemas/v1/monitor-receipt.schema.json` | 3,264 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/memory/node_modules/@forge/contracts/schemas/v1/run-receipt.schema.json` | 4,316 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/memory/node_modules/@forge/contracts/schemas/v1/structured-error.schema.json` | 2,659 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/memory/node_modules/@forge/contracts/schemas/v1/work-packet.schema.json` | 3,437 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/memory/node_modules/@forge/contracts/src/baseline.js` | 789 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/memory/node_modules/@forge/contracts/src/canonical.js` | 6,204 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/memory/node_modules/@forge/contracts/src/definitions.js` | 11,388 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/memory/node_modules/@forge/contracts/src/identity.js` | 1,400 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/memory/node_modules/@forge/contracts/src/schema.js` | 2,910 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
| `packages/memory/node_modules/@forge/contracts/src/validate.js` | 19,348 | nested re-bundled copy of @forge/contracts inside the bundled @forge/flow / @forge/memory workspace (package.json `bundleDependencies`); a third copy of node_modules/@forge/contracts. Left to PR #577 vendoring. |
