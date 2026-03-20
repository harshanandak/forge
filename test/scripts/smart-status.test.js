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
