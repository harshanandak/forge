'use strict';

/**
 * Gate composition + real sub-runners for `forge preflight`.
 *
 * Each real runner takes an injectable `spawn` (defaults to spawnSync) so the
 * composition and the runners are unit-testable without touching the shell.
 * The four gates give DETERMINISTIC-GATE PARITY with CI on the blast radius of
 * a change, without the slow full matrix:
 *
 *   1. lint     — eslint --max-warnings 0 on changed files (or all with --all)
 *   2. drift    — skills-mirror + registry-sync + agentic-workflow structural asserts
 *   3. sonar    — eslint-plugin-sonarjs (cognitive-complexity=15 + parity rules)
 *   4. affected — only the tests mapped from the changed files
 *
 * @module preflight/gates
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { execFileSync } = require('node:child_process');
const nodeFs = require('node:fs');
const { getAffectedTestFiles } = require('../commands/test');

const IS_WINDOWS = process.platform === 'win32';

/** Filter a changed-file list down to the JS files eslint should look at. */
function lintableFiles(files) {
  if (!Array.isArray(files)) return [];
  return files.filter((f) => /\.(mjs|cjs|js)$/.test(f) && !f.includes('node_modules'));
}

/** Short, bounded summary for a spawn result. */
function statusSummary(result, okMsg, failMsg) {
  return result && result.status === 0
    ? { ok: true, summary: okMsg }
    : { ok: false, summary: failMsg };
}

/**
 * Gate 1 — ESLint on the change blast radius (or the whole tree with --all).
 * `files === null` means "lint everything" (`eslint .`).
 */
function runEslint(files, { projectRoot, spawn = spawnSync } = {}) {
  const lintAll = files === null;
  const targets = lintAll ? ['.'] : lintableFiles(files);
  if (targets.length === 0) {
    return { ok: true, summary: 'no changed JS files' };
  }
  const result = spawn(
    'npx',
    ['eslint', '--max-warnings', '0', ...targets],
    { cwd: projectRoot, stdio: 'inherit', shell: IS_WINDOWS },
  );
  return statusSummary(
    result,
    lintAll ? 'whole tree clean' : `${targets.length} changed file(s) clean`,
    'eslint reported errors/warnings',
  );
}

/**
 * Gate 2 — deterministic structural asserts that CI enforces:
 *   - skills mirror drift (test/structural/skills-sync-drift.test.js)
 *   - SUBCOMMANDS<->ISSUE_COMMANDS registry sync (test/commands/_resolve-command-opts.test.js)
 *   - committed agentic-workflow mirror (scripts/sync-agentic-workflow.js --check)
 */
function runStructural({ projectRoot, spawn = spawnSync, fs = nodeFs } = {}) {
  const exists = (rel) => {
    try {
      return fs.existsSync(path.join(projectRoot, rel));
    } catch {
      return false;
    }
  };

  // These are Forge's OWN internal structural asserts. A consumer repo does not
  // contain them and can NEVER satisfy them, so only run the ones that actually
  // exist in this project. If none do, the gate is not applicable here — report
  // an explicit SKIP rather than a false pass or an impossible failure.
  const structuralTests = [
    'test/structural/skills-sync-drift.test.js',
    'test/commands/_resolve-command-opts.test.js',
  ].filter(exists);
  const agenticScript = 'scripts/sync-agentic-workflow.js';
  const hasAgentic = exists(agenticScript);

  if (structuralTests.length === 0 && !hasAgentic) {
    return {
      ok: true,
      skipped: true,
      summary: 'no Forge-internal structural checks in this repo (consumer context)',
    };
  }

  if (structuralTests.length > 0) {
    const bun = spawn(
      'bun',
      ['test', '--timeout', '15000', ...structuralTests],
      { cwd: projectRoot, stdio: 'inherit', shell: IS_WINDOWS },
    );
    if (!bun || bun.status !== 0) {
      return { ok: false, summary: 'skills-mirror / registry-sync asserts failed' };
    }
  }

  if (!hasAgentic) {
    return { ok: true, summary: 'skills + registry in sync (no agentic-workflow mirror here)' };
  }

  const agentic = spawn(
    'node',
    [agenticScript, '--check'],
    { cwd: projectRoot, stdio: 'inherit', shell: IS_WINDOWS },
  );
  return statusSummary(
    agentic,
    'skills + registry + agentic-workflow in sync',
    'agentic-workflow mirror drift (run: node scripts/sync-agentic-workflow.js)',
  );
}

/**
 * Gate 3 — SonarCloud parity via eslint-plugin-sonarjs, using an isolated flat
 * config (cognitive-complexity pinned to 15 + the parity rules) so it never
 * merges with the repo's main eslint config.
 * `files === null` means "scan everything" (whole-tree `--all` mode) — mirrors
 * runEslint so `--all` never leaves sonar as a vacuous "no changed files" pass.
 */
function runSonar(files, { projectRoot, spawn = spawnSync } = {}) {
  const scanAll = files === null;
  const targets = scanAll ? ['.'] : lintableFiles(files);
  if (targets.length === 0) {
    return { ok: true, summary: 'no changed JS files' };
  }
  const config = path.join(projectRoot, 'scripts', 'preflight-sonar.eslint.config.mjs');
  const result = spawn(
    'npx',
    ['eslint', '--no-config-lookup', '--config', config, '--max-warnings', '0', ...targets],
    { cwd: projectRoot, stdio: 'inherit', shell: IS_WINDOWS },
  );
  return statusSummary(
    result,
    scanAll ? 'sonarjs clean (whole tree)' : `sonarjs clean (${targets.length} file(s))`,
    'sonarjs parity violations (e.g. cognitive-complexity > 15)',
  );
}

/**
 * Gate 4 — run ONLY the tests mapped from the changed files (reuses the
 * pre-push affected-test mapping). No affected tests → fast-lane pass.
 */
function runAffectedTests({
  projectRoot,
  changedFiles: _changedFiles,
  spawn = spawnSync,
  resolveTests,
} = {}) {
  const resolver = typeof resolveTests === 'function'
    ? resolveTests
    : () => getAffectedTestFiles(projectRoot, execFileSync, nodeFs);
  let targets;
  try {
    targets = resolver() || [];
  } catch (err) {
    // A resolver ERROR must NOT masquerade as "no affected tests" (green).
    // We could not determine what to run, so fail closed — never a vacuous pass.
    const reason = err && err.message ? err.message : String(err);
    return { ok: false, summary: `affected-test resolution failed — fail-closed (${reason})` };
  }
  if (targets.length === 0) {
    return { ok: true, summary: 'no affected tests resolved (fast lane)' };
  }
  const result = spawn(
    'bun',
    ['test', '--timeout', '15000', ...targets],
    { cwd: projectRoot, stdio: 'inherit', shell: IS_WINDOWS },
  );
  return statusSummary(
    result,
    `${targets.length} affected test file(s) passed`,
    'affected tests failed',
  );
}

/**
 * Compose the ordered gate list. Each gate delegates to a sub-runner that can
 * be injected via `deps` for testing; defaults wire the real runners above.
 *
 * @param {Object} args
 * @param {string} args.projectRoot
 * @param {string[]} args.changedFiles
 * @param {boolean} [args.runAll]  - lint/scan whole tree instead of changed files
 * @param {Object} [args.deps]     - { eslint, structural, sonar, affected }
 * @returns {{ name: string, run: () => Promise<{ok:boolean, summary?:string}> }[]}
 */
function buildGates({ projectRoot, changedFiles = [], runAll = false, deps = {} }) {
  const eslint = deps.eslint || ((files) => runEslint(files, { projectRoot }));
  const structural = deps.structural || (() => runStructural({ projectRoot }));
  const sonar = deps.sonar || ((files) => runSonar(files, { projectRoot }));
  const affected = deps.affected || (() => runAffectedTests({ projectRoot, changedFiles }));

  // Under --all, scope BOTH lint and sonar to the whole tree (null). Otherwise
  // sonar would receive changedFiles=[] and report a vacuous "no changed files"
  // pass while lint scanned everything — a fail-open hole on the remedy path.
  const scanTargets = runAll ? null : changedFiles;

  // Affected-tests maps from the change set, which is empty under --all. Running
  // the WHOLE suite here defeats preflight's fast purpose (and hangs on Windows),
  // so mark it explicitly not-run — never a vacuous green. CI runs the full suite.
  const affectedGate = runAll
    ? async () => ({
      ok: true,
      skipped: true,
      summary: 'whole-tree mode (--all): affected-test mapping N/A — run the full suite (CI does)',
    })
    : async () => affected();

  return [
    { name: 'lint', run: async () => eslint(scanTargets) },
    { name: 'drift/registry/mirror', run: async () => structural() },
    { name: 'sonar (cognitive-complexity=15)', run: async () => sonar(scanTargets) },
    { name: 'affected-tests', run: affectedGate },
  ];
}

module.exports = {
  buildGates,
  lintableFiles,
  runEslint,
  runStructural,
  runSonar,
  runAffectedTests,
};
