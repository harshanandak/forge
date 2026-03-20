const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { describe, test, expect, beforeAll, afterAll } = require('bun:test');

/**
 * Tests for scripts/smart-status.sh
 *
 * The script reads issues (via bd list --json) and computes a composite score:
 *   priority_weight * unblock_chain * type_weight * status_boost * epic_proximity * staleness_boost
 *
 * Scoring factors:
 *   - Priority weight: P0=5, P1=4, P2=3, P3=2, P4=1
 *   - Unblock chain: dependent_count + 1 (min 1)
 *   - Type weight: bug=1.2, feature=1.0, task=0.8
 *   - Status boost: in_progress=1.5, open=1.0
 *   - Epic proximity: 1.0 + (closed_siblings / total_siblings) * 0.5
 *   - Staleness: 0-7d=1.0, 7-14d=1.1, 14-30d=1.2, 30+d=1.5
 */

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'smart-status.sh');
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const GIT_BASH_PATH = 'C:\\Program Files\\Git\\bin\\bash.exe';

function resolveBashCommand() {
  if (process.env.BASH_CMD) {
    return process.env.BASH_CMD;
  }
  if (process.platform === 'win32' && fs.existsSync(GIT_BASH_PATH)) {
    return GIT_BASH_PATH;
  }
  return 'bash';
}

/**
 * Run the smart-status script with given arguments.
 * @param {string[]} args - CLI arguments
 * @param {object} env - Additional environment variables
 * @param {string} [stdin] - Optional stdin data
 * @returns {{ status: number|null, stdout: string, stderr: string }}
 */
function runSmartStatus(args = [], env = {}, stdin = undefined) {
  const result = spawnSync(resolveBashCommand(), [SCRIPT, ...args], {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    timeout: 15000,
    input: stdin,
    env: {
      ...process.env,
      // Default GIT_CMD to 'true' (outputs nothing) so tests don't pick up
      // real worktrees. Session detection tests override this with a mock.
      GIT_CMD: 'true',
      ...env,
    },
  });
  return {
    status: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };
}

/**
 * Helper to create a mock bd script that returns given JSON.
 * Returns path to the temp mock script.
 */
function createMockBd(jsonData) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-status-test-'));
  const mockScript = path.join(tmpDir, 'bd');
  // The mock script outputs the JSON for "bd list --json --limit 0"
  // and handles "bd children <id> --json" calls
  const scriptContent = `#!/usr/bin/env bash
if [[ "$1" == "list" ]]; then
  cat <<'JSONEOF'
${JSON.stringify(jsonData.issues || [])}
JSONEOF
elif [[ "$1" == "children" ]]; then
  # Look up children data by epic id
  EPIC_ID="$2"
  case "$EPIC_ID" in
${(jsonData.epicChildren || []).map(ec => `    "${ec.id}") cat <<'JSONEOF'
${JSON.stringify(ec.children)}
JSONEOF
    ;;`).join('\n')}
    *) echo "[]" ;;
  esac
fi
`;
  fs.writeFileSync(mockScript, scriptContent, { mode: 0o755 });
  return { tmpDir, mockScript };
}

function cleanupTmpDir(tmpDir) {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_e) {
    // ignore cleanup errors
  }
}

// Generate ISO date string N days ago
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

describe('smart-status.sh', () => {
  test('script file exists', () => {
    expect(fs.existsSync(SCRIPT)).toBe(true);
  });

  test('exits with error when jq is missing', () => {
    // Run with PATH stripped to simulate missing jq
    const result = runSmartStatus(['--json'], { PATH: '' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/jq/i);
  });

  describe('scoring factors', () => {
    test('priority_weight: P0=5 > P1=4 > P2=3 > P3=2 > P4=1', () => {
      const mockData = {
        issues: [
          { id: 'a', title: 'P4 issue', priority: 'P4', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
          { id: 'b', title: 'P0 issue', priority: 'P0', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
          { id: 'c', title: 'P2 issue', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus(['--json'], { BD_CMD: mockScript });
        expect(result.status).toBe(0);
        const scored = JSON.parse(result.stdout);
        // Should be sorted: P0 (5) > P2 (3) > P4 (1)
        expect(scored[0].id).toBe('b');
        expect(scored[1].id).toBe('c');
        expect(scored[2].id).toBe('a');
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });

    test('type_weight: bug=1.2 > feature=1.0 > task=0.8', () => {
      const mockData = {
        issues: [
          { id: 'task1', title: 'Task', priority: 'P2', type: 'task', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
          { id: 'bug1', title: 'Bug', priority: 'P2', type: 'bug', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
          { id: 'feat1', title: 'Feature', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus(['--json'], { BD_CMD: mockScript });
        expect(result.status).toBe(0);
        const scored = JSON.parse(result.stdout);
        // bug (1.2) > feature (1.0) > task (0.8)
        expect(scored[0].id).toBe('bug1');
        expect(scored[1].id).toBe('feat1');
        expect(scored[2].id).toBe('task1');
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });

    test('status_boost: in_progress=1.5 > open=1.0', () => {
      const mockData = {
        issues: [
          { id: 'open1', title: 'Open', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
          { id: 'wip1', title: 'WIP', priority: 'P2', type: 'feature', status: 'in_progress', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus(['--json'], { BD_CMD: mockScript });
        expect(result.status).toBe(0);
        const scored = JSON.parse(result.stdout);
        // in_progress (1.5) > open (1.0)
        expect(scored[0].id).toBe('wip1');
        expect(scored[1].id).toBe('open1');
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });

    test('unblock_chain: higher dependent_count scores higher', () => {
      const mockData = {
        issues: [
          { id: 'low', title: 'Low deps', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
          { id: 'high', title: 'High deps', priority: 'P2', type: 'feature', status: 'open', dependent_count: 5, updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus(['--json'], { BD_CMD: mockScript });
        expect(result.status).toBe(0);
        const scored = JSON.parse(result.stdout);
        // dependent_count 5 => chain 6, vs 0 => chain 1
        expect(scored[0].id).toBe('high');
        expect(scored[1].id).toBe('low');
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });

    test('staleness_boost: older issues score higher', () => {
      const mockData = {
        issues: [
          { id: 'fresh', title: 'Fresh', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
          { id: 'stale', title: 'Stale', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(35) },
          { id: 'medium', title: 'Medium', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(20) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus(['--json'], { BD_CMD: mockScript });
        expect(result.status).toBe(0);
        const scored = JSON.parse(result.stdout);
        // 35d=1.5 > 20d=1.2 > 1d=1.0
        expect(scored[0].id).toBe('stale');
        expect(scored[1].id).toBe('medium');
        expect(scored[2].id).toBe('fresh');
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });
  });

  describe('composite scoring and sorting', () => {
    test('sorts by composite score descending with mixed factors', () => {
      const mockData = {
        issues: [
          // P4 bug in_progress with 3 deps, 35d stale => 1 * 4 * 1.2 * 1.5 * 1.0 * 1.5 = 10.8
          { id: 'x', title: 'X', priority: 'P4', type: 'bug', status: 'in_progress', dependent_count: 3, updated_at: daysAgo(35) },
          // P0 feature open with 0 deps, 1d fresh => 5 * 1 * 1.0 * 1.0 * 1.0 * 1.0 = 5.0
          { id: 'y', title: 'Y', priority: 'P0', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
          // P1 task open with 10 deps, 10d stale => 4 * 11 * 0.8 * 1.0 * 1.0 * 1.1 = 38.72
          { id: 'z', title: 'Z', priority: 'P1', type: 'task', status: 'open', dependent_count: 10, updated_at: daysAgo(10) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus(['--json'], { BD_CMD: mockScript });
        expect(result.status).toBe(0);
        const scored = JSON.parse(result.stdout);
        expect(scored.length).toBe(3);
        // z (38.72) > x (10.8) > y (5.0)
        expect(scored[0].id).toBe('z');
        expect(scored[1].id).toBe('x');
        expect(scored[2].id).toBe('y');
        // Verify score fields exist
        expect(scored[0]).toHaveProperty('score');
        expect(scored[0]).toHaveProperty('priority_weight');
        expect(scored[0]).toHaveProperty('unblock_chain');
        expect(scored[0]).toHaveProperty('type_weight');
        expect(scored[0]).toHaveProperty('status_boost');
        expect(scored[0]).toHaveProperty('staleness_boost');
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });

    test('each scored item includes score breakdown fields', () => {
      const mockData = {
        issues: [
          { id: 'a', title: 'A', priority: 'P2', type: 'bug', status: 'in_progress', dependent_count: 2, updated_at: daysAgo(10) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus(['--json'], { BD_CMD: mockScript });
        expect(result.status).toBe(0);
        const scored = JSON.parse(result.stdout);
        const item = scored[0];
        expect(item.priority_weight).toBe(3);       // P2
        expect(item.unblock_chain).toBe(3);          // 2 + 1
        expect(item.type_weight).toBe(1.2);          // bug
        expect(item.status_boost).toBe(1.5);         // in_progress
        expect(item.staleness_boost).toBe(1.1);      // 7-14d
        // score = 3 * 3 * 1.2 * 1.5 * 1.0 * 1.1 = 17.82
        expect(item.score).toBeCloseTo(17.82, 1);
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });
  });

  describe('edge cases', () => {
    test('empty issue list returns empty array', () => {
      const mockData = { issues: [] };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus(['--json'], { BD_CMD: mockScript });
        expect(result.status).toBe(0);
        const scored = JSON.parse(result.stdout);
        expect(scored).toEqual([]);
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });

    test('single issue returns array with one scored item', () => {
      const mockData = {
        issues: [
          { id: 'solo', title: 'Solo', priority: 'P3', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(3) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus(['--json'], { BD_CMD: mockScript });
        expect(result.status).toBe(0);
        const scored = JSON.parse(result.stdout);
        expect(scored.length).toBe(1);
        expect(scored[0].id).toBe('solo');
        expect(scored[0].priority_weight).toBe(2);   // P3
        expect(scored[0].type_weight).toBe(1.0);     // feature
        expect(scored[0].status_boost).toBe(1.0);    // open
        expect(scored[0].staleness_boost).toBe(1.0); // < 7d
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });

    test('missing dependent_count defaults to 0 (chain=1)', () => {
      const mockData = {
        issues: [
          { id: 'nodeps', title: 'No deps field', priority: 'P2', type: 'feature', status: 'open', updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus(['--json'], { BD_CMD: mockScript });
        expect(result.status).toBe(0);
        const scored = JSON.parse(result.stdout);
        expect(scored[0].unblock_chain).toBe(1);
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });

    test('unknown priority defaults to weight 1', () => {
      const mockData = {
        issues: [
          { id: 'unk', title: 'Unknown pri', priority: 'P9', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus(['--json'], { BD_CMD: mockScript });
        expect(result.status).toBe(0);
        const scored = JSON.parse(result.stdout);
        expect(scored[0].priority_weight).toBe(1);
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });

    test('unknown type defaults to weight 1.0', () => {
      const mockData = {
        issues: [
          { id: 'unk', title: 'Unknown type', priority: 'P2', type: 'chore', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus(['--json'], { BD_CMD: mockScript });
        expect(result.status).toBe(0);
        const scored = JSON.parse(result.stdout);
        expect(scored[0].type_weight).toBe(1.0);
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });

    test('unknown status defaults to boost 1.0', () => {
      const mockData = {
        issues: [
          { id: 'unk', title: 'Unknown status', priority: 'P2', type: 'feature', status: 'closed', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus(['--json'], { BD_CMD: mockScript });
        expect(result.status).toBe(0);
        const scored = JSON.parse(result.stdout);
        expect(scored[0].status_boost).toBe(1.0);
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });
  });

  describe('grouped output', () => {
    test('in_progress issues appear under RESUME group', () => {
      const mockData = {
        issues: [
          { id: 'wip1', title: 'Active work', priority: 'P1', type: 'feature', status: 'in_progress', dependent_count: 0, updated_at: daysAgo(1) },
          { id: 'open1', title: 'Open work', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus([], { BD_CMD: mockScript, NO_COLOR: '1' });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('RESUME');
        // The in_progress issue should be under RESUME
        const resumeIdx = result.stdout.indexOf('RESUME');
        const wip1Idx = result.stdout.indexOf('wip1');
        expect(resumeIdx).not.toBe(-1);
        expect(wip1Idx).not.toBe(-1);
        expect(wip1Idx).toBeGreaterThan(resumeIdx);
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });

    test('P4 issues appear under BACKLOG group', () => {
      const mockData = {
        issues: [
          { id: 'p4item', title: 'Low priority backlog', priority: 'P4', type: 'task', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus([], { BD_CMD: mockScript, NO_COLOR: '1' });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('BACKLOG');
        const backlogIdx = result.stdout.indexOf('BACKLOG');
        const itemIdx = result.stdout.indexOf('p4item');
        expect(itemIdx).toBeGreaterThan(backlogIdx);
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });

    test('blocked issues (dependency_count > 0, not closed) appear under BLOCKED group', () => {
      const mockData = {
        issues: [
          { id: 'blocked1', title: 'Blocked item', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, dependency_count: 2, updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus([], { BD_CMD: mockScript, NO_COLOR: '1' });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('BLOCKED');
        const blockedIdx = result.stdout.indexOf('BLOCKED');
        const itemIdx = result.stdout.indexOf('blocked1');
        expect(itemIdx).toBeGreaterThan(blockedIdx);
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });

    test('high dependent_count (>=2) non-in_progress issues appear under UNBLOCK CHAINS', () => {
      const mockData = {
        issues: [
          { id: 'chain1', title: 'Unblock chain item', priority: 'P2', type: 'feature', status: 'open', dependent_count: 3, dependency_count: 0, updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus([], { BD_CMD: mockScript, NO_COLOR: '1' });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('UNBLOCK CHAINS');
        const chainIdx = result.stdout.indexOf('UNBLOCK CHAINS');
        const itemIdx = result.stdout.indexOf('chain1');
        expect(itemIdx).toBeGreaterThan(chainIdx);
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });

    test('open issues with no blockers and no dependencies go to READY WORK', () => {
      const mockData = {
        issues: [
          { id: 'ready1', title: 'Ready to go', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, dependency_count: 0, updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus([], { BD_CMD: mockScript, NO_COLOR: '1' });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('READY WORK');
        const readyIdx = result.stdout.indexOf('READY WORK');
        const itemIdx = result.stdout.indexOf('ready1');
        expect(itemIdx).toBeGreaterThan(readyIdx);
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });

    test('group ordering: RESUME > UNBLOCK CHAINS > READY WORK > BLOCKED > BACKLOG', () => {
      const mockData = {
        issues: [
          { id: 'wip', title: 'WIP', priority: 'P1', type: 'feature', status: 'in_progress', dependent_count: 0, dependency_count: 0, updated_at: daysAgo(1) },
          { id: 'chain', title: 'Chain', priority: 'P2', type: 'feature', status: 'open', dependent_count: 3, dependency_count: 0, updated_at: daysAgo(1) },
          { id: 'ready', title: 'Ready', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, dependency_count: 0, updated_at: daysAgo(1) },
          { id: 'blocked', title: 'Blocked', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, dependency_count: 1, updated_at: daysAgo(1) },
          { id: 'backlog', title: 'Backlog', priority: 'P4', type: 'task', status: 'open', dependent_count: 0, dependency_count: 0, updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus([], { BD_CMD: mockScript, NO_COLOR: '1' });
        expect(result.status).toBe(0);
        const resumeIdx = result.stdout.indexOf('RESUME');
        const chainIdx = result.stdout.indexOf('UNBLOCK CHAINS');
        const readyIdx = result.stdout.indexOf('READY WORK');
        const blockedIdx = result.stdout.indexOf('BLOCKED');
        const backlogIdx = result.stdout.indexOf('BACKLOG');
        expect(resumeIdx).toBeLessThan(chainIdx);
        expect(chainIdx).toBeLessThan(readyIdx);
        expect(readyIdx).toBeLessThan(blockedIdx);
        expect(blockedIdx).toBeLessThan(backlogIdx);
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });

    test('entry format: N. [score] id (priority type) -- title [status Nd]', () => {
      const mockData = {
        issues: [
          { id: 'fmt1', title: 'Format test', priority: 'P1', type: 'bug', status: 'open', dependent_count: 0, dependency_count: 0, updated_at: daysAgo(3) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus([], { BD_CMD: mockScript, NO_COLOR: '1' });
        expect(result.status).toBe(0);
        // Should match format: 1. [score] fmt1 (P1 bug) -- Format test [open 3d]
        expect(result.stdout).toMatch(/1\.\s+\[\d+(\.\d+)?\]\s+fmt1\s+\(P1 bug\)\s+--\s+Format test\s+\[open \d+d\]/);
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });

    test('unblock chain annotation shows what issue unblocks', () => {
      const mockData = {
        issues: [
          { id: 'blocker1', title: 'Blocker', priority: 'P1', type: 'feature', status: 'open', dependent_count: 2, dependency_count: 0, updated_at: daysAgo(1), dependents: ['dep-a', 'dep-b'] },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus([], { BD_CMD: mockScript, NO_COLOR: '1' });
        expect(result.status).toBe(0);
        expect(result.stdout).toMatch(/-> Unblocks:/);
        expect(result.stdout).toContain('dep-a');
        expect(result.stdout).toContain('dep-b');
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });
  });

  describe('staleness flag', () => {
    test('stale flag appears for issues older than 7 days', () => {
      const mockData = {
        issues: [
          { id: 'stale1', title: 'Stale item', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, dependency_count: 0, updated_at: daysAgo(14) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus([], { BD_CMD: mockScript, NO_COLOR: '1' });
        expect(result.status).toBe(0);
        expect(result.stdout).toMatch(/\[stale 14d\]/);
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });

    test('no stale flag for issues less than 7 days old', () => {
      const mockData = {
        issues: [
          { id: 'fresh1', title: 'Fresh item', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, dependency_count: 0, updated_at: daysAgo(3) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus([], { BD_CMD: mockScript, NO_COLOR: '1' });
        expect(result.status).toBe(0);
        expect(result.stdout).not.toMatch(/\[stale/);
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });
  });

  describe('NO_COLOR support', () => {
    test('NO_COLOR disables ANSI escape codes', () => {
      const mockData = {
        issues: [
          { id: 'nc1', title: 'No color test', priority: 'P1', type: 'feature', status: 'in_progress', dependent_count: 0, dependency_count: 0, updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus([], { BD_CMD: mockScript, NO_COLOR: '1' });
        expect(result.status).toBe(0);
        // Should NOT contain any ANSI escape sequences
        // eslint-disable-next-line no-control-regex
        expect(result.stdout).not.toMatch(/\x1b\[/);
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });

    test('colors are present when NO_COLOR is not set', () => {
      const mockData = {
        issues: [
          { id: 'c1', title: 'Color test', priority: 'P1', type: 'feature', status: 'in_progress', dependent_count: 0, dependency_count: 0, updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        // Explicitly unset NO_COLOR
        const env = { BD_CMD: mockScript };
        delete env.NO_COLOR;
        // Also remove from inherited env
        const fullEnv = { ...process.env, BD_CMD: mockScript };
        delete fullEnv.NO_COLOR;
        const result = spawnSync(resolveBashCommand(), [SCRIPT], {
          cwd: PROJECT_ROOT,
          encoding: 'utf-8',
          timeout: 15000,
          env: fullEnv,
        });
        const stdout = (result.stdout || '').trim();
        // Should contain ANSI escape sequences
        // eslint-disable-next-line no-control-regex
        expect(stdout).toMatch(/\x1b\[/);
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });
  });

  describe('session detection', () => {
    /**
     * Helper to create a mock git script that returns canned worktree list output.
     * The script responds to "worktree list --porcelain" with the given porcelain text.
     */
    function createMockGit(porcelainOutput) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-status-git-'));
      const mockScript = path.join(tmpDir, 'git');
      const scriptContent = `#!/usr/bin/env bash
# Mock git: only handles "worktree list --porcelain"
for arg in "$@"; do
  if [ "$arg" = "worktree" ]; then
    cat <<'PORCELAINEOF'
${porcelainOutput}
PORCELAINEOF
    exit 0
  fi
done
# Fallback to real git for other commands
command git "$@"
`;
      fs.writeFileSync(mockScript, scriptContent, { mode: 0o755 });
      return { tmpDir, mockScript };
    }

    test('ACTIVE SESSIONS section appears when multiple worktrees exist', () => {
      const porcelain = [
        'worktree /repo',
        'HEAD abc123',
        'branch refs/heads/master',
        '',
        'worktree /repo/.worktrees/my-feature',
        'HEAD def456',
        'branch refs/heads/feat/my-feature',
        '',
      ].join('\n');
      const mockData = {
        issues: [
          { id: 'forge-abc', title: 'My feature work', priority: 'P2', type: 'feature', status: 'in_progress', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir: gitDir, mockScript: gitScript } = createMockGit(porcelain);
      const { tmpDir: bdDir, mockScript: bdScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus([], { BD_CMD: bdScript, GIT_CMD: gitScript, NO_COLOR: '1' });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('ACTIVE SESSIONS');
      } finally {
        cleanupTmpDir(gitDir);
        cleanupTmpDir(bdDir);
      }
    });

    test('ACTIVE SESSIONS appears before grouped output', () => {
      const porcelain = [
        'worktree /repo',
        'HEAD abc123',
        'branch refs/heads/master',
        '',
        'worktree /repo/.worktrees/workflow-intelligence',
        'HEAD def456',
        'branch refs/heads/feat/workflow-intelligence',
        '',
      ].join('\n');
      const mockData = {
        issues: [
          { id: 'forge-68oj', title: 'Workflow intelligence', priority: 'P1', type: 'feature', status: 'in_progress', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir: gitDir, mockScript: gitScript } = createMockGit(porcelain);
      const { tmpDir: bdDir, mockScript: bdScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus([], { BD_CMD: bdScript, GIT_CMD: gitScript, NO_COLOR: '1' });
        expect(result.status).toBe(0);
        const sessionsIdx = result.stdout.indexOf('ACTIVE SESSIONS');
        const resumeIdx = result.stdout.indexOf('RESUME');
        expect(sessionsIdx).not.toBe(-1);
        expect(resumeIdx).not.toBe(-1);
        expect(sessionsIdx).toBeLessThan(resumeIdx);
      } finally {
        cleanupTmpDir(gitDir);
        cleanupTmpDir(bdDir);
      }
    });

    test('branch-to-issue matching via slug', () => {
      const porcelain = [
        'worktree /repo',
        'HEAD abc123',
        'branch refs/heads/master',
        '',
        'worktree /repo/.worktrees/p2-bug-fixes',
        'HEAD def456',
        'branch refs/heads/feat/p2-bug-fixes',
        '',
      ].join('\n');
      const mockData = {
        issues: [
          { id: 'forge-iv1p', title: 'P2 bug fixes batch 1', priority: 'P2', type: 'bug', status: 'in_progress', dependent_count: 0, updated_at: daysAgo(1) },
          { id: 'forge-cpnj', title: 'P2 bug fixes batch 2', priority: 'P2', type: 'bug', status: 'in_progress', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir: gitDir, mockScript: gitScript } = createMockGit(porcelain);
      const { tmpDir: bdDir, mockScript: bdScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus([], { BD_CMD: bdScript, GIT_CMD: gitScript, NO_COLOR: '1' });
        expect(result.status).toBe(0);
        // Should show the branch with matched issue IDs
        expect(result.stdout).toContain('feat/p2-bug-fixes');
        expect(result.stdout).toContain('forge-iv1p');
        expect(result.stdout).toContain('forge-cpnj');
      } finally {
        cleanupTmpDir(gitDir);
        cleanupTmpDir(bdDir);
      }
    });

    test('no session section when only main worktree exists', () => {
      const porcelain = [
        'worktree /repo',
        'HEAD abc123',
        'branch refs/heads/master',
        '',
      ].join('\n');
      const mockData = {
        issues: [
          { id: 'forge-abc', title: 'Some issue', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir: gitDir, mockScript: gitScript } = createMockGit(porcelain);
      const { tmpDir: bdDir, mockScript: bdScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus([], { BD_CMD: bdScript, GIT_CMD: gitScript, NO_COLOR: '1' });
        expect(result.status).toBe(0);
        expect(result.stdout).not.toContain('ACTIVE SESSIONS');
      } finally {
        cleanupTmpDir(gitDir);
        cleanupTmpDir(bdDir);
      }
    });

    test('orphan branch with no matching issue shows as untracked', () => {
      const porcelain = [
        'worktree /repo',
        'HEAD abc123',
        'branch refs/heads/master',
        '',
        'worktree /repo/.worktrees/orphan-branch',
        'HEAD def456',
        'branch refs/heads/feat/orphan-branch',
        '',
      ].join('\n');
      const mockData = {
        issues: [
          { id: 'forge-xyz', title: 'Unrelated issue', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir: gitDir, mockScript: gitScript } = createMockGit(porcelain);
      const { tmpDir: bdDir, mockScript: bdScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus([], { BD_CMD: bdScript, GIT_CMD: gitScript, NO_COLOR: '1' });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('ACTIVE SESSIONS');
        expect(result.stdout).toContain('feat/orphan-branch');
        expect(result.stdout).toContain('untracked');
      } finally {
        cleanupTmpDir(gitDir);
        cleanupTmpDir(bdDir);
      }
    });

    test('--json mode includes sessions array', () => {
      const porcelain = [
        'worktree /repo',
        'HEAD abc123',
        'branch refs/heads/master',
        '',
        'worktree /repo/.worktrees/my-feature',
        'HEAD def456',
        'branch refs/heads/feat/my-feature',
        '',
      ].join('\n');
      const mockData = {
        issues: [
          { id: 'forge-abc', title: 'My feature work', priority: 'P2', type: 'feature', status: 'in_progress', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir: gitDir, mockScript: gitScript } = createMockGit(porcelain);
      const { tmpDir: bdDir, mockScript: bdScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus(['--json'], { BD_CMD: bdScript, GIT_CMD: gitScript, NO_COLOR: '1' });
        expect(result.status).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed).toHaveProperty('sessions');
        expect(Array.isArray(parsed.sessions)).toBe(true);
        expect(parsed.sessions.length).toBe(1);
        expect(parsed.sessions[0]).toHaveProperty('branch', 'feat/my-feature');
        expect(parsed.sessions[0]).toHaveProperty('path');
        expect(parsed).toHaveProperty('issues');
      } finally {
        cleanupTmpDir(gitDir);
        cleanupTmpDir(bdDir);
      }
    });

    test('multiple worktrees with mixed matching', () => {
      const porcelain = [
        'worktree /repo',
        'HEAD abc123',
        'branch refs/heads/master',
        '',
        'worktree /repo/.worktrees/feature-a',
        'HEAD def456',
        'branch refs/heads/feat/feature-a',
        '',
        'worktree /repo/.worktrees/feature-b',
        'HEAD ghi789',
        'branch refs/heads/feat/feature-b',
        '',
      ].join('\n');
      const mockData = {
        issues: [
          { id: 'forge-fa01', title: 'Feature A task', priority: 'P1', type: 'feature', status: 'in_progress', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir: gitDir, mockScript: gitScript } = createMockGit(porcelain);
      const { tmpDir: bdDir, mockScript: bdScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus([], { BD_CMD: bdScript, GIT_CMD: gitScript, NO_COLOR: '1' });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('ACTIVE SESSIONS');
        // feature-b has no matching issue => untracked
        expect(result.stdout).toContain('feat/feature-b');
        expect(result.stdout).toContain('untracked');
      } finally {
        cleanupTmpDir(gitDir);
        cleanupTmpDir(bdDir);
      }
    });
  });

  describe('file-level conflict detection', () => {
    /**
     * Helper: create a mock git that handles both worktree list (porcelain)
     * and diff (for changed files per branch).
     * @param {string} porcelainOutput - worktree list --porcelain output
     * @param {Object<string, string[]>} branchFiles - map of branch name -> changed files
     */
    function createMockGitWithDiff(porcelainOutput, branchFiles) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-status-conflict-'));
      const mockScript = path.join(tmpDir, 'git');
      // Build case entries for diff
      const diffCases = Object.entries(branchFiles).map(([branch, files]) => {
        if (files.length === 0) return `    "${branch}") echo "" ;;`;
        const fileList = files.join('\\n');
        return `    "${branch}") printf '${fileList}\\n' ;;`;
      }).join('\n');
      const scriptContent = `#!/usr/bin/env bash
if [[ "$1" == "worktree" ]]; then
  cat <<'PORCELAINEOF'
${porcelainOutput}
PORCELAINEOF
  exit 0
elif [[ "$1" == "diff" ]]; then
  # Extract branch: git diff master...<branch> --name-only --
  BRANCH="\${2#master...}"
  case "$BRANCH" in
${diffCases}
    *) echo "" ;;
  esac
  exit 0
elif [[ "$1" == "rev-parse" ]]; then
  echo "master"
  exit 0
fi
command git "$@"
`;
      fs.writeFileSync(mockScript, scriptContent, { mode: 0o755 });
      return { tmpDir, mockScript };
    }

    test('shows Changed: line with files for each active session branch', () => {
      const porcelain = [
        'worktree /repo', 'HEAD abc123', 'branch refs/heads/master', '',
        'worktree /repo/.worktrees/alpha', 'HEAD def456', 'branch refs/heads/feat/alpha', '',
        'worktree /repo/.worktrees/beta', 'HEAD ghi789', 'branch refs/heads/feat/beta', '',
      ].join('\n');
      const branchFiles = {
        'feat/alpha': ['src/a.js', 'src/b.js'],
        'feat/beta': ['src/c.js'],
      };
      const mockBd = createMockBd({
        issues: [
          { id: 'i1', title: 'Alpha work', priority: 'P2', type: 'feature', status: 'in_progress', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      });
      const mockGit = createMockGitWithDiff(porcelain, branchFiles);
      try {
        const result = runSmartStatus([], {
          BD_CMD: mockBd.mockScript, GIT_CMD: mockGit.mockScript, NO_COLOR: '1',
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('ACTIVE SESSIONS');
        expect(result.stdout).toContain('feat/alpha');
        expect(result.stdout).toContain('Changed:');
        expect(result.stdout).toContain('src/a.js');
        expect(result.stdout).toContain('src/b.js');
        expect(result.stdout).toContain('feat/beta');
        expect(result.stdout).toContain('src/c.js');
      } finally {
        cleanupTmpDir(mockBd.tmpDir);
        cleanupTmpDir(mockGit.tmpDir);
      }
    });

    test('truncates to 3 files with +N more', () => {
      const porcelain = [
        'worktree /repo', 'HEAD abc123', 'branch refs/heads/master', '',
        'worktree /repo/.worktrees/big', 'HEAD def456', 'branch refs/heads/feat/big', '',
        'worktree /repo/.worktrees/other', 'HEAD ghi789', 'branch refs/heads/feat/other', '',
      ].join('\n');
      const branchFiles = {
        'feat/big': ['f1.js', 'f2.js', 'f3.js', 'f4.js', 'f5.js'],
        'feat/other': ['x.js'],
      };
      const mockBd = createMockBd({
        issues: [
          { id: 'i1', title: 'Big work', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      });
      const mockGit = createMockGitWithDiff(porcelain, branchFiles);
      try {
        const result = runSmartStatus([], {
          BD_CMD: mockBd.mockScript, GIT_CMD: mockGit.mockScript, NO_COLOR: '1',
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('f1.js');
        expect(result.stdout).toContain('f2.js');
        expect(result.stdout).toContain('f3.js');
        expect(result.stdout).toContain('+2 more');
        expect(result.stdout).not.toContain('f4.js');
        expect(result.stdout).not.toContain('f5.js');
      } finally {
        cleanupTmpDir(mockBd.tmpDir);
        cleanupTmpDir(mockGit.tmpDir);
      }
    });

    test('shows conflict risk when branches share files', () => {
      const porcelain = [
        'worktree /repo', 'HEAD abc123', 'branch refs/heads/master', '',
        'worktree /repo/.worktrees/alpha', 'HEAD def456', 'branch refs/heads/feat/alpha', '',
        'worktree /repo/.worktrees/beta', 'HEAD ghi789', 'branch refs/heads/feat/beta', '',
      ].join('\n');
      const branchFiles = {
        'feat/alpha': ['shared.js', 'alpha-only.js'],
        'feat/beta': ['shared.js', 'beta-only.js'],
      };
      const mockBd = createMockBd({
        issues: [
          { id: 'i1', title: 'Work', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      });
      const mockGit = createMockGitWithDiff(porcelain, branchFiles);
      try {
        const result = runSmartStatus([], {
          BD_CMD: mockBd.mockScript, GIT_CMD: mockGit.mockScript, NO_COLOR: '1',
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toMatch(/[Cc]onflict risk/);
        expect(result.stdout).toContain('shared.js');
      } finally {
        cleanupTmpDir(mockBd.tmpDir);
        cleanupTmpDir(mockGit.tmpDir);
      }
    });

    test('no conflict risk when branches have no overlapping files', () => {
      const porcelain = [
        'worktree /repo', 'HEAD abc123', 'branch refs/heads/master', '',
        'worktree /repo/.worktrees/alpha', 'HEAD def456', 'branch refs/heads/feat/alpha', '',
        'worktree /repo/.worktrees/beta', 'HEAD ghi789', 'branch refs/heads/feat/beta', '',
      ].join('\n');
      const branchFiles = {
        'feat/alpha': ['alpha.js'],
        'feat/beta': ['beta.js'],
      };
      const mockBd = createMockBd({
        issues: [
          { id: 'i1', title: 'Work', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      });
      const mockGit = createMockGitWithDiff(porcelain, branchFiles);
      try {
        const result = runSmartStatus([], {
          BD_CMD: mockBd.mockScript, GIT_CMD: mockGit.mockScript, NO_COLOR: '1',
        });
        expect(result.status).toBe(0);
        expect(result.stdout).not.toMatch(/[Cc]onflict risk/);
      } finally {
        cleanupTmpDir(mockBd.tmpDir);
        cleanupTmpDir(mockGit.tmpDir);
      }
    });

    test('no Changed line for branch with no changed files', () => {
      const porcelain = [
        'worktree /repo', 'HEAD abc123', 'branch refs/heads/master', '',
        'worktree /repo/.worktrees/empty', 'HEAD def456', 'branch refs/heads/feat/empty', '',
        'worktree /repo/.worktrees/full', 'HEAD ghi789', 'branch refs/heads/feat/full', '',
      ].join('\n');
      const branchFiles = {
        'feat/empty': [],
        'feat/full': ['a.js'],
      };
      const mockBd = createMockBd({
        issues: [
          { id: 'i1', title: 'Work', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      });
      const mockGit = createMockGitWithDiff(porcelain, branchFiles);
      try {
        const result = runSmartStatus([], {
          BD_CMD: mockBd.mockScript, GIT_CMD: mockGit.mockScript, NO_COLOR: '1',
        });
        expect(result.status).toBe(0);
        // feat/full should have Changed: line
        expect(result.stdout).toContain('feat/full');
        expect(result.stdout).toContain('a.js');
      } finally {
        cleanupTmpDir(mockBd.tmpDir);
        cleanupTmpDir(mockGit.tmpDir);
      }
    });
  });

  describe('tier-2 merge-tree conflict detection', () => {
    /**
     * Helper: create a mock git that handles worktree, diff, --version, and merge-tree.
     * @param {string} porcelainOutput - worktree list --porcelain output
     * @param {Object<string, string[]>} branchFiles - map of branch name -> changed files
     * @param {string} gitVersion - git version string (e.g. "git version 2.45.0")
     * @param {Object<string, {exitCode: number, output: string}>} mergeTreeResults - map of "branch1 branch2" -> result
     */
    function createMockGitTier2(porcelainOutput, branchFiles, gitVersion, mergeTreeResults) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-status-tier2-'));
      const mockScript = path.join(tmpDir, 'git');
      const diffCases = Object.entries(branchFiles).map(([branch, files]) => {
        if (files.length === 0) return `    "${branch}") echo "" ;;`;
        const fileList = files.join('\\n');
        return `    "${branch}") printf '${fileList}\\n' ;;`;
      }).join('\n');
      // Build merge-tree case entries
      const mergeCases = Object.entries(mergeTreeResults || {}).map(([pair, result]) => {
        // pair is "branch1 branch2", we match on $2 and $3
        const [b1, b2] = pair.split(' ');
        return `    if [ "$MTBRANCH1" = "${b1}" ] && [ "$MTBRANCH2" = "${b2}" ]; then
      printf '%s\\n' '${result.output || ''}'
      exit ${result.exitCode}
    fi`;
      }).join('\n');
      const scriptContent = `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo "${gitVersion}"
  exit 0
elif [ "$1" = "worktree" ]; then
  cat <<'PORCELAINEOF'
${porcelainOutput}
PORCELAINEOF
  exit 0
elif [ "$1" = "diff" ]; then
  BRANCH="\${2#master...}"
  case "$BRANCH" in
${diffCases}
    *) echo "" ;;
  esac
  exit 0
elif [ "$1" = "merge-tree" ]; then
  # Extract the two branch args (after flags)
  shift  # remove "merge-tree"
  MTBRANCH1=""
  MTBRANCH2=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --*) shift ;;
      *)
        if [ -z "$MTBRANCH1" ]; then
          MTBRANCH1="$1"
        else
          MTBRANCH2="$1"
        fi
        shift
        ;;
    esac
  done
${mergeCases}
  exit 0
fi
command git "$@"
`;
      fs.writeFileSync(mockScript, scriptContent, { mode: 0o755 });
      return { tmpDir, mockScript };
    }

    const twoBranchPorcelain = [
      'worktree /repo', 'HEAD abc123', 'branch refs/heads/master', '',
      'worktree /repo/.worktrees/alpha', 'HEAD def456', 'branch refs/heads/feat/alpha', '',
      'worktree /repo/.worktrees/beta', 'HEAD ghi789', 'branch refs/heads/feat/beta', '',
    ].join('\n');

    test('shows !! Merge conflict for real conflicts (exit 1)', () => {
      const branchFiles = {
        'feat/alpha': ['shared.js', 'alpha-only.js'],
        'feat/beta': ['shared.js', 'beta-only.js'],
      };
      const mergeTreeResults = {
        'feat/alpha feat/beta': { exitCode: 1, output: 'shared.js' },
      };
      const mockBd = createMockBd({
        issues: [
          { id: 'i1', title: 'Work', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      });
      const mockGit = createMockGitTier2(twoBranchPorcelain, branchFiles, 'git version 2.45.0', mergeTreeResults);
      try {
        const result = runSmartStatus([], {
          BD_CMD: mockBd.mockScript, GIT_CMD: mockGit.mockScript, NO_COLOR: '1',
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('!! Merge conflict');
        expect(result.stdout).toContain('shared.js');
      } finally {
        cleanupTmpDir(mockBd.tmpDir);
        cleanupTmpDir(mockGit.tmpDir);
      }
    });

    test('keeps ! Conflict risk for file-overlap-only (exit 0, no real conflict)', () => {
      const branchFiles = {
        'feat/alpha': ['shared.js', 'alpha-only.js'],
        'feat/beta': ['shared.js', 'beta-only.js'],
      };
      const mergeTreeResults = {
        'feat/alpha feat/beta': { exitCode: 0, output: '' },
      };
      const mockBd = createMockBd({
        issues: [
          { id: 'i1', title: 'Work', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      });
      const mockGit = createMockGitTier2(twoBranchPorcelain, branchFiles, 'git version 2.45.0', mergeTreeResults);
      try {
        const result = runSmartStatus([], {
          BD_CMD: mockBd.mockScript, GIT_CMD: mockGit.mockScript, NO_COLOR: '1',
        });
        expect(result.status).toBe(0);
        // Should still show Conflict risk (Tier 1) but NOT Merge conflict
        expect(result.stdout).toMatch(/! Conflict risk/);
        expect(result.stdout).not.toContain('!! Merge conflict');
      } finally {
        cleanupTmpDir(mockBd.tmpDir);
        cleanupTmpDir(mockGit.tmpDir);
      }
    });

    test('skips Tier 2 silently when git version < 2.38', () => {
      const branchFiles = {
        'feat/alpha': ['shared.js'],
        'feat/beta': ['shared.js'],
      };
      const mockBd = createMockBd({
        issues: [
          { id: 'i1', title: 'Work', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      });
      // Old git version — no merge-tree results needed since it should be skipped
      const mockGit = createMockGitTier2(twoBranchPorcelain, branchFiles, 'git version 2.37.1', {});
      try {
        const result = runSmartStatus([], {
          BD_CMD: mockBd.mockScript, GIT_CMD: mockGit.mockScript, NO_COLOR: '1',
        });
        expect(result.status).toBe(0);
        // Should show Tier 1 conflict risk (file overlap exists)
        expect(result.stdout).toMatch(/! Conflict risk/);
        // Should NOT show Tier 2 merge conflict (skipped due to old git)
        expect(result.stdout).not.toContain('!! Merge conflict');
      } finally {
        cleanupTmpDir(mockBd.tmpDir);
        cleanupTmpDir(mockGit.tmpDir);
      }
    });

    test('JSON output includes merge_conflicts field for real conflicts', () => {
      const branchFiles = {
        'feat/alpha': ['shared.js'],
        'feat/beta': ['shared.js'],
      };
      const mergeTreeResults = {
        'feat/alpha feat/beta': { exitCode: 1, output: 'shared.js' },
      };
      const mockBd = createMockBd({
        issues: [
          { id: 'i1', title: 'Work', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      });
      const mockGit = createMockGitTier2(twoBranchPorcelain, branchFiles, 'git version 2.45.0', mergeTreeResults);
      try {
        const result = runSmartStatus(['--json'], {
          BD_CMD: mockBd.mockScript, GIT_CMD: mockGit.mockScript, NO_COLOR: '1',
        });
        expect(result.status).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed).toHaveProperty('sessions');
        // At least one session should have merge_conflicts
        const allConflicts = parsed.sessions.flatMap(s => s.merge_conflicts || []);
        expect(allConflicts.length).toBeGreaterThan(0);
        expect(allConflicts[0]).toHaveProperty('branch');
        expect(allConflicts[0]).toHaveProperty('files');
        expect(allConflicts[0].files).toContain('shared.js');
      } finally {
        cleanupTmpDir(mockBd.tmpDir);
        cleanupTmpDir(mockGit.tmpDir);
      }
    });

    test('no merge_conflicts when git >= 2.38 but no real conflicts', () => {
      const branchFiles = {
        'feat/alpha': ['shared.js'],
        'feat/beta': ['shared.js'],
      };
      const mergeTreeResults = {
        'feat/alpha feat/beta': { exitCode: 0, output: '' },
      };
      const mockBd = createMockBd({
        issues: [
          { id: 'i1', title: 'Work', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      });
      const mockGit = createMockGitTier2(twoBranchPorcelain, branchFiles, 'git version 2.45.0', mergeTreeResults);
      try {
        const result = runSmartStatus(['--json'], {
          BD_CMD: mockBd.mockScript, GIT_CMD: mockGit.mockScript, NO_COLOR: '1',
        });
        expect(result.status).toBe(0);
        const parsed = JSON.parse(result.stdout);
        const allConflicts = parsed.sessions.flatMap(s => s.merge_conflicts || []);
        expect(allConflicts.length).toBe(0);
      } finally {
        cleanupTmpDir(mockBd.tmpDir);
        cleanupTmpDir(mockGit.tmpDir);
      }
    });
  });

  describe('epic_proximity', () => {
    test('epic proximity boosts issues near completion', () => {
      const mockData = {
        issues: [
          // Epic with 4/5 children closed => proximity = 1.0 + (4/5)*0.5 = 1.4
          { id: 'epic1', title: 'Epic 1', priority: 'P2', type: 'epic', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
          // Regular child of epic1
          { id: 'child1', title: 'Child 1', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1), parent_id: 'epic1' },
        ],
        epicChildren: [
          {
            id: 'epic1',
            children: [
              { id: 'c1', status: 'closed' },
              { id: 'c2', status: 'closed' },
              { id: 'c3', status: 'closed' },
              { id: 'c4', status: 'closed' },
              { id: 'child1', status: 'open' },
            ],
          },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus(['--json'], { BD_CMD: mockScript });
        expect(result.status).toBe(0);
        const scored = JSON.parse(result.stdout);
        // Find child1 in results
        const child = scored.find(s => s.id === 'child1');
        expect(child).toBeDefined();
        expect(child.epic_proximity).toBeCloseTo(1.4, 1);
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });
  });
});
