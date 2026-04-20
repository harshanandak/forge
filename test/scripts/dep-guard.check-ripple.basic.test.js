const fs = require('node:fs');
const { describe, test, expect, afterAll, beforeAll, setDefaultTimeout } = require('bun:test');

const { createMockBd, runDepGuard } = require('./dep-guard.helpers');

setDefaultTimeout(20000);

describe('scripts/dep-guard.sh > check-ripple', () => {
  const mockFiles = [];
  let scenarios;

  beforeAll(() => {
    scenarios = {
      invalidIssue: createMockBd(`
        if [[ "$1" == "show" ]]; then
          echo "Error resolving issue: forge-nonexistent" >&2
          exit 1
        fi
        echo ""
      `),
      missingTitle: createMockBd(`
        if [[ "$1" == "show" ]]; then
          echo '{"id":"forge-xyz","status":"open"}'
          exit 0
        fi
        echo ""
      `),
      emptyList: createMockBd(`
        if [[ "$1" == "show" ]]; then
          echo '{"id":"forge-xyz","title":"Pre-change dep guard","status":"open"}'
          exit 0
        fi
        exit 0
      `),
      onlyIssue: createMockBd(`
        if [[ "$1" == "show" && "$2" == "forge-abc" ]]; then
          cat <<'ENDJSON'
[{"id":"forge-abc","title":"Pre-change dependency guard for plan workflow","description":"Guard against dep conflicts","status":"in_progress","priority":2}]
ENDJSON
          exit 0
        fi
        if [[ "$1" == "list" ]]; then
          echo "ÃƒÂ¢Ã¢â‚¬â€Ã‚Â forge-abc [ÃƒÂ¢Ã¢â‚¬â€Ã‚Â P2] [feature] - Pre-change dependency guard for plan workflow"
          exit 0
        fi
        echo "Unknown command: $*" >&2
        exit 1
      `),
    };
    mockFiles.push(...Object.values(scenarios));
  });

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
    const result = runDepGuard(['check-ripple', 'forge-nonexistent'], { BD_CMD: scenarios.invalidIssue });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/not found|Failed|Error/i);
  });

  test('warns and skips when title extraction fails', () => {
    const result = runDepGuard(['check-ripple', 'forge-xyz'], { BD_CMD: scenarios.missingTitle });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('could not extract title');
  });

  test('warns and skips when bd list returns empty', () => {
    const result = runDepGuard(['check-ripple', 'forge-xyz'], { BD_CMD: scenarios.emptyList });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('could not fetch active issue list');
  });

  test('no conflicts when source is the only active issue', () => {
    const result = runDepGuard(['check-ripple', 'forge-abc'], { BD_CMD: scenarios.onlyIssue });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No conflicts detected');
    expect(result.stdout).toContain('forge-abc');
  });
});
