#!/usr/bin/env node
'use strict';

/**
 * pr-auto-actions — the pr-monitor workflow's bridge from the `--pull --json`
 * verdict payload to Tier-2 auto-action DECISIONS. Reads the payload file the
 * monitor already wrote (default `pull.json`), asks lib/pr-monitor/auto-actions
 * (the single, unit-tested decision core) what is safe to do, and emits the
 * flags to `$GITHUB_OUTPUT` (or stdout locally) for the workflow's action steps.
 *
 * This script performs NO GitHub writes and takes NO action — it only decides.
 * The workflow owns the visible `gh` calls and the per-head-SHA idempotency
 * markers. Fails CLOSED: an unreadable/malformed payload or any thrown error
 * yields `update_branch=false` / `rerun=false`.
 *
 * Usage: node scripts/pr-auto-actions.js [pull.json] [isFork]
 *   isFork: "true" when the PR head is a cross-repository fork (skips update).
 *
 * @module scripts/pr-auto-actions
 */

const fs = require('node:fs');

const { decideAutoActions } = require('../lib/pr-monitor/auto-actions');

/**
 * Append `key=value` lines to `$GITHUB_OUTPUT` when set, else print them. Values
 * are single-line (booleans / csv / short reasons) so no multiline escaping is
 * needed; newlines are stripped defensively.
 *
 * @param {Record<string,string>} outputs
 */
function emitOutputs(outputs) {
  const target = process.env.GITHUB_OUTPUT;
  const text = Object.entries(outputs)
    .map(([k, val]) => `${k}=${String(val).replace(/[\r\n]+/g, ' ')}`)
    .join('\n') + '\n';
  if (target) fs.appendFileSync(target, text);
  else process.stdout.write(text);
}

/** Read + parse the payload file, returning null (fail-closed) on any error. */
function readPayload(path) {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function main(argv) {
  const path = argv[2] || 'pull.json';
  const isFork = String(argv[3] || '').toLowerCase() === 'true';

  const payload = readPayload(path);
  if (!payload) {
    // Fail closed: no readable verdict payload → take no action.
    emitOutputs({
      update_branch: 'false', update_reason: `no readable payload at ${path}`,
      rerun: 'false', rerun_run_ids: '', rerun_reason: `no readable payload at ${path}`,
    });
    console.log(`auto-actions: no readable payload at ${path} — no action (fail closed)`);
    return 0;
  }

  const { updateBranch, rerunFlaky } = decideAutoActions(payload, { isFork });
  emitOutputs({
    update_branch: updateBranch.should ? 'true' : 'false',
    update_reason: updateBranch.reason,
    rerun: rerunFlaky.should ? 'true' : 'false',
    rerun_run_ids: (rerunFlaky.runIds || []).join(','),
    rerun_reason: rerunFlaky.reason,
  });
  console.log(`auto-actions: update_branch=${updateBranch.should} (${updateBranch.reason})`);
  console.log(`auto-actions: rerun=${rerunFlaky.should} (${rerunFlaky.reason})`);
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main(process.argv));
  } catch (err) {
    // Absolute fail-closed backstop: never let this script red-X the monitor.
    emitOutputs({
      update_branch: 'false', update_reason: `error: ${(err && err.message) || err}`,
      rerun: 'false', rerun_run_ids: '', rerun_reason: `error: ${(err && err.message) || err}`,
    });
    console.log(`auto-actions: error — no action (fail closed): ${(err && err.message) || err}`);
    process.exit(0);
  }
}

module.exports = { emitOutputs, readPayload, main };
