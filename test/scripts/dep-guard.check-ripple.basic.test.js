const fs = require('node:fs');
const { describe, test, expect, afterAll, setDefaultTimeout } = require('bun:test');

const { createMockBd, runDepGuard } = require('./dep-guard.helpers');

setDefaultTimeout(20000);

describe('scripts/dep-guard.sh > check-ripple', () => {
  const mockFiles = [];

  afterAll(() => {
    for (const file of mockFiles) {
      try { fs.unlinkSync(file); } catch (_error) {}
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
        echo "â— forge-abc [â— P2] [feature] - Pre-change dependency guard for plan workflow"
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
        echo "â— forge-src [â— P2] [feature] - Pre-change dependency guard for plan workflow"
        echo "â—Œ forge-other [â— P2] [feature] - Logic-level dependency detection in plan Phase 3"
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
        echo "â— forge-src [â— P2] [feature] - Pre-change dependency guard for plan workflow"
        echo "â—Œ forge-other [â— P1] [feature] - Logic-level dependency detection in plan Phase 3"
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
        echo "â—Œ forge-aaa [â— P2] [feature] - Add the widget to sidebar"
        echo "â—Œ forge-bbb [â— P2] [feature] - Fix the button in footer"
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
});
