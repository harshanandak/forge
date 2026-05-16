'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { lintRuntimeGraphConfig } = require('./core/runtime-graph');
const { resolvePatchIntentRecords } = require('./patch-intent');
const { verifyForgeLock, readForgeLock } = require('./forge-lock');

function checkStatus(ok) {
  return ok ? 'pass' : 'fail';
}

function countUntrustedOptIns(lock) {
  return lock.extensions.filter(entry => entry.trust?.allowUntrusted === true).length;
}

function buildPatchIntentSummary(projectRoot) {
  try {
    const status = resolvePatchIntentRecords(projectRoot);
    return {
      ok: status.orphans.length === 0,
      path: status.path,
      records: status.records.length,
      orphans: status.orphans.length,
    };
  } catch (error) {
    return {
      ok: false,
      path: '.forge/patch.md',
      records: 0,
      orphans: 0,
      error: error.message,
    };
  }
}

function buildSelfHealCandidates(projectRoot) {
  const forgeDir = path.join(projectRoot, '.forge');
  const logPath = path.join(forgeDir, 'log.jsonl');
  const candidates = [];
  if (!fs.existsSync(forgeDir)) {
    candidates.push({
      id: 'forge-dir',
      path: '.forge/',
      description: 'Create missing Forge metadata directory',
    });
  }
  if (!fs.existsSync(logPath)) {
    candidates.push({
      id: 'audit-log',
      path: '.forge/log.jsonl',
      description: 'Create missing Forge audit log file',
    });
  }
  return candidates;
}

function buildUpgradeDryRunReport(projectRoot = process.cwd()) {
  const root = path.resolve(projectRoot);
  const runtime = lintRuntimeGraphConfig({ projectRoot: root });
  const patchIntent = buildPatchIntentSummary(root);
  const lockReport = verifyForgeLock(root);
  const lock = readForgeLock(root);
  const selfHealCandidates = buildSelfHealCandidates(root);
  const failedLockEntries = lockReport.results.filter(result => result.status === 'fail');

  return {
    ok: runtime.ok && patchIntent.ok && lockReport.ok,
    projectRoot: root,
    runtime,
    patchIntent,
    lock,
    lockReport,
    selfHealCandidates,
    failedLockEntries,
  };
}

function formatCheck(status, label, detail) {
  return `[${status.toUpperCase()}] ${label}: ${detail}`;
}

function renderUpgradeDryRunReport(report, selfHealResult = null) {
  const untrustedOptIns = countUntrustedOptIns(report.lock);
  const lines = [
    'Forge upgrade dry-run',
    `Target: ${report.projectRoot}`,
    `Result: ${report.ok ? 'PASS' : 'FAIL'}`,
    '',
    'Readiness',
    formatCheck(
      checkStatus(report.runtime.ok),
      'Runtime config',
      report.runtime.ok ? 'resolved runtime graph config' : report.runtime.errors.map(error => error.message).join('; ')
    ),
    formatCheck(
      checkStatus(report.patchIntent.ok),
      'Patch intent',
      report.patchIntent.error
        ? report.patchIntent.error
        : `${report.patchIntent.records} record(s), ${report.patchIntent.orphans} orphan(s)`
    ),
    formatCheck(
      'pass',
      'Lock trust',
      `${report.lock.extensions.length} extension(s), ${untrustedOptIns} untrusted opt-in${untrustedOptIns === 1 ? '' : 's'}`
    ),
  ];

  for (const result of report.lockReport.results) {
    lines.push(formatCheck(result.status, result.name, result.reason));
  }

  lines.push('', 'Planned self-heal');
  if (report.selfHealCandidates.length === 0) {
    lines.push('No self-heal actions needed.');
  } else {
    for (const candidate of report.selfHealCandidates) {
      lines.push(`- ${candidate.path}: ${candidate.description}`);
    }
  }

  if (selfHealResult) {
    lines.push('', 'Self-heal result');
    if (selfHealResult.refused) {
      lines.push('Self-heal refused unrecoverable lock integrity failure.');
    } else if (selfHealResult.applied.length === 0) {
      lines.push('No self-heal actions needed.');
    } else {
      lines.push(`Self-heal applied ${selfHealResult.applied.length} action(s).`);
      for (const action of selfHealResult.applied) {
        lines.push(`- ${action.path}`);
      }
    }
  }

  lines.push(
    '',
    'Limitations',
    'Non-scope: rollback snapshots and full restore are not implemented in this PR.',
    'Remote/package source integrity is recorded as explicit trust policy only until a resolver can materialize bytes for SRI verification.'
  );

  return `${lines.join('\n')}\n`;
}

function applySelfHeal(projectRoot, report) {
  if (report.failedLockEntries.length > 0) {
    return {
      refused: true,
      applied: [],
      reason: 'unrecoverable lock integrity failure',
    };
  }

  const applied = [];
  const forgeDir = path.join(projectRoot, '.forge');
  const logPath = path.join(forgeDir, 'log.jsonl');

  if (!fs.existsSync(forgeDir)) {
    fs.mkdirSync(forgeDir, { recursive: true });
    applied.push({ path: '.forge/' });
  }

  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, '', 'utf8');
    applied.push({ path: '.forge/log.jsonl' });
  }

  return {
    refused: false,
    applied,
  };
}

module.exports = {
  applySelfHeal,
  buildUpgradeDryRunReport,
  buildSelfHealCandidates,
  renderUpgradeDryRunReport,
};

