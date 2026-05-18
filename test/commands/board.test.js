const { describe, test, expect } = require('bun:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const boardCommand = require('../../lib/commands/board.js');

function createTempBeadsRepo(entries) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-board-'));
  const beadsDir = path.join(repoRoot, '.beads');
  fs.mkdirSync(beadsDir, { recursive: true });
  fs.writeFileSync(
    path.join(beadsDir, 'issues.jsonl'),
    `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`,
    'utf8'
  );
  execFileSync('git', ['init'], { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['config', 'user.email', 'harshanandak@users.noreply.github.com'], { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['config', 'user.name', 'Harsha Nanda'], { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] });
  return repoRoot;
}

describe('forge board command', () => {
  test('renders active, ready, blocked, stale, and completed columns', async () => {
    const repoRoot = createTempBeadsRepo([
      { id: 'forge-active', title: 'Active issue', status: 'in_progress', owner: 'harshanandak@users.noreply.github.com', updated_at: '2026-04-01T08:00:00Z' },
      { id: 'forge-ready', title: 'Ready issue', status: 'open', dependency_count: 0, updated_at: '2026-05-18T08:00:00Z' },
      { id: 'forge-blocked', title: 'Blocked issue', status: 'open', dependency_count: 1, updated_at: '2026-05-17T08:00:00Z' },
      { id: 'forge-done', title: 'Done issue', status: 'closed', updated_at: '2026-05-16T08:00:00Z' },
    ]);

    const result = await boardCommand.handler([], {
      now: new Date('2026-05-18T08:00:00Z'),
      staleAfterDays: 14,
    }, repoRoot);

    expect(result.output).toContain('Team Runtime Board');
    for (const section of ['Active', 'Ready', 'Blocked', 'Stale', 'Recent Completions']) {
      expect(result.output).toContain(section);
    }
    expect(result.output).toContain('forge-active');
    expect(result.output).toContain('forge-ready');
    expect(result.output).toContain('forge-blocked');
    expect(result.output).toContain('forge-done');
  });

  test('returns JSON board state', async () => {
    const repoRoot = createTempBeadsRepo([
      { id: 'forge-active', title: 'Active issue', status: 'in_progress', updated_at: '2026-05-18T08:00:00Z' },
    ]);

    const result = await boardCommand.handler(['--json'], {}, repoRoot);
    const parsed = JSON.parse(result.output);

    expect(parsed.board.active.map(issue => issue.id)).toEqual(['forge-active']);
    expect(parsed.board.ready).toEqual([]);
    expect(parsed.limits.join('\n')).toContain('local Beads');
  });

  test('renders explicit empty columns when no issues exist', async () => {
    const repoRoot = createTempBeadsRepo([]);

    const result = await boardCommand.handler([], {}, repoRoot);

    expect(result.output).toContain('Team Runtime Board');
    expect(result.output).toContain('none');
  });
});
