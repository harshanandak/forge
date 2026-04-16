const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, test, expect, beforeAll, afterAll } = require('bun:test');
const { createMockBd, runDepGuard } = require('./dep-guard.helpers');

describe('scripts/dep-guard.sh > extract-contracts', () => {
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
    const lines = result.stdout.trim().split('\n').map(line => line.trim()).filter(Boolean);
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
    const lines = result.stdout.trim().split('\n').map(line => line.trim()).filter(Boolean);
    expect(lines.filter(line => line === 'lib/utils.js:helper(modified)')).toHaveLength(1);
    expect(lines).toContain('lib/utils.js:transform(modified)');
  });
});

describe('scripts/dep-guard.sh > store-contracts', () => {
  const mockFiles = [];

  afterAll(() => {
    for (const file of mockFiles) {
      try { fs.unlinkSync(file); } catch (_error) {}
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
      if [[ "$1" == "show" && "$2" == "test-1" ]]; then
        echo '{"id":"test-1","title":"Test issue","status":"open"}'
        exit 0
      fi
      if [[ "$1" == "update" ]]; then
        echo "Updated issue: test-1"
        exit 0
      fi
      echo "Unknown command: $*" >&2
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
      if [[ "$1" == "show" ]]; then
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
