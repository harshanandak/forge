const { describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');

const {
  listFixtureNames,
  materializeFixture,
  validateMaterializedFixture,
} = require('./fixtures/v2-corpus');

describe('v2 fixture corpus', () => {
  test('defines the five W0 stress fixtures', () => {
    expect(listFixtureNames()).toEqual([
      'broken-beads-state',
      'clean-v2-install',
      'no-lefthook-installed',
      'non-master-default-branch',
      'stale-worktrees',
    ]);
  });

  test.each(listFixtureNames())('%s materializes into a valid synthetic repo', (name) => {
    const { manifest, repoRoot } = materializeFixture(name);
    const result = validateMaterializedFixture(repoRoot, manifest);

    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, '.git'))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, 'AGENTS.md'))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, '.claude', 'commands', 'plan.md'))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, '.codex', 'skills', 'plan', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, '.forge', 'v2', 'workflow-stage-matrix.json'))).toBe(true);
  });

  test('stale worktree fixture creates runtime-only git worktree metadata', () => {
    const { manifest, repoRoot } = materializeFixture('stale-worktrees');
    const worktreeRoot = path.join(repoRoot, '.git', 'worktrees');

    expect(manifest.expectations.staleWorktrees).toBe(2);
    expect(fs.readdirSync(worktreeRoot).sort()).toEqual(['old-review', 'wip-migration']);
    expect(fs.readFileSync(path.join(worktreeRoot, 'old-review', 'gitdir'), 'utf8')).toContain('missing-old-review');
  });

  test('manifest files override shared v2 baseline files', () => {
    const { repoRoot } = materializeFixture('non-master-default-branch');
    const agents = fs.readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8');
    const rails = JSON.parse(fs.readFileSync(path.join(repoRoot, '.forge', 'l1', 'rails.json'), 'utf8'));

    expect(agents).toContain('Default branch is trunk.');
    expect(rails.rails).toEqual(['scope-discipline', 'verified-claims', 'beads-source-of-truth']);
  });

  test('non-master default branch fixture keeps master absent', () => {
    const { repoRoot } = materializeFixture('non-master-default-branch');
    const heads = fs.readdirSync(path.join(repoRoot, '.git', 'refs', 'heads')).sort();

    expect(heads).toContain('trunk');
    expect(heads).not.toContain('master');
  });
});
