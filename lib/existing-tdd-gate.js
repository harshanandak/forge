/**
 * Detect a repo's PRE-EXISTING pre-commit TDD / source-test coupling gate, so `forge setup`
 * can DEFER to it instead of stacking Forge's own `rail.tdd_intent` gate on top.
 *
 * The in-the-wild beta.3 adoption report (kernel 5b425a85, predecessor 2699b234): a repo that
 * already ships e.g. `scripts/check-source-test-coupling.mjs` on pre-commit ended up with TWO
 * TDD gates blocking the same commit, with no detection and no reconciliation.
 *
 * Detection is by MECHANISM, not by a filename list: we enumerate the pre-commit COMMANDS that
 * whatever pre-commit runner is actually installed (lefthook / husky / the `pre-commit`
 * framework / a raw `.git/hooks/pre-commit`) will really execute, then classify those command
 * strings. A repo's gate can be named anything, so the mechanism is what we key on.
 *
 * @module lib/existing-tdd-gate
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const {
  FORGE_NATIVE_HOOK_SENTINEL,
  resolveGitHooksDir,
} = require('./lefthook-wiring');

// A pre-commit command is a TDD/coupling gate when its text carries one of these narrow
// tokens: a `tdd` word, a source↔test coupling phrase, or an explicit require/check/enforce
// tests task. Deliberately narrow — a plain test RUNNER (`npm test`) or a formatter is not a
// TDD-intent gate and must not trigger a deferral.
const TDD_GATE_PATTERNS = [
  /(^|[^a-z0-9])tdd([^a-z0-9]|$)/i,
  /(source[-_. ]?test|test[-_. ]?source)/i,
  /((test|spec)[-_. ]?coupling|coupling[-_. ]?(test|spec|check))/i,
  /(require|enforce|verify|guard)[-_. ]?(tests?|specs?)([^a-z0-9]|$)/i,
  /check[-_. ]?(tests?|specs?)([^a-z0-9]|$)/i,
];

// Commands that ARE Forge's own gate. Excluded before classification so a second `forge setup`
// never "detects" the gate its own first run installed and defers to itself.
const FORGE_OWN_COMMAND_MARKERS = ['check-tdd.js', 'forge-native-hook.js'];

// Signatures of a hook lefthook GENERATED (a disposable artifact that only dispatches to
// lefthook.yml, which we read directly) — mirrors lib/lefthook-wiring.js's own classifier.
const LEFTHOOK_GENERATED_MARKERS = ['call_lefthook', 'LEFTHOOK_BIN'];

const LEFTHOOK_CONFIG_FILES = [
  'lefthook.yml',
  'lefthook.yaml',
  '.lefthook.yml',
  '.lefthook.yaml',
  'lefthook-local.yml',
  'lefthook-local.yaml',
];

const PRE_COMMIT_FRAMEWORK_FILES = ['.pre-commit-config.yaml', '.pre-commit-config.yml'];

function isForgeOwnCommand(text) {
  return FORGE_OWN_COMMAND_MARKERS.some((marker) => text.includes(marker));
}

function looksLikeTddGate(text) {
  return TDD_GATE_PATTERNS.some((pattern) => pattern.test(text));
}

function readFileOrNull(absolute) {
  try {
    return fs.readFileSync(absolute, 'utf8');
  } catch {
    return null;
  }
}

// One candidate = one command string a pre-commit runner will execute, plus where it came from.
function candidate(source, command) {
  return { source, command: String(command).trim() };
}

// Shell-script hooks (husky, raw .git/hooks): every meaningful line is a command.
function commandsFromScript(source, body) {
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => candidate(source, line));
}

// lefthook pre-commit: `commands.<name>.run`, `scripts.<name>`, and the v1.11+ `jobs` list.
// The job NAME carries signal too (a job called `tdd-guard`), so both are collected.
function commandsFromLefthookPreCommit(source, preCommit) {
  const out = [];
  if (!preCommit || typeof preCommit !== 'object') return out;

  for (const [name, job] of Object.entries(preCommit.commands || {})) {
    out.push(candidate(source, `${name}: ${(job && job.run) || ''}`));
  }
  for (const [name, job] of Object.entries(preCommit.scripts || {})) {
    out.push(candidate(source, `${name} ${(job && job.runner) || ''}`));
  }
  for (const job of Array.isArray(preCommit.jobs) ? preCommit.jobs : []) {
    if (job && typeof job === 'object') {
      out.push(candidate(source, `${job.name || ''}: ${job.run || ''}`));
    }
  }
  return out;
}

// Returns { candidates } normally, or { unknown: true } when a pre-commit mechanism is present
// but its content cannot be read/parsed — we cannot rule out a TDD gate, so the caller defers.
function collectFromLefthookConfigs(projectRoot) {
  const candidates = [];
  for (const name of LEFTHOOK_CONFIG_FILES) {
    const absolute = path.join(projectRoot, name);
    if (!fs.existsSync(absolute)) continue;
    const body = readFileOrNull(absolute);
    if (body === null) return { unknown: true, source: name };

    let doc;
    try {
      doc = YAML.parse(body);
    } catch {
      // Unparseable: only ambiguous if it actually declares a pre-commit section.
      if (body.includes('pre-commit')) return { unknown: true, source: name };
      continue;
    }
    if (!doc || typeof doc !== 'object') continue;
    candidates.push(...commandsFromLefthookPreCommit(name, doc['pre-commit']));
  }
  return { candidates };
}

function collectFromHusky(projectRoot) {
  const relative = '.husky/pre-commit'; // display label — always POSIX-style, never OS-separated
  const absolute = path.join(projectRoot, '.husky', 'pre-commit');
  if (!fs.existsSync(absolute)) return { candidates: [] };
  const body = readFileOrNull(absolute);
  if (body === null) return { unknown: true, source: relative };
  return { candidates: commandsFromScript(relative, body) };
}

function collectFromPreCommitFramework(projectRoot) {
  const candidates = [];
  for (const name of PRE_COMMIT_FRAMEWORK_FILES) {
    const absolute = path.join(projectRoot, name);
    if (!fs.existsSync(absolute)) continue;
    const body = readFileOrNull(absolute);
    if (body === null) return { unknown: true, source: name };

    let doc;
    try {
      doc = YAML.parse(body);
    } catch {
      return { unknown: true, source: name };
    }
    for (const repo of (doc && Array.isArray(doc.repos)) ? doc.repos : []) {
      for (const hook of (repo && Array.isArray(repo.hooks)) ? repo.hooks : []) {
        if (!hook || typeof hook !== 'object') continue;
        candidates.push(candidate(name, `${hook.id || ''} ${hook.name || ''} ${hook.entry || ''}`));
      }
    }
  }
  return { candidates };
}

// The raw hook git will actually run. Forge's own native hook and a lefthook-GENERATED
// dispatcher are skipped: neither is a third-party gate (the latter's real jobs live in
// lefthook.yml, which collectFromLefthookConfigs already read).
function collectFromNativeHook(projectRoot) {
  const hooksDir = resolveGitHooksDir(projectRoot);
  if (!hooksDir) return { candidates: [] };
  const absolute = path.join(hooksDir, 'pre-commit');
  if (!fs.existsSync(absolute)) return { candidates: [] };
  const body = readFileOrNull(absolute);
  if (body === null) return { unknown: true, source: 'pre-commit (git hooks dir)' };
  if (body.includes(FORGE_NATIVE_HOOK_SENTINEL)) return { candidates: [] };
  if (LEFTHOOK_GENERATED_MARKERS.some((marker) => body.includes(marker))) return { candidates: [] };
  return { candidates: commandsFromScript('pre-commit (git hooks dir)', body) };
}

/**
 * Detect a pre-existing pre-commit TDD / source-test coupling gate in the project.
 *
 * @param {string} projectRoot - Absolute path to the project root.
 * @returns {{ found: boolean, source?: string, command?: string, unknown?: boolean }}
 *   `found:true` with `source`/`command` for a classified gate; `found:true, unknown:true`
 *   when a pre-commit mechanism exists but could not be read (defer — the safe side);
 *   `found:false` when nothing pre-existing enforces TDD.
 */
function detectExistingTddGate(projectRoot) {
  const collectors = [
    collectFromLefthookConfigs,
    collectFromHusky,
    collectFromPreCommitFramework,
    collectFromNativeHook,
  ];

  let ambiguous = null;
  const candidates = [];
  for (const collect of collectors) {
    let result;
    try {
      result = collect(projectRoot);
    } catch {
      continue; // a collector failure must never break setup
    }
    if (result.unknown) {
      ambiguous = ambiguous || { source: result.source };
      continue;
    }
    candidates.push(...(result.candidates || []));
  }

  for (const item of candidates) {
    if (isForgeOwnCommand(item.command)) continue;
    if (looksLikeTddGate(item.command)) {
      return { found: true, source: item.source, command: item.command };
    }
  }

  if (ambiguous) {
    return { found: true, unknown: true, source: ambiguous.source, command: '' };
  }
  return { found: false };
}

/**
 * The user-facing deferral report. Silent stacking and silent skipping are BOTH wrong — the
 * adopter must see what was detected, what Forge did not install, and how to choose otherwise.
 *
 * @param {{ found: boolean, source?: string, command?: string, unknown?: boolean }} detection
 * @returns {string|null} Report text, or null when there is nothing to defer to.
 */
function describeExistingGateDeferral(detection) {
  if (!detection || !detection.found) return null;

  const what = detection.unknown
    ? `an existing pre-commit hook Forge could not read (${detection.source})`
    : `an existing pre-commit TDD/coupling gate in ${detection.source}:\n      ${detection.command}`;

  return [
    `  ⚠ Detected ${what}`,
    '    Forge did NOT install its own TDD gate on pre-commit — deferring to yours, so you',
    '    do not get two gates blocking the same commit. rail.tdd_intent is off in .forge/config.yaml.',
    "    Prefer Forge's gate instead? Remove or disable your own, then run:",
    '      forge gate enable rail.tdd_intent',
  ].join('\n');
}

module.exports = {
  detectExistingTddGate,
  describeExistingGateDeferral,
};
