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
    test('known function found: sanitize appears in at least one script', () => {
      const result = runDepGuard(['find-consumers', 'sanitize']);
      expect(result.status).toBe(0);
      // sanitize() is defined in dep-guard.sh (excluded) and beads-context.sh
      // Assert we find at least one match in the scripts/ directory
      expect(result.stdout).toMatch(/scripts\/.*\.sh/);
      expect(result.stdout).not.toContain('No consumers found');
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

    test('self-exclusion: dep-guard.sh is not a matched file', () => {
      const result = runDepGuard(['find-consumers', 'dep-guard']);
      // The script excludes itself from grep results. Verify no line has
      // dep-guard.sh as the *file path* (before the first colon). Other files
      // may legitimately reference dep-guard.sh in their content.
      const lines = result.stdout.split('\n').filter(Boolean);
      for (const line of lines) {
        const filePath = line.split(':')[0];
        expect(filePath).not.toContain('dep-guard.sh');
      }
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

  describe('extract-contracts', () => {
    const tmpDir = path.join(os.tmpdir(), `dep-guard-extract-${Date.now()}-${Math.random().toString(36).slice(2)}`);

    beforeAll(() => {
      fs.mkdirSync(tmpDir, { recursive: true });
    });

    afterAll(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('nonexistent file exits 1', () => {
      const result = runDepGuard(['extract-contracts', '/tmp/nonexistent-file-xyz-99999.md']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('does not exist');
    });

    test('file with no tasks exits 1', () => {
      const noTaskFile = path.join(tmpDir, 'no-tasks.md');
      fs.writeFileSync(noTaskFile, '# Just a header\n\nSome random content without task blocks.\n');
      const result = runDepGuard(['extract-contracts', noTaskFile]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('No tasks found');
    });

    test('extracts function names from task file', () => {
      const taskFile = path.join(tmpDir, 'tasks.md');
      fs.writeFileSync(taskFile, [
        '# Task List',
        '',
        '## Task 1: Create scaffold',
        '',
        'File(s): `scripts/dep-guard.sh`',
        '',
        'What to implement: Create `usage()` function and `die()` helper. Also add `sanitize()` for input cleaning.',
        '',
        '## Task 2: Add consumers',
        '',
        'File(s): `lib/commands/plan.js`',
        '',
        'What to implement: Add `findConsumers()` method that calls `parseTokens()` internally.',
        '',
      ].join('\n'));

      const result = runDepGuard(['extract-contracts', taskFile]);
      expect(result.status).toBe(0);
      const lines = result.stdout.trim().split('\n').map(l => l.trim()).filter(Boolean);
      expect(lines).toContain('scripts/dep-guard.sh:usage(modified)');
      expect(lines).toContain('scripts/dep-guard.sh:die(modified)');
      expect(lines).toContain('scripts/dep-guard.sh:sanitize(modified)');
      expect(lines).toContain('lib/commands/plan.js:findConsumers(modified)');
      expect(lines).toContain('lib/commands/plan.js:parseTokens(modified)');
    });

    test('deduplication: same function in multiple tasks for same file appears once', () => {
      const dedupFile = path.join(tmpDir, 'dedup.md');
      fs.writeFileSync(dedupFile, [
        '# Tasks',
        '',
        '## Task 1: First pass',
        '',
        'File(s): `lib/utils.js`',
        '',
        'What to implement: Create `helper()` and `transform()` utilities.',
        '',
        '## Task 2: Second pass',
        '',
        'File(s): `lib/utils.js`',
        '',
        'What to implement: Refactor `helper()` to support async.',
        '',
      ].join('\n'));

      const result = runDepGuard(['extract-contracts', dedupFile]);
      expect(result.status).toBe(0);
      const lines = result.stdout.trim().split('\n').map(l => l.trim()).filter(Boolean);
      // helper should appear only once despite being in two tasks
      const helperLines = lines.filter(l => l === 'lib/utils.js:helper(modified)');
      expect(helperLines).toHaveLength(1);
      // transform should also be present
      expect(lines).toContain('lib/utils.js:transform(modified)');
    });
  });

  describe('store-contracts', () => {
    /** @type {string[]} */
    const mockFiles = [];

    afterAll(() => {
      for (const f of mockFiles) {
        try { fs.unlinkSync(f); } catch (_e) { /* ignore */ }
      }
    });

    test('empty contracts string exits 1', () => {
      const result = runDepGuard(['store-contracts', 'some-id', '']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('empty');
    });

    test('missing args exits 1', () => {
      const result = runDepGuard(['store-contracts', 'only-one-arg']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Usage:');
    });

    test('successful storage prints confirmation', () => {
      const mock = createMockBd(`
        if [[ "\$1" == "show" && "\$2" == "test-1" ]]; then
          echo '{"id":"test-1","title":"Test issue","status":"open"}'
          exit 0
        fi
        if [[ "\$1" == "update" ]]; then
          echo "Updated issue: test-1"
          exit 0
        fi
        echo "Unknown command: \$*" >&2
        exit 1
      `);
      mockFiles.push(mock);

      const result = runDepGuard(
        ['store-contracts', 'test-1', 'lib/foo.js:bar(modified)'],
        { BD_CMD: mock },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Contracts stored on test-1');
    });

    test('invalid issue exits 1', () => {
      const mock = createMockBd(`
        if [[ "\$1" == "show" ]]; then
          echo "Error resolving issue: bad-id" >&2
          exit 1
        fi
        echo ""
      `);
      mockFiles.push(mock);

      const result = runDepGuard(
        ['store-contracts', 'bad-id', 'lib/foo.js:bar(modified)'],
        { BD_CMD: mock },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/not found|Failed|Error/i);
    });
  });
});

describe('plan.md integration', () => {
  const planMdPath = path.join(__dirname, '..', '..', '.claude', 'commands', 'plan.md');

  test('Phase 1 includes dep-guard ripple check step', () => {
    const content = fs.readFileSync(planMdPath, 'utf-8');
    expect(content).toContain('dep-guard.sh check-ripple');
    expect(content).toContain('Dependency ripple check');
    // Must appear before "Step 1: Explore project context"
    const rippleIdx = content.indexOf('Dependency ripple check');
    const step1Idx = content.indexOf('Step 1: Explore project context');
    expect(rippleIdx).toBeLessThan(step1Idx);
    expect(rippleIdx).toBeGreaterThan(0);
  });

  test('Phase 3 includes contract extraction and storage steps', () => {
    const content = fs.readFileSync(planMdPath, 'utf-8');
    expect(content).toContain('dep-guard.sh extract-contracts');
    expect(content).toContain('dep-guard.sh store-contracts');
    // Must appear after "Step 5b: Beads context"
    const step5bIdx = content.indexOf('Step 5b: Beads context');
    const step5cIdx = content.indexOf('Step 5c: Contract extraction');
    expect(step5cIdx).toBeGreaterThan(step5bIdx);
  });

  test('Phase 3 HARD-GATE includes dep-guard store-contracts check', () => {
    const content = fs.readFileSync(planMdPath, 'utf-8');
    // The HARD-GATE exit section should mention dep-guard
    const hardGateIdx = content.indexOf('HARD-GATE: /plan exit');
    const afterHardGate = content.substring(hardGateIdx);
    expect(afterHardGate).toContain('dep-guard');
  });

  test('plan.md contains Ripple Analyst agent prompt section', () => {
    const content = fs.readFileSync(planMdPath, 'utf-8');
    expect(content).toContain('Ripple Analyst');
    expect(content).toContain('break scenarios');
    expect(content).toContain('NONE');
    expect(content).toContain('CRITICAL');
    expect(content).toContain('default to HIGH');
    expect(content).toContain('Recommendation');
  });
});
