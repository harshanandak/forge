#!/usr/bin/env node
'use strict';

/**
 * Pre-push auto-file rail (kernel issue a4b8f56f).
 *
 * Ensures the branch being pushed has a backing Kernel issue so a RAW `git push`
 * (NOT routed through `forge push`, which wires the same rail) still auto-files
 * started work — "nothing goes missing". BEST-EFFORT + NON-BLOCKING: a hook must
 * never block a push on tracking, so `run()` swallows every error and the CLI entry
 * ALWAYS exits 0. Idempotent via ensureBackingIssue (deduped by branch), so it never
 * duplicates an issue `forge worktree`/`forge push` already filed.
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

/**
 * @param {object} [deps] - injection seam for tests:
 *   { getBranch, ensureBackingIssue, buildDeps, projectRoot, existsSync }
 * @returns {Promise<object|null>} the backing-issue descriptor, or null when skipped.
 */
async function run(deps = {}) {
  try {
    const projectRoot = deps.projectRoot || process.cwd();
    const existsSync = deps.existsSync || fs.existsSync;
    const getBranch = deps.getBranch || (() => execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim());
    const branch = getBranch();
    if (!branch) return null;
    if (!existsSync(path.join(projectRoot, '.git'))) return null;

    const ensure = deps.ensureBackingIssue || require('../lib/kernel/backing-issue').ensureBackingIssue;
    const buildDeps = deps.buildDeps || (root => require('../lib/kernel/cli-broker-factory').buildMigratedKernelIssueDeps({ projectRoot: root }));
    const { kernelDriver, kernelBroker } = await buildDeps(projectRoot);
    return await ensure({ branch, projectRoot, driver: kernelDriver, broker: kernelBroker });
  } catch {
    // Non-blocking: tracking must never break a push.
    return null;
  }
}

module.exports = { run };

if (require.main === module) {
  run().finally(() => process.exit(0));
}
