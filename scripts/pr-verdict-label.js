#!/usr/bin/env node
'use strict';

/**
 * pr-verdict label emitter — thin glue between the read-only PR-state bundle the
 * pr-monitor workflow already gathers and its label-reconcile step. Reads
 * bundle.json, computes the actionable verdict (lib/pr-verdict.js), and emits the
 * chosen `pr-verdict:*` label plus the full reconcile set to `$GITHUB_OUTPUT`
 * (or stdout when run locally).
 *
 * Performs NO GitHub writes — the workflow owns the visible, auditable `gh` calls
 * that add the chosen label and strip stale siblings. Pure compute + emit, so the
 * decision logic stays unit-tested in lib/pr-verdict.js and this stays trivial.
 * Surface only: never merges, never resolves threads.
 *
 * Usage: node scripts/pr-verdict-label.js <bundle.json>
 *
 * @module scripts/pr-verdict-label
 */

const fs = require('node:fs');

const { computeVerdict, verdictLabel, VERDICT_LABELS } = require('../lib/pr-verdict');

/**
 * Build the label report for a bundle.
 *
 * @param {object} bundle
 * @returns {{ verdict: string, label: string, allLabels: string[] }}
 */
function buildLabelReport(bundle) {
  const payload = computeVerdict(bundle);
  return { verdict: payload.verdict, label: verdictLabel(payload.verdict), allLabels: VERDICT_LABELS };
}

/**
 * Append `key=value` lines to `$GITHUB_OUTPUT` when set, else print them. Values
 * are single-line, so no heredoc framing is needed.
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
  const bundlePath = argv[2];
  if (!bundlePath) {
    console.error('Usage: node scripts/pr-verdict-label.js <bundle.json>');
    return 1;
  }
  let bundle;
  try {
    bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
  } catch (err) {
    console.error(`pr-verdict-label: cannot read/parse ${bundlePath}: ${err.message}`);
    return 1;
  }
  const report = buildLabelReport(bundle);
  emitOutputs({ verdict: report.verdict, label: report.label, all_labels: report.allLabels.join(',') });
  console.log(`pr-verdict label: ${report.label}`);
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = { buildLabelReport, emitOutputs, main };
