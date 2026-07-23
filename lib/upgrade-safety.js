'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { lintRuntimeGraphConfig } = require('./core/runtime-graph');
const { resolvePatchIntentRecords } = require('./patch-intent');
const { verifyForgeLock, readForgeLock } = require('./forge-lock');
const { readConfigBackend, resolveIssueBackend } = require('./issue-backend');
const { detectBeadsJsonlSource } = require('./beads-detect');

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

function safeConfigBackend(projectRoot) {
  try {
    return readConfigBackend(projectRoot);
  } catch {
    return null;
  }
}

// Detect the 0.0.10 -> current breaking boundary that hides a returning user's
// issues (kernel issue a5399f3d): a `.beads/*.jsonl` store still present now that
// the Kernel is the only backend. There is no longer any way to opt back into
// Beads, so a leftover `issueBackend: beads` in `.forge/config.yaml` (or
// FORGE_ISSUE_BACKEND) can no longer suppress this advisory — resolveIssueBackend
// answers 'kernel' regardless, which is precisely when the user needs to migrate.
// `configBackend` is still reported so the surface can name the stale setting.
// Uses the single shared detector so the two surfaces cannot drift.
function buildBeadsMigrationSummary(projectRoot, env = process.env) {
  const jsonlPresent = detectBeadsJsonlSource(projectRoot) !== null;
  const configBackend = safeConfigBackend(projectRoot);
  const backend = resolveIssueBackend({ env, projectRoot, warn: () => {} });
  return {
    jsonlPresent,
    configBackend,
    needsMigration: jsonlPresent && backend === 'kernel',
  };
}

function buildUpgradeDryRunReport(projectRoot = process.cwd(), env = process.env) {
  const root = path.resolve(projectRoot);
  const runtime = lintRuntimeGraphConfig({ projectRoot: root });
  const patchIntent = buildPatchIntentSummary(root);
  const lockReport = verifyForgeLock(root);
  const lock = readForgeLock(root);
  const selfHealCandidates = buildSelfHealCandidates(root);
  const failedLockEntries = lockReport.results.filter(result => result.status === 'fail');
  const untrustedOptIns = countUntrustedOptIns(lock);
  const lockTrustOk = lockReport.ok && untrustedOptIns === 0;
  const beadsMigration = buildBeadsMigrationSummary(root, env);

  return {
    // A pending beads -> kernel migration is a guided ADVISORY, not an integrity
    // failure — it never flips `ok` (scripts keying on it stay stable); it surfaces
    // as its own prominent "action required" section in the rendered report.
    ok: runtime.ok && patchIntent.ok && lockTrustOk,
    projectRoot: root,
    runtime,
    patchIntent,
    lock,
    lockReport,
    lockTrustOk,
    selfHealCandidates,
    failedLockEntries,
    beadsMigration,
  };
}

function formatCheck(status, label, detail) {
  return `[${status.toUpperCase()}] ${label}: ${detail}`;
}

function runtimeDetail(runtime) {
  return runtime.ok
    ? 'resolved runtime graph config'
    : runtime.errors.map(error => error.message).join('; ');
}

function patchIntentDetail(patchIntent) {
  return patchIntent.error
    ? patchIntent.error
    : `${patchIntent.records} record(s), ${patchIntent.orphans} orphan(s)`;
}

function readinessLines(report) {
  const untrustedOptIns = countUntrustedOptIns(report.lock);
  const lockStatus = report.lockTrustOk ? 'pass' : 'fail';
  return [
    formatCheck(checkStatus(report.runtime.ok), 'Runtime config', runtimeDetail(report.runtime)),
    formatCheck(checkStatus(report.patchIntent.ok), 'Patch intent', patchIntentDetail(report.patchIntent)),
    formatCheck(
      lockStatus,
      'Lock trust',
      `${report.lock.extensions.length} extension(s), ${untrustedOptIns} untrusted opt-in${untrustedOptIns === 1 ? '' : 's'}`
    ),
    ...report.lockReport.results.map(result => formatCheck(result.status, result.name, result.reason)),
  ];
}

function appendPlannedSelfHeal(lines, candidates) {
  lines.push('', 'Planned self-heal');
  if (candidates.length === 0) {
    lines.push('No self-heal actions needed.');
    return;
  }
  for (const candidate of candidates) {
    lines.push(`- ${candidate.path}: ${candidate.description}`);
  }
}

function appendSelfHealResult(lines, selfHealResult) {
  if (!selfHealResult) return;
  lines.push('', 'Self-heal result');
  if (selfHealResult.refused) {
    lines.push('Self-heal refused unrecoverable lock integrity failure.');
    return;
  }
  if (selfHealResult.applied.length === 0) {
    lines.push('No self-heal actions needed.');
    return;
  }
  lines.push(`Self-heal applied ${selfHealResult.applied.length} action(s).`);
  for (const action of selfHealResult.applied) {
    lines.push(`- ${action.path}`);
  }
}

function appendBeadsMigration(lines, beadsMigration) {
  if (!beadsMigration || !beadsMigration.needsMigration) {
    return;
  }
  lines.push(
    '',
    'Breaking change since 0.0.10 — action required',
    'Detected a Beads issue store (.beads/*.jsonl). The Kernel is now the only',
    'issue backend, so these issues will NOT appear until migrated (your data is safe',
    'on disk in the meantime). To migrate:',
    '  forge migrate --from beads   # import your Beads issues into the Kernel',
    '  forge setup                  # (re)wire hooks + provision the Kernel store',
  );
}

function renderUpgradeDryRunReport(report, selfHealResult = null) {
  const lines = [
    'Forge upgrade dry-run',
    `Target: ${report.projectRoot}`,
    `Result: ${report.ok ? 'PASS' : 'FAIL'}`,
    '',
    'Readiness',
    ...readinessLines(report),
  ];

  appendBeadsMigration(lines, report.beadsMigration);
  appendPlannedSelfHeal(lines, report.selfHealCandidates);
  appendSelfHealResult(lines, selfHealResult);

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
  buildBeadsMigrationSummary,
  buildSelfHealCandidates,
  renderUpgradeDryRunReport,
};
