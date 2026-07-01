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
const { evaluateGate } = require('../doc-gate/gate');

/** True when `root` is a git working tree with at least one commit (HEAD). */
function hasGitHead(root) {
  try {
    // NOSONAR S4036 - 'git' is a hardcoded CLI command with no user input; developer-tool context.
    execFileSync('git', ['-C', root, 'rev-parse', '--verify', 'HEAD'], { // NOSONAR S4036
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch (_err) {
    // A missing/broken git HEAD simply means "not a usable repo" here. NOSONAR S2486
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
      const detail = e.detail ? ` (${e.detail})` : '';
      lines.push(`  - ${e.field}: ${e.trigger}${detail}`);
    }
  }
  return lines.join('\n');
}

const CHECK_USAGE = 'forge doc-gate check --base <ref> --head <ref> [--skip] [--json]';
const USAGE = `forge doc-gate detect [--json]\n       ${CHECK_USAGE}`;

/** Standard "not a usable git repo" error result (exit 1). */
function notAGitRepo(root, sub) {
  return {
    success: false,
    error:
      `forge doc-gate ${sub} must run inside a git repository with at least one ` +
      `commit (HEAD). No readable git HEAD was found at ${root}.`,
    exitCode: 1,
  };
}

/** Read a `--name value` or `--name=value` flag from a raw argv array. */
function readArgValue(argv, name) {
  const prefix = `${name}=`;
  const eq = argv.find(a => a.startsWith(prefix));
  if (eq) return eq.slice(prefix.length);
  const i = argv.indexOf(name);
  if (i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('-')) return argv[i + 1];
  return null;
}

/** Render a gate result as a readable summary. */
function renderGate(result) {
  const surface = Array.isArray(result.sourceSurface) && result.sourceSurface.length > 0
    ? result.sourceSurface.join(', ')
    : '(unresolved)';
  const lines = [
    `doc-gate check — ${result.decision.toUpperCase()}`,
    `verdict: ${result.verdict}`,
    `source surface: ${surface}`,
    `reason: ${result.reason}`,
  ];
  if (result.offendingCodeFiles.length > 0) {
    lines.push('code changes without a doc update:');
    for (const f of result.offendingCodeFiles) lines.push(`  - ${f}`);
  }
  if (result.docChangesSeen.length > 0) {
    lines.push('doc changes seen:');
    for (const f of result.docChangesSeen) lines.push(`  - ${f}`);
  }
  return lines.join('\n');
}

/** `detect` subcommand — repo-structure summary (exit 0 on any verdict). */
function runDetect(argv, flags, root) {
  if (!hasGitHead(root)) return notAGitRepo(root, 'detect');
  const json = Boolean(flags?.json) || argv.includes('--json');
  const result = detect(root);
  const output = json ? JSON.stringify(result, null, 2) : renderHuman(result);
  return { success: true, output, json };
}

/** `check` subcommand — enforce "a code change requires a doc update". */
function runCheck(argv, flags, root) {
  if (!hasGitHead(root)) return notAGitRepo(root, 'check');
  const json = Boolean(flags?.json) || argv.includes('--json');
  const skip = Boolean(flags?.skip) || argv.includes('--skip');
  const base = readArgValue(argv, '--base');
  const head = readArgValue(argv, '--head');
  if (!skip && (!base || !head)) {
    return {
      success: false,
      error: `forge doc-gate check requires --base <ref> and --head <ref>.\nUsage: ${CHECK_USAGE}`,
      exitCode: 1,
    };
  }

  const result = evaluateGate({ root, base, head, skip });
  const output = json ? JSON.stringify(result, null, 2) : renderGate(result);
  // Exit 1 ONLY on a hard fail; pass and abstain both exit 0.
  if (result.decision === 'fail') {
    return { success: false, error: `doc-gate: ${result.reason}`, output, exitCode: 1 };
  }
  return { success: true, output, json };
}

module.exports = {
  name: 'doc-gate',
  description: 'Detect a repository\'s structure, or enforce the doc-update gate on a PR',
  usage: USAGE,
  flags: {
    '--json': 'Emit a structured JSON object instead of the human summary.',
    '--base': 'check: base ref/SHA of the pull request.',
    '--head': 'check: head ref/SHA of the pull request.',
    '--skip': 'check: force a pass (e.g. a no-docs-needed label).',
  },

  async handler(args, flags, projectRoot, _opts = {}) {
    const argv = Array.isArray(args) ? args : [];
    const sub = argv.find(a => a && !a.startsWith('-')) || 'detect';
    const root = projectRoot || process.cwd();

    if (sub === 'detect') return runDetect(argv, flags, root);
    if (sub === 'check') return runCheck(argv, flags, root);
    return {
      success: false,
      error: `Unknown doc-gate subcommand '${sub}'. Supported subcommands: detect, check.\nUsage: ${USAGE}`,
      exitCode: 1,
    };
  },
};
