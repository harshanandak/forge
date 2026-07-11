'use strict';

const { describe, expect, test } = require('bun:test');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const releaseCommand = require('../../lib/commands/release');
const {
  buildReadinessReport,
  canonicalizeAuditArtifact,
  renderBdCallSiteAuditMarkdown,
  renderReadinessReport,
} = require('../../lib/release-readiness');

const repoRoot = path.resolve(__dirname, '..', '..');
const FULL_REPO_READINESS_TIMEOUT_MS = 15000;

describe('forge release command', () => {
  test('exports the release command surface', () => {
    expect(releaseCommand.name).toBe('release');
    expect(typeof releaseCommand.description).toBe('string');
    expect(typeof releaseCommand.handler).toBe('function');
  });
});

describe('forge release check command', () => {
  test('passes the 0.1.0 readiness gate — all Beads retirement blockers cleared', async () => {
    const result = await releaseCommand.handler(['check', '--target', '0.1.0'], {}, repoRoot);

    // The final blocker (fresh-clone-no-beads-acceptance) cleared once the D22
    // fresh-clone acceptance test landed. With bd-hot-path-issue-commands,
    // kernel-backed-forge-issue, and premerge-embedded-gate cleared in earlier
    // lanes, the 0.1.0 Beads-retirement gate now PASSES with zero blockers.
    expect(result.success).toBe(true);
    expect(result.report.target).toBe('0.1.0');
    expect(result.report.blockers).toEqual([]);
  }, FULL_REPO_READINESS_TIMEOUT_MS);

  test('rejects unsupported targets explicitly', async () => {
    const result = await releaseCommand.handler(['check', '--target', '0.0.11'], {}, repoRoot);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unsupported release readiness target');
  }, FULL_REPO_READINESS_TIMEOUT_MS);

  test('writes JSON reports to stdout and passes the CLI gate', () => {
    const result = spawnSync(process.execPath, [
      'bin/forge.js',
      'release',
      'check',
      '--target',
      '0.1.0',
      '--json',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.success).toBe(true);
    expect(report.target).toBe('0.1.0');
    expect(report.blockers).toEqual([]);
  }, FULL_REPO_READINESS_TIMEOUT_MS);
});

describe('0.1.0 readiness report', () => {
  test('tracks bd call sites by migration group', () => {
    const report = buildReadinessReport(repoRoot, { target: '0.1.0' });

    // The gate now PASSES (zero blockers), but the bd call-site audit still
    // tracks non-hot-path references in docs/runtime so retirement progress
    // stays observable.
    expect(report.success).toBe(true);
    expect(report.audit.groups.command.count).toBeGreaterThan(0);
    expect(report.audit.groups.runtime.count).toBeGreaterThan(0);
    expect(report.audit.groups.docs.count).toBeGreaterThan(0);
    expect(report.audit.groups.skills.count).toBeGreaterThan(0);
    expect(report.audit.groups.hooks).toBeDefined();

    // The bd-hot-path blocker is fully CLEARED: every D20 hot-path surface
    // (issue/sync/worktree/setup/preflight/forge-team and finally
    // scripts/smart-status.sh in this lane) was de-beaded, so hotPathBlocker
    // returns null and the blocker drops out of the report. The audit groups
    // above still count non-hot-path bd references (docs/runtime), which are
    // tracked but never block the gate.
    const hotPathBlocker = report.blockers.find(blocker => blocker.id === 'bd-hot-path-issue-commands');
    expect(hotPathBlocker).toBeUndefined();
  }, FULL_REPO_READINESS_TIMEOUT_MS);

  test('renders human-readable blocker output and the checked-in D20 audit artifact', () => {
    const report = buildReadinessReport(repoRoot, { target: '0.1.0' });
    const output = renderReadinessReport(report);
    const auditMarkdown = renderBdCallSiteAuditMarkdown(report.audit);
    const artifactPath = path.join(
      repoRoot,
      'docs',
      'work',
      '2026-06-06-kernel-backlog-memory-roadmap',
      'bd-call-site-kill-list.md'
    );

    expect(output).toContain('Result: PASS');
    expect(output).toContain('No blockers found.');
    expect(auditMarkdown).toContain('# D20 bd Call-Site Kill List');
    expect(auditMarkdown).toContain('## command');
    expect(auditMarkdown).toContain('## runtime');
    expect(auditMarkdown).toContain('## docs');
    expect(auditMarkdown).toContain('## skills');
    expect(auditMarkdown).toContain('## hooks');
    expect(fs.existsSync(artifactPath)).toBe(true);
  }, FULL_REPO_READINESS_TIMEOUT_MS);

  test('artifact-currency comparison ignores line-number shifts but not count changes', () => {
    const base = [
      '# D20 bd Call-Site Kill List',
      '',
      '## command',
      '',
      '- [ ] bin/forge.js (26)',
      '  - lines: 10 (bd), 12 (bd)',
    ].join('\n');

    // Same file + same COUNT, only the recorded line numbers differ (what a PR
    // editing an unrelated part of a scanned file produces). Must canonicalize equal.
    const lineShifted = base.replace('  - lines: 10 (bd), 12 (bd)', '  - lines: 40 (bd), 42 (bd)');
    expect(canonicalizeAuditArtifact(lineShifted)).toBe(canonicalizeAuditArtifact(base));

    // A real change in the per-file COUNT must still be detected as stale.
    const countChanged = base.replace('- [ ] bin/forge.js (26)', '- [ ] bin/forge.js (27)');
    expect(canonicalizeAuditArtifact(countChanged)).not.toBe(canonicalizeAuditArtifact(base));
  });
});
