'use strict';

const { describe, expect, test } = require('bun:test');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const releaseCommand = require('../../lib/commands/release');
const {
  buildReadinessReport,
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
  test('fails the 0.1.0 readiness gate with all current Beads retirement blockers', async () => {
    const result = await releaseCommand.handler(['check', '--target', '0.1.0'], {}, repoRoot);

    expect(result.success).toBe(false);
    expect(result.report.target).toBe('0.1.0');
    expect(result.error).toContain('Forge release readiness check: 0.1.0');

    const blockerIds = result.report.blockers.map(blocker => blocker.id);
    // bd-hot-path-issue-commands cleared once scripts/smart-status.sh — the last
    // hot-path surface — was de-beaded (it now reads `forge issue list --json`),
    // so the only remaining 0.1.0 blocker is the fresh-clone acceptance test.
    // (kernel-backed-forge-issue + premerge-embedded-gate cleared in earlier lanes.)
    expect(blockerIds).toEqual([
      'fresh-clone-no-beads-acceptance',
    ]);

    expect(result.report.blockers.some(blocker => blocker.id === 'kernel-backed-forge-issue')).toBe(false);
    expect(result.report.blockers.some(blocker => blocker.id === 'bd-hot-path-issue-commands')).toBe(false);
  }, FULL_REPO_READINESS_TIMEOUT_MS);

  test('rejects unsupported targets explicitly', async () => {
    const result = await releaseCommand.handler(['check', '--target', '0.0.11'], {}, repoRoot);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unsupported release readiness target');
  }, FULL_REPO_READINESS_TIMEOUT_MS);

  test('writes JSON reports to stdout while failing the CLI gate', () => {
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

    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.success).toBe(false);
    expect(report.target).toBe('0.1.0');
    expect(report.blockers.map(blocker => blocker.id)).toContain('fresh-clone-no-beads-acceptance');
    expect(result.stderr).toContain('Forge release readiness check failed for 0.1.0');
  }, FULL_REPO_READINESS_TIMEOUT_MS);
});

describe('0.1.0 readiness report', () => {
  test('tracks bd call sites by migration group', () => {
    const report = buildReadinessReport(repoRoot, { target: '0.1.0' });

    expect(report.success).toBe(false);
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

    expect(output).toContain('Result: FAIL');
    expect(output).toContain('fresh-clone-no-beads-acceptance');
    expect(auditMarkdown).toContain('# D20 bd Call-Site Kill List');
    expect(auditMarkdown).toContain('## command');
    expect(auditMarkdown).toContain('## runtime');
    expect(auditMarkdown).toContain('## docs');
    expect(auditMarkdown).toContain('## skills');
    expect(auditMarkdown).toContain('## hooks');
    expect(fs.existsSync(artifactPath)).toBe(true);
  }, FULL_REPO_READINESS_TIMEOUT_MS);
});
