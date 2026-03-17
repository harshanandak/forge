const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { describe, test, expect, beforeAll, afterAll } = require('bun:test');

/**
 * Tests for scripts/dep-guard.sh
 *
 * The script provides dependency-guard subcommands:
 *   find-consumers, check-ripple, store-contracts, extract-contracts
 *
 * Task 1 tests the scaffold: existence, usage, unknown subcommand,
 * and stub behavior for each subcommand with no args.
 * Task 3 tests check-ripple with mock bd via BD_CMD env var.
 */

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'dep-guard.sh');
const PROJECT_ROOT = path.join(__dirname, '..', '..');

/**
 * Run the dep-guard script with given arguments.
 * @param {string[]} args - CLI arguments
 * @param {object} env - Additional environment variables
 * @returns {{ status: number|null, stdout: string, stderr: string }}
 */
function runDepGuard(args = [], env = {}) {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    timeout: 15000,
    env: {
      ...process.env,
      ...env,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error,
  };
}

/**
 * Create a temporary mock bd script that simulates Beads CLI responses.
 * @param {string} scriptContent - Bash script body for the mock
 * @returns {string} Absolute path to the mock script
 */
function createMockBd(scriptContent) {
  const tmpDir = os.tmpdir();
  const mockPath = path.join(tmpDir, `mock-bd-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`);
  fs.writeFileSync(mockPath, `#!/usr/bin/env bash\n${scriptContent}\n`, { mode: 0o755 });
  // Ensure executable on all platforms
  spawnSync('chmod', ['+x', mockPath]);
  return mockPath;
}

describe('scripts/dep-guard.sh', () => {
  describe('file structure', () => {
    test('script exists at scripts/dep-guard.sh', () => {
      expect(fs.existsSync(SCRIPT)).toBe(true);
    });
  });

  describe('usage and unknown subcommand', () => {
    test('no args prints usage containing "Usage:" and exits 1', () => {
      const result = runDepGuard([]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Usage:');
    });

    test('unknown subcommand prints error and exits 1', () => {
      const result = runDepGuard(['bogus-command']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Error: Unknown subcommand');
    });
  });

  describe('stub subcommands exit 1 with no args', () => {
    test('find-consumers with no args exits 1', () => {
      const result = runDepGuard(['find-consumers']);
      expect(result.status).toBe(1);
    });

    test('check-ripple with no args exits 1', () => {
      const result = runDepGuard(['check-ripple']);
      expect(result.status).toBe(1);
    });

    test('store-contracts with no args exits 1', () => {
      const result = runDepGuard(['store-contracts']);
      expect(result.status).toBe(1);
    });

    test('extract-contracts with no args exits 1', () => {
      const result = runDepGuard(['extract-contracts']);
      expect(result.status).toBe(1);
    });
  });

  describe('find-consumers', () => {
    test('known function found: sanitize appears in beads-context.sh', () => {
      const result = runDepGuard(['find-consumers', 'sanitize']);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('scripts/beads-context.sh');
    });

    test('nonexistent name prints "No consumers found" and exits 0', () => {
      const result = runDepGuard(['find-consumers', 'zzz_nonexistent_xyz_12345']);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('No consumers found');
    });

    test('empty input (no args) exits 1', () => {
      const result = runDepGuard(['find-consumers']);
      expect(result.status).toBe(1);
    });

    test('self-exclusion: output does not contain dep-guard.sh', () => {
      const result = runDepGuard(['find-consumers', 'dep-guard']);
      expect(result.stdout).not.toContain('scripts/dep-guard.sh');
    });
  });

  describe('check-ripple', () => {
    /** @type {string[]} */
    const mockFiles = [];

    afterAll(() => {
      // Clean up all mock files created during these tests
      for (const f of mockFiles) {
        try { fs.unlinkSync(f); } catch (_e) { /* ignore */ }
      }
    });

    test('no args exits 1 with usage', () => {
      const result = runDepGuard(['check-ripple']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Usage:');
    });

    test('invalid issue exits 1 with error', () => {
      // Mock bd that fails on "show" for non-existent issue
      const mock = createMockBd(`
        if [[ "\$1" == "show" ]]; then
          echo "Error resolving issue: forge-nonexistent" >&2
          exit 1
        fi
        echo ""
      `);
      mockFiles.push(mock);

      const result = runDepGuard(['check-ripple', 'forge-nonexistent'], { BD_CMD: mock });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/not found|Failed|Error/i);
    });

    test('no conflicts when source is the only active issue', () => {
      // Mock bd: show returns JSON for the source, list returns only the source
      const mock = createMockBd(`
        if [[ "\$1" == "show" && "\$2" == "forge-abc" ]]; then
          cat <<'ENDJSON'
[{"id":"forge-abc","title":"Pre-change dependency guard for plan workflow","description":"Guard against dep conflicts","status":"in_progress","priority":2}]
ENDJSON
          exit 0
        fi
        if [[ "\$1" == "list" ]]; then
          echo "◐ forge-abc [● P2] [feature] - Pre-change dependency guard for plan workflow"
          exit 0
        fi
        echo "Unknown command: \$*" >&2
        exit 1
      `);
      mockFiles.push(mock);

      const result = runDepGuard(['check-ripple', 'forge-abc'], { BD_CMD: mock });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('No conflicts detected');
      expect(result.stdout).toContain('forge-abc');
    });

    test('keyword overlap found between source and another issue', () => {
      // Mock bd: two issues with overlapping keywords "dependency" and "plan"
      const mock = createMockBd(`
        if [[ "\$1" == "show" && "\$2" == "forge-src" ]]; then
          cat <<'ENDJSON'
[{"id":"forge-src","title":"Pre-change dependency guard for plan workflow","description":"Guard dep conflicts in plan","status":"in_progress","priority":2}]
ENDJSON
          exit 0
        fi
        if [[ "\$1" == "list" ]]; then
          echo "◐ forge-src [● P2] [feature] - Pre-change dependency guard for plan workflow"
          echo "○ forge-other [● P2] [feature] - Logic-level dependency detection in plan Phase 3"
          exit 0
        fi
        echo "Unknown command: \$*" >&2
        exit 1
      `);
      mockFiles.push(mock);

      const result = runDepGuard(['check-ripple', 'forge-src'], { BD_CMD: mock });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Potential overlap');
      expect(result.stdout).toContain('forge-other');
      expect(result.stdout).toContain('dependency');
      expect(result.stdout).toContain('Confidence: LOW');
    });

    test('overlap report includes actionable options', () => {
      // Reuse the overlapping mock from previous test
      const mock = createMockBd(`
        if [[ "\$1" == "show" && "\$2" == "forge-src" ]]; then
          cat <<'ENDJSON'
[{"id":"forge-src","title":"Pre-change dependency guard for plan workflow","description":"Guard dep","status":"in_progress","priority":2}]
ENDJSON
          exit 0
        fi
        if [[ "\$1" == "list" ]]; then
          echo "◐ forge-src [● P2] [feature] - Pre-change dependency guard for plan workflow"
          echo "○ forge-other [● P1] [feature] - Logic-level dependency detection in plan Phase 3"
          exit 0
        fi
        echo "Unknown command: \$*" >&2
        exit 1
      `);
      mockFiles.push(mock);

      const result = runDepGuard(['check-ripple', 'forge-src'], { BD_CMD: mock });
      expect(result.status).toBe(0);
      // Should contain the options section
      expect(result.stdout).toContain('bd dep add forge-src forge-other');
      expect(result.stdout).toContain('bd show forge-other');
    });

    test('no overlap when terms are too short or all stop words', () => {
      // Issues share only stop words / short terms: "add", "the", "is", "to"
      const mock = createMockBd(`
        if [[ "\$1" == "show" && "\$2" == "forge-aaa" ]]; then
          cat <<'ENDJSON'
[{"id":"forge-aaa","title":"Add the widget to sidebar","description":"","status":"open","priority":2}]
ENDJSON
          exit 0
        fi
        if [[ "\$1" == "list" ]]; then
          echo "○ forge-aaa [● P2] [feature] - Add the widget to sidebar"
          echo "○ forge-bbb [● P2] [feature] - Fix the button in footer"
          exit 0
        fi
        echo "Unknown command: \$*" >&2
        exit 1
      `);
      mockFiles.push(mock);

      const result = runDepGuard(['check-ripple', 'forge-aaa'], { BD_CMD: mock });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('No conflicts detected');
    });
  });
});
