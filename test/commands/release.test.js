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
    // kernel-backed-forge-issue cleared once _issue.js was de-beaded, the kernel
    // adapter exposed `dep`, and claim/release became kernel-backed static commands.
    // premerge-embedded-gate cleared once pre-merge was re-homed as a task-type
    // gate (WORKFLOW_GATES) and the premerge token left stages.js, workflow-profiles.js,
    // and AGENTS.md.
    expect(blockerIds).toEqual([
      'bd-hot-path-issue-commands',
      'fresh-clone-no-beads-acceptance',
    ]);

    expect(result.report.blockers.some(blocker => blocker.id === 'kernel-backed-forge-issue')).toBe(false);
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
    expect(report.blockers.map(blocker => blocker.id)).toContain('bd-hot-path-issue-commands');
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

    const hotPathBlocker = report.blockers.find(blocker => blocker.id === 'bd-hot-path-issue-commands');
    expect(hotPathBlocker).toBeDefined();
    // lib/commands/_issue.js is no longer hot-path evidence: it was de-beaded (all bd
    // translation moved into the beads backend), so it carries no bd/.beads/dolt token.
    expect(hotPathBlocker.evidence.some(item => item.path === 'lib/commands/_issue.js')).toBe(false);
    // The sync-cluster (sync/worktree/setup) + preflight were de-beaded: forge sync routes
    // through the SyncBackend seam (local-noop), worktree/clean are pure git, setup ensures the
    // kernel instead of installing beads, and preflight validates the kernel. They carry no token.
    expect(hotPathBlocker.evidence.some(item => item.path === 'lib/commands/sync.js')).toBe(false);
    expect(hotPathBlocker.evidence.some(item => item.path === 'lib/commands/worktree.js')).toBe(false);
    expect(hotPathBlocker.evidence.some(item => item.path === 'lib/commands/setup.js')).toBe(false);
    // lib/workflow/state-manager.js is no longer hot-path evidence: its issue reads
    // route through `forge issue show --json` (the comment-list fallback collapsed into
    // that single read), so it carries no bd/.beads/dolt token.
    expect(hotPathBlocker.evidence.some(item => item.path === 'lib/workflow/state-manager.js')).toBe(false);
    expect(hotPathBlocker.evidence.some(item => item.path === 'scripts/preflight.sh')).toBe(false);
    // Still hot-path evidence until the sibling lanes land (epic + premerge PRs).
    expect(hotPathBlocker.evidence.some(item => item.path === 'scripts/smart-status.sh')).toBe(true);
    expect(hotPathBlocker.evidence.some(item => item.path.startsWith('scripts/forge-team/'))).toBe(true);
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
    expect(output).toContain('bd in D20 hot-path surfaces');
    expect(auditMarkdown).toContain('# D20 bd Call-Site Kill List');
    expect(auditMarkdown).toContain('## command');
    expect(auditMarkdown).toContain('## runtime');
    expect(auditMarkdown).toContain('## docs');
    expect(auditMarkdown).toContain('## skills');
    expect(auditMarkdown).toContain('## hooks');
    expect(fs.existsSync(artifactPath)).toBe(true);
  }, FULL_REPO_READINESS_TIMEOUT_MS);
});
