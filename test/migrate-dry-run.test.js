const { describe, expect, test } = require('bun:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildMigrationDryRunReport,
  renderMigrationDryRunReport,
  runV2FixtureCorpusDryRun,
} = require('../lib/migrate-dry-run');
const migrateCommand = require('../lib/commands/migrate');
const { materializeFixture } = require('./fixtures/v2-corpus');

function readGitStatus(repoRoot) {
  return execFileSync('git', ['status', '--short'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

describe('migrate dry-run', () => {
  test('validates a clean v2 fixture and renders a green diff report without mutating it', async () => {
    const { repoRoot } = materializeFixture('clean-v2-install');
    const before = readGitStatus(repoRoot);

    const report = buildMigrationDryRunReport(repoRoot);
    const output = renderMigrationDryRunReport(report);

    expect(report.ok).toBe(true);
    expect(output).toContain('Result: PASS');
    expect(output).toContain('[PASS] Beads issue state');
    expect(output).toContain('[PASS] WORKFLOW_STAGE_MATRIX');
    expect(output).toContain('+++ .forge/config.yaml');
    expect(output).toContain('+++ .forge/patch.md');
    expect(output).toContain('No files were written');
    expect(readGitStatus(repoRoot)).toBe(before);
  });

  test('reports malformed Beads JSONL as a dry-run validation failure', () => {
    const { repoRoot } = materializeFixture('broken-beads-state');

    const report = buildMigrationDryRunReport(repoRoot);
    const output = renderMigrationDryRunReport(report);

    expect(report.ok).toBe(false);
    expect(output).toContain('Result: FAIL');
    expect(output).toContain('[FAIL] Beads issue state');
    expect(output).toContain('.beads/issues.jsonl:2');
  });

  test('requires the Wave 0 issue marker in Beads state', () => {
    const { repoRoot } = materializeFixture('clean-v2-install');
    const issuesPath = path.join(repoRoot, '.beads', 'issues.jsonl');
    const withoutWaveIssue = fs.readFileSync(issuesPath, 'utf8')
      .split(/\r?\n/)
      .filter(line => !line.includes('"id":"forge-0uo0"'))
      .join('\n');
    fs.writeFileSync(issuesPath, `${withoutWaveIssue}\n`, 'utf8');

    const report = buildMigrationDryRunReport(repoRoot, { requireWaveIssue: true });
    const output = renderMigrationDryRunReport(report);

    expect(report.ok).toBe(false);
    expect(output).toContain('[FAIL] Wave 0 issue forge-0uo0');
    expect(output).toContain('missing from .beads/issues.jsonl');
  });

  test('treats detached HEAD as a valid Git repository', () => {
    const { repoRoot } = materializeFixture('clean-v2-install');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['checkout', '--detach', head], {
      cwd: repoRoot,
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    const report = buildMigrationDryRunReport(repoRoot);
    const output = renderMigrationDryRunReport(report);

    expect(report.ok).toBe(true);
    expect(report.branch).toBe(null);
    expect(output).toContain('[PASS] Git repository: detached HEAD');
  });

  test('command refuses non-dry-run migration for this Wave 0 PoC', async () => {
    const result = await migrateCommand.handler([], {}, process.cwd());

    expect(result.success).toBe(false);
    expect(result.error).toContain('Only forge migrate --dry-run is implemented');
  });

  test('command emits the dry-run report for a target repo', async () => {
    const { repoRoot } = materializeFixture('clean-v2-install');

    const result = await migrateCommand.handler(['--dry-run'], { dryRun: true }, repoRoot);

    expect(result.success).toBe(true);
    expect(result.output).toContain('Forge v2 -> v3 migration dry-run');
    expect(result.output).toContain('Result: PASS');
    expect(result.output).toContain('Fixture corpus: available');
  });

  test('can run the v2 fixture corpus when explicitly requested', () => {
    const result = runV2FixtureCorpusDryRun();

    expect(result.available).toBe(true);
    expect(result.results.map(item => item.name).sort()).toEqual([
      'broken-beads-state',
      'clean-v2-install',
      'no-lefthook-installed',
      'non-master-default-branch',
      'stale-worktrees',
    ]);
    expect(result.results.find(item => item.name === 'clean-v2-install').ok).toBe(true);
    expect(result.results.find(item => item.name === 'broken-beads-state').ok).toBe(false);
  }, 15000);
});
