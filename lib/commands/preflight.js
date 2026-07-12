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
    const resolveChangedFiles = deps.resolveChangedFiles
      || (() => {
        try {
          return getChangedFiles(execFileSync, {}) || [];
        } catch (_err) {
          return [];
        }
      });

    const runAll = !!(flags && (flags['--all'] || flags.all));
    const changedFiles = resolveChangedFiles();

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
      const mark = r.skipped ? 'SKIP' : (r.ok ? 'PASS' : 'FAIL');
      log(`  [${mark}] ${r.name}${r.summary ? ` — ${r.summary}` : ''}`);
    }
    log('');
    log(ok
      ? 'preflight passed — safe to push'
      : 'preflight FAILED — fix the failing gate above before `forge push`');

    return { success: ok, results };
  },
};
