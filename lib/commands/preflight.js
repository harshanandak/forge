'use strict';

/**
 * `forge preflight` — fast (~2-4 min) blast-radius gate.
 *
 * Gives DETERMINISTIC-GATE PARITY with CI so an agent catches what CI catches
 * WITHOUT waiting on the hanging full suite. Runs four gates in order, fast-fail:
 *
 *   1. lint     — eslint --max-warnings 0 on changed files (--all → whole tree)
 *   2. drift    — skills mirror + registry sync + agentic-workflow structural asserts
 *   3. sonar    — eslint-plugin-sonarjs cognitive-complexity=15 (+ parity rules)
 *   4. affected — only the tests mapped from the changed files
 *
 * Exit non-zero on any gate failure. Run this before `forge push`.
 *
 * @module commands/preflight
 */

const { execFileSync } = require('node:child_process');
const { getChangedFiles } = require('./test');
const { buildGates } = require('../preflight/gates');
const { runGates } = require('../preflight/runner');

/**
 * Strictly resolve a base ref to diff HEAD against. Returns the ref name, or
 * null when no base can be established (fresh repo: no origin/HEAD, no upstream,
 * no main/master ref). Unlike test.js's resolver, this never falls back to a
 * default name that doesn't exist — a missing base must be reported, not faked.
 *
 * @param {Function} exec - execFileSync-compatible
 * @returns {string|null}
 */
/** Run a git command and return trimmed stdout, or null on any failure. */
function gitTryOut(exec, args) {
  try {
    return String(exec('git', args, { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }) || '').trim();
  } catch {
    return null;
  }
}

/** True when `ref` resolves to a real object in this repo. */
function gitVerifyRef(exec, ref) {
  try {
    exec('git', ['rev-parse', '--verify', '--quiet', ref], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function resolveBaseRef(exec) {
  const originHead = gitTryOut(exec, ['rev-parse', '--abbrev-ref', 'origin/HEAD']);
  if (originHead && originHead !== 'origin/HEAD') return originHead;

  const upstream = gitTryOut(exec, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  if (upstream) return upstream;

  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    if (gitVerifyRef(exec, ref)) return ref;
  }
  return null;
}

/**
 * Resolve the change set for preflight, distinguishing "base resolved, genuinely
 * zero changes" from "no base branch could be resolved". Only the latter is a
 * gate failure — a fresh repo with no base cannot have its blast radius computed,
 * so preflight must NOT pass vacuously.
 *
 * @param {Function} [exec] - execFileSync-compatible (injectable for tests)
 * @param {{ runAll?: boolean }} [opts]
 * @returns {{ resolved: boolean, changedFiles: string[], reason?: string, baseRef?: string }}
 */
function resolveChangeSet(exec = execFileSync, { runAll = false } = {}) {
  if (runAll) {
    return { resolved: true, changedFiles: [], reason: 'whole-tree scope (--all)' };
  }
  const baseRef = resolveBaseRef(exec);
  if (!baseRef) {
    return {
      resolved: false,
      changedFiles: [],
      reason: 'could not resolve a base branch (no origin/HEAD, no upstream, no main/master ref)',
    };
  }
  let changedFiles = [];
  try {
    changedFiles = getChangedFiles(exec, {}) || [];
  } catch {
    // base resolved but diff failed — treat as no changes, still a resolved base
  }
  return { resolved: true, baseRef, changedFiles };
}

/**
 * Pick the change set: an injected resolveChangeSet wins; a legacy injected
 * resolveChangedFiles vouches for resolution; otherwise resolve strictly.
 */
function selectChangeSet(deps, runAll) {
  if (deps.resolveChangeSet) {
    return deps.resolveChangeSet({ runAll });
  }
  if (deps.resolveChangedFiles) {
    return { resolved: true, changedFiles: deps.resolveChangedFiles() || [] };
  }
  return resolveChangeSet(execFileSync, { runAll });
}

/** Print the fail-closed remedy when no base branch could be resolved. */
function reportBaseUnresolved(log, reason) {
  log('forge preflight — fast blast-radius gate (deterministic parity with CI)');
  log('');
  log(`preflight FAILED — ${reason}.`);
  log('  Remedy: give preflight a base branch to diff against, e.g.');
  log('    git fetch origin && git branch --set-upstream-to=origin/main   # your default branch');
  log('    (or ensure origin/HEAD is set: git remote set-head origin -a)');
  log('  Or scan the whole tree explicitly: forge preflight --all');
}

/** Summary mark for one gate result. */
function gateMark(result) {
  if (result.skipped) return 'SKIP';
  return result.ok ? 'PASS' : 'FAIL';
}

module.exports = {
  name: 'preflight',
  description: 'Fast deterministic-gate parity with CI (lint, drift/registry, sonar, affected tests)',
  usage: 'forge preflight [--all]',
  flags: {
    '--all': 'Lint/scan the whole tree instead of only changed files',
  },

  /**
   * @param {string[]} _args
   * @param {Object} flags
   * @param {string} projectRoot
   * @param {Object} [deps] - injectable { log, resolveChangedFiles, buildGates, runGates }
   * @returns {Promise<{ success: boolean, results?: Array }>}
   */
  handler: async (_args, flags, projectRoot, deps = {}) => {
    const log = deps.log || console.log;
    const build = deps.buildGates || buildGates;
    const run = deps.runGates || runGates;

    const runAll = !!(flags && (flags['--all'] || flags.all));

    // Resolve the change set AND whether a base branch could be established.
    const changeSet = selectChangeSet(deps, runAll) || {};

    // B2 (N1): an unresolvable base is fail-closed. Computing "0 changed files"
    // from a missing base and passing every gate manufactures false confidence.
    if (!runAll && changeSet.resolved === false) {
      reportBaseUnresolved(log, changeSet.reason);
      return { success: false, results: [], reason: changeSet.reason, baseUnresolved: true };
    }

    const changedFiles = changeSet.changedFiles || [];

    log('forge preflight — fast blast-radius gate (deterministic parity with CI)');
    log(runAll
      ? '  scope: whole tree (--all)'
      : `  scope: ${changedFiles.length} changed file(s) vs base branch`);
    log('');

    const gates = build({ projectRoot, changedFiles, runAll });
    const { ok, results } = await run(gates, { log: (line) => log(`  ${line}`) });

    log('');
    log('Preflight summary:');
    for (const r of results) {
      log(`  [${gateMark(r)}] ${r.name}${r.summary ? ` — ${r.summary}` : ''}`);
    }
    log('');
    log(ok
      ? 'preflight passed — safe to push'
      : 'preflight FAILED — fix the failing gate above before `forge push`');

    return { success: ok, results };
  },
};

module.exports.resolveChangeSet = resolveChangeSet;
module.exports.resolveBaseRef = resolveBaseRef;
