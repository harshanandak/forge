#!/usr/bin/env node
'use strict';

/**
 * pr-verdict label emitter — maps a canonical merge verdict (from
 * `forge shepherd <pr> --pull --json`, lib/pr-pull.js) to its single
 * `pr-verdict:*` label and emits `label` + `all_labels` to `$GITHUB_OUTPUT`
 * (or stdout locally) for the pr-monitor workflow's reconcile step.
 *
 * SINGLE SOURCE: the verdict value and the label vocabulary both come from
 * lib/pr-pull.js — this script computes NO verdict of its own, so the label can
 * never disagree with `--pull`. Fails closed to `unknown` on empty input.
 * Performs NO GitHub writes (the workflow owns the visible `gh` calls).
 *
 * Usage: node scripts/pr-verdict-label.js <VERDICT>
 *
 * @module scripts/pr-verdict-label
 */

const fs = require('node:fs');

const { verdictLabel, VERDICT_LABELS } = require('../lib/pr-pull');

/**
 * Append `key=value` lines to `$GITHUB_OUTPUT` when set, else print them.
 *
 * @param {Record<string,string>} outputs
 */
function emitOutputs(outputs) {
  const target = process.env.GITHUB_OUTPUT;
  const text = Object.entries(outputs).map(([k, val]) => `${k}=${val}`).join('\n') + '\n';
  if (target) fs.appendFileSync(target, text);
  else process.stdout.write(text);
}

function main(argv) {
  // Fail closed: a missing/empty verdict arg maps to the `unknown` label rather
  // than erroring — the workflow must still land a label on every pass.
  const verdict = argv[2] || 'UNKNOWN';
  const label = verdictLabel(verdict);
  emitOutputs({ label, all_labels: VERDICT_LABELS.join(',') });
  console.log(`pr-verdict label: ${label} (verdict ${verdict})`);
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = { emitOutputs, main };
