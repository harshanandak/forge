const fs = require('node:fs');
const path = require('node:path');
const { describe, test, expect, afterAll } = require('bun:test');
const { createMockBd, createTempRepo, runDepGuard } = require('./dep-guard.helpers');

describe('scripts/dep-guard.sh > check-ripple', () => {
  const mockFiles = [];
  const tempDirs = [];

  afterAll(() => {
    for (const file of mockFiles) {
      try { fs.unlinkSync(file); } catch (_error) {}
    }
    for (const dir of tempDirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_error) {}
    }
  });

  test('no args exits 1 with usage', () => {
    const result = runDepGuard(['check-ripple']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage:');
  });

  test('invalid issue exits 1 with error', () => {
    const mock = createMockBd(`
      if [[ "$1" == "show" ]]; then
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

  test('warns and skips when title extraction fails', () => {
    const mock = createMockBd(`
      if [[ "$1" == "show" ]]; then
        echo '{"id":"forge-xyz","status":"open"}'
        exit 0
      fi
      echo ""
    `);
    mockFiles.push(mock);

    const result = runDepGuard(['check-ripple', 'forge-xyz'], { BD_CMD: mock });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('could not extract title');
  });

  test('warns and skips when bd list returns empty', () => {
    const mock = createMockBd(`
      if [[ "$1" == "show" ]]; then
        echo '{"id":"forge-xyz","title":"Pre-change dep guard","status":"open"}'
        exit 0
      fi
      exit 0
    `);
    mockFiles.push(mock);

    const result = runDepGuard(['check-ripple', 'forge-xyz'], { BD_CMD: mock });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('could not fetch active issue list');
  });

  test('no conflicts when source is the only active issue', () => {
    const mock = createMockBd(`
      if [[ "$1" == "show" && "$2" == "forge-abc" ]]; then
        cat <<'ENDJSON'
[{"id":"forge-abc","title":"Pre-change dependency guard for plan workflow","description":"Guard against dep conflicts","status":"in_progress","priority":2}]
ENDJSON
        exit 0
      fi
      if [[ "$1" == "list" ]]; then
        echo "◐ forge-abc [● P2] [feature] - Pre-change dependency guard for plan workflow"
        exit 0
      fi
      echo "Unknown command: $*" >&2
      exit 1
    `);
    mockFiles.push(mock);

    const result = runDepGuard(['check-ripple', 'forge-abc'], { BD_CMD: mock });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No conflicts detected');
    expect(result.stdout).toContain('forge-abc');
  });

  test('keyword overlap found between source and another issue', () => {
    const mock = createMockBd(`
      if [[ "$1" == "show" && "$2" == "forge-src" ]]; then
        cat <<'ENDJSON'
[{"id":"forge-src","title":"Pre-change dependency guard for plan workflow","description":"Guard dep conflicts in plan","status":"in_progress","priority":2}]
ENDJSON
        exit 0
      fi
      if [[ "$1" == "list" ]]; then
        echo "◐ forge-src [● P2] [feature] - Pre-change dependency guard for plan workflow"
        echo "◌ forge-other [● P2] [feature] - Logic-level dependency detection in plan Phase 3"
        exit 0
      fi
      echo "Unknown command: $*" >&2
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
    const mock = createMockBd(`
      if [[ "$1" == "show" && "$2" == "forge-src" ]]; then
        cat <<'ENDJSON'
[{"id":"forge-src","title":"Pre-change dependency guard for plan workflow","description":"Guard dep","status":"in_progress","priority":2}]
ENDJSON
        exit 0
      fi
      if [[ "$1" == "list" ]]; then
        echo "◐ forge-src [● P2] [feature] - Pre-change dependency guard for plan workflow"
        echo "◌ forge-other [● P1] [feature] - Logic-level dependency detection in plan Phase 3"
        exit 0
      fi
      echo "Unknown command: $*" >&2
      exit 1
    `);
    mockFiles.push(mock);

    const result = runDepGuard(['check-ripple', 'forge-src'], { BD_CMD: mock });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('bd dep add forge-src forge-other');
    expect(result.stdout).toContain('bd show forge-other');
  });

  test('no overlap when terms are too short or all stop words', () => {
    const mock = createMockBd(`
      if [[ "$1" == "show" && "$2" == "forge-aaa" ]]; then
        cat <<'ENDJSON'
[{"id":"forge-aaa","title":"Add the widget to sidebar","description":"","status":"open","priority":2}]
ENDJSON
        exit 0
      fi
      if [[ "$1" == "list" ]]; then
        echo "◌ forge-aaa [● P2] [feature] - Add the widget to sidebar"
        echo "◌ forge-bbb [● P2] [feature] - Fix the button in footer"
        exit 0
      fi
      echo "Unknown command: $*" >&2
      exit 1
    `);
    mockFiles.push(mock);

    const result = runDepGuard(['check-ripple', 'forge-aaa'], { BD_CMD: mock });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No conflicts detected');
  });

  test('prints structured analyzer output from Beads JSON and task-file context', () => {
    const repositoryRoot = createTempRepo({
      'lib/progress.js': `function parseProgress(raw) {
  return raw.trim().toUpperCase();
}

module.exports = {
  parseProgress,
};
`,
      'features/dashboard.js': `const { parseProgress } = require('../lib/progress');

function renderDashboard(raw) {
  return parseProgress(raw);
}

module.exports = {
  renderDashboard,
};
`,
      'tasks.md': `# Task List: logic-level-dependency-detection

## Task 1: Tighten review policy

File(s): \`lib/progress.js\`, \`docs/workflow.md\`

What to implement: Update parseProgress() and tighten approval rules, confidence threshold handling, and manual review behavior for planning decisions.

Expected output: behavior detection finds downstream consumers.
`,
    });
    tempDirs.push(repositoryRoot);
    const taskFile = path.join(repositoryRoot, 'tasks.md').replace(/\\/g, '/');
    const mock = createMockBd(`
      if [[ "$1" == "show" && "$2" == "forge-src" && "$3" == "--json" ]]; then
        cat <<'ENDJSON'
{"id":"forge-src","title":"Logic-level dependency detection in /plan Phase 3","description":"Plan-time dependency review","status":"open","design":"8 tasks | ${taskFile}"}
ENDJSON
        exit 0
      fi
      if [[ "$1" == "list" && "$2" == "--status=open" && "$3" == "--json" ]]; then
        cat <<'ENDJSON'
[{"id":"forge-other","title":"Multi-developer workflow review policy","description":"Manual review rules and confidence threshold handling for coordinated work.","status":"open","files":["features/dashboard.js"]}]
ENDJSON
        exit 0
      fi
      if [[ "$1" == "list" && "$2" == "--status=in_progress" && "$3" == "--json" ]]; then
        echo "[]"
        exit 0
      fi
      echo "Unknown command: $*" >&2
      exit 1
    `);
    mockFiles.push(mock);

    const result = runDepGuard(['check-ripple', 'forge-src'], {
      BD_CMD: mock,
      DEP_GUARD_REPOSITORY_ROOT: repositoryRoot,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Structured dependency review');
    expect(result.stdout).toContain('Issue pair: forge-src -> forge-other');
    expect(result.stdout).toContain('Rubric score:');
    expect(result.stdout).toContain('Confidence:');
    expect(result.stdout).toContain('Detector categories:');
    expect(result.stdout).toContain('Proposed dependency updates:');
    expect(result.stdout).toContain('forge-other depends on forge-src');
    expect(result.stdout).toContain('Pros:');
    expect(result.stdout).toContain('Cons:');
  });

  test('falls back to keyword-only report when the analyzer cannot run', () => {
    const repositoryRoot = createTempRepo({
      'tasks.md': `# Task List

## Task 1: Dependency plan workflow

File(s): \`docs/workflow.md\`

What to implement: Update dependency plan workflow review rules.
`,
    });
    tempDirs.push(repositoryRoot);
    const taskFile = path.join(repositoryRoot, 'tasks.md').replace(/\\/g, '/');
    const mock = createMockBd(`
      if [[ "$1" == "show" && "$2" == "forge-src" && "$3" == "--json" ]]; then
        cat <<'ENDJSON'
{"id":"forge-src","title":"Pre-change dependency guard for plan workflow","description":"Guard dependency conflicts in plan workflow","status":"open","design":"1 tasks | ${taskFile}"}
ENDJSON
        exit 0
      fi
      if [[ "$1" == "list" && "$2" == "--status=open" && "$3" == "--json" ]]; then
        cat <<'ENDJSON'
[{"id":"forge-other","title":"Logic-level dependency detection in plan Phase 3","description":"Dependency review in plan workflow","status":"open","files":["features/dashboard.js"]}]
ENDJSON
        exit 0
      fi
      if [[ "$1" == "list" && "$2" == "--status=in_progress" && "$3" == "--json" ]]; then
        echo "[]"
        exit 0
      fi
      if [[ "$1" == "list" && "$2" == "--status=open" ]]; then
        echo "◌ forge-src [● P2] [feature] - Pre-change dependency guard for plan workflow"
        echo "◌ forge-other [● P2] [feature] - Logic-level dependency detection in plan Phase 3"
        exit 0
      fi
      if [[ "$1" == "list" && "$2" == "--status=in_progress" ]]; then
        exit 0
      fi
      echo "Unknown command: $*" >&2
      exit 1
    `);
    mockFiles.push(mock);

    const result = runDepGuard(['check-ripple', 'forge-src'], {
      BD_CMD: mock,
      DEP_GUARD_REPOSITORY_ROOT: repositoryRoot,
      DEP_GUARD_ANALYZE_SCRIPT: path.join(repositoryRoot, 'missing-analyzer.js'),
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('falling back to keyword-only ripple check');
    expect(result.stdout).toContain('Potential overlap');
    expect(result.stdout).toContain('Confidence: LOW');
    expect(result.stdout).toContain('bd dep add forge-src forge-other');
  });
});
