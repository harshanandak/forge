'use strict';

/**
 * `forge doc-gate` — repo-structure detector command (thin wrapper).
 *
 * Subcommand: `detect [--json]`. Runs the validated doc-gate detector
 * (lib/doc-gate/detect.js) against the cwd repo and prints a human summary by
 * default, or a structured JSON object with `--json`.
 *
 * Exit non-zero ONLY on a real error (not a git repo / no commits, or an
 * unknown subcommand). An ESCALATE-TO-AGENT or MANUAL-CONFIG verdict is a valid
 * detection result and exits 0.
 *
 * This is the first PR of the larger "doc-gate" feature; the CI required-gate,
 * OKF-bundle generation, and agent escalation runtime are deliberately NOT here.
 *
 * @module commands/doc-gate
 */

const { execFileSync } = require('node:child_process');
const { detect } = require('../doc-gate/detect');

/** True when `root` is a git working tree with at least one commit (HEAD). */
function hasGitHead(root) {
  try {
    execFileSync('git', ['-C', root, 'rev-parse', '--verify', 'HEAD'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch (_err) {
    return false;
  }
}

/** Format a single field for the human summary. */
function fieldLine(label, field, valueKey) {
  let display;
  if (field.escalate) {
    display = `ESCALATE→agent (${field.trigger})`;
  } else {
    const raw = field[valueKey];
    if (raw === null || raw === undefined || (Array.isArray(raw) && raw.length === 0)) {
      display = '(none / abstain)';
    } else {
      display = Array.isArray(raw) ? raw.join(', ') : String(raw);
    }
  }
  return `  ${label.padEnd(10)} ${display}  [${field.confidence}]`;
}

/** Render the detector result as a readable summary. */
function renderHuman(result) {
  const lines = [
    `doc-gate detect — ${result.repo}`,
    `verdict: ${result.verdict}`,
    fieldLine('source', result.source, 'value'),
    fieldLine('toolchain', result.toolchain, 'value'),
    fieldLine('ci', result.ci, 'provider'),
    fieldLine('changelog', result.changelog, 'value'),
    fieldLine('agents', result.agents, 'value'),
    `code-high-confidence: ${result.codeHighConfidence.length ? result.codeHighConfidence.join(', ') : '(none)'}`,
  ];
  if (Array.isArray(result.escalate) && result.escalate.length > 0) {
    lines.push('escalate:');
    for (const e of result.escalate) {
      lines.push(`  - ${e.field}: ${e.trigger}${e.detail ? ` (${e.detail})` : ''}`);
    }
  }
  return lines.join('\n');
}

const USAGE = 'forge doc-gate detect [--json]';

module.exports = {
  name: 'doc-gate',
  description: 'Detect a repository\'s structure (source/toolchain/ci/changelog/agents)',
  usage: USAGE,
  flags: {
    '--json': 'Emit a structured JSON object instead of the human summary.',
  },

  async handler(args, flags, projectRoot, _opts = {}) {
    const argv = Array.isArray(args) ? args : [];
    const sub = argv.find(a => a && !a.startsWith('-')) || 'detect';
    const json = Boolean(flags && flags.json) || argv.includes('--json');

    if (sub !== 'detect') {
      return {
        success: false,
        error: `Unknown doc-gate subcommand '${sub}'. Supported subcommands: detect.\nUsage: ${USAGE}`,
        exitCode: 1,
      };
    }

    const root = projectRoot || process.cwd();
    if (!hasGitHead(root)) {
      return {
        success: false,
        error:
          'forge doc-gate detect must run inside a git repository with at least one ' +
          `commit (HEAD). No readable git HEAD was found at ${root}.`,
        exitCode: 1,
      };
    }

    const result = detect(root);
    const output = json ? JSON.stringify(result, null, 2) : renderHuman(result);
    return { success: true, output, json };
  },
};
