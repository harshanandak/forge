'use strict';

const { describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');

const releaseCommand = require('../../lib/commands/release');
const {
  buildReadinessReport,
  renderBdCallSiteAuditMarkdown,
  renderReadinessReport,
} = require('../../lib/release-readiness');

const repoRoot = path.resolve(__dirname, '..', '..');

describe('forge release check command', () => {
  test('fails the 0.1.0 readiness gate with all current Beads retirement blockers', async () => {
    const result = await releaseCommand.handler(['check', '--target', '0.1.0'], {}, repoRoot);

    expect(result.success).toBe(false);
    expect(result.report.target).toBe('0.1.0');
    expect(result.error).toContain('Forge release readiness check: 0.1.0');

    const blockerIds = result.report.blockers.map(blocker => blocker.id);
    expect(blockerIds).toEqual([
      'bd-hot-path-issue-commands',
      'kernel-backed-forge-issue',
      'forge-prime',
      'forge-orient-issue-recap',
      'forge-skills-pack',
      'forge-remember-recall',
      'fresh-clone-no-beads-acceptance',
    ]);
  });

  test('rejects unsupported targets explicitly', async () => {
    const result = await releaseCommand.handler(['check', '--target', '0.0.11'], {}, repoRoot);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unsupported release readiness target');
  });
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

    const hotPathBlocker = report.blockers.find(blocker => blocker.id === 'bd-hot-path-issue-commands');
    expect(hotPathBlocker.evidence.some(item => item.path === 'lib/commands/_issue.js')).toBe(true);
    expect(hotPathBlocker.evidence.some(item => item.path === 'lib/commands/sync.js')).toBe(true);
    expect(hotPathBlocker.evidence.some(item => item.path === 'lib/workflow/state-manager.js')).toBe(true);
  });

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
    expect(output).toContain('bd in hot-path issue commands');
    expect(auditMarkdown).toContain('# D20 bd Call-Site Kill List');
    expect(auditMarkdown).toContain('## command');
    expect(auditMarkdown).toContain('## runtime');
    expect(auditMarkdown).toContain('## docs');
    expect(auditMarkdown).toContain('## skills');
    expect(auditMarkdown).toContain('## hooks');
    expect(fs.existsSync(artifactPath)).toBe(true);
  });
});
