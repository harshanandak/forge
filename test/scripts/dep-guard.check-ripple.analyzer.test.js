const fs = require('node:fs');
const path = require('node:path');
const { describe, test, expect, afterAll, setDefaultTimeout } = require('bun:test');

const { createMockBd, createTempRepo, runDepGuard } = require('./dep-guard.helpers');

setDefaultTimeout(20000);

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
        echo "â—Œ forge-src [â— P2] [feature] - Pre-change dependency guard for plan workflow"
        echo "â—Œ forge-other [â— P2] [feature] - Logic-level dependency detection in plan Phase 3"
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
