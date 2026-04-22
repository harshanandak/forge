const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, test, expect, afterAll } = require('bun:test');
const { createMockBd, runDepGuard } = require('./dep-guard.helpers');

describe('scripts/dep-guard.sh > apply-decision', () => {
  const mockFiles = [];
  const logFiles = [];

  afterAll(() => {
    for (const file of mockFiles) {
      try { fs.unlinkSync(file); } catch (_error) {}
    }
    for (const file of logFiles) {
      try { fs.unlinkSync(file); } catch (_error) {}
    }
  });

  test('approved decision adds dependency, records state/comment, and prints graph/ready summary', () => {
    const logPath = path.join(os.tmpdir(), `dep-guard-apply-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
    logFiles.push(logPath);
    const mock = createMockBd(`
      echo "$*" >> "$MOCK_LOG"
      if [[ "$1" == "dep" && "$2" == "add" ]]; then
        echo "Added dependency: $3 depends on $4"
        exit 0
      fi
      if [[ "$1" == "dep" && "$2" == "cycles" ]]; then
        echo "No cycles detected"
        exit 0
      fi
      if [[ "$1" == "graph" ]]; then
        echo "forge-src -> forge-other"
        exit 0
      fi
      if [[ "$1" == "ready" ]]; then
        echo "forge-jvc"
        exit 0
      fi
      if [[ "$1" == "set-state" ]]; then
        echo "Set state"
        exit 0
      fi
      if [[ "$1" == "comments" && "$2" == "add" ]]; then
        echo "Added comment"
        exit 0
      fi
      echo "Unknown command: $*" >&2
      exit 1
    `);
    mockFiles.push(mock);

    const result = runDepGuard([
      'apply-decision',
      'forge-src',
      'forge-other',
      'forge-src',
      'Approved because shared logic changes affect the dashboard flow.',
    ], {
      BD_CMD: mock,
      MOCK_LOG: logPath,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Approved dependency applied');
    expect(result.stdout).toContain('forge-other depends on forge-src');
    expect(result.stdout).toContain('Graph:');
    expect(result.stdout).toContain('forge-src -> forge-other');
    expect(result.stdout).toContain('Ready impact:');
    expect(result.stdout).toContain('forge-jvc');

    const log = fs.readFileSync(logPath, 'utf8');
    expect(log).toContain('dep add forge-other forge-src');
    expect(log).toContain('dep cycles');
    expect(log).toContain('set-state forge-src logicdep=approved --reason Approved because shared logic changes affect the dashboard flow.');
    expect(log).toContain('comments add forge-src');
  });

  test('cycle-creating update is rejected before state/comment persistence', () => {
    const logPath = path.join(os.tmpdir(), `dep-guard-cycle-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
    logFiles.push(logPath);
    const mock = createMockBd(`
      echo "$*" >> "$MOCK_LOG"
      if [[ "$1" == "dep" && "$2" == "add" ]]; then
        echo "Added dependency: $3 depends on $4"
        exit 0
      fi
      if [[ "$1" == "dep" && "$2" == "cycles" ]]; then
        echo "Cycle detected: forge-other -> forge-src -> forge-other"
        exit 1
      fi
      if [[ "$1" == "dep" && "$2" == "remove" ]]; then
        echo "Removed dependency"
        exit 0
      fi
      if [[ "$1" == "set-state" || "$1" == "comments" ]]; then
        echo "Should not persist after cycle" >&2
        exit 1
      fi
      echo "Unknown command: $*" >&2
      exit 1
    `);
    mockFiles.push(mock);

    const result = runDepGuard([
      'apply-decision',
      'forge-src',
      'forge-other',
      'forge-src',
      'Approved because shared logic changes affect the dashboard flow.',
    ], {
      BD_CMD: mock,
      MOCK_LOG: logPath,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/cycle/i);

    const log = fs.readFileSync(logPath, 'utf8');
    expect(log).toContain('dep add forge-other forge-src');
    expect(log).toContain('dep cycles');
    expect(log).toContain('dep remove forge-other forge-src');
    expect(log).not.toContain('set-state forge-src');
    expect(log).not.toContain('comments add forge-src');
  });

  test('successful cycle validation accepts alternate no-cycle messages', () => {
    const logPath = path.join(os.tmpdir(), `dep-guard-no-cycle-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
    logFiles.push(logPath);
    const mock = createMockBd(`
      echo "$*" >> "$MOCK_LOG"
      if [[ "$1" == "dep" && "$2" == "add" ]]; then
        echo "Added dependency: $3 depends on $4"
        exit 0
      fi
      if [[ "$1" == "dep" && "$2" == "cycles" ]]; then
        echo "No cycle found"
        exit 0
      fi
      if [[ "$1" == "graph" ]]; then
        echo "forge-src -> forge-other"
        exit 0
      fi
      if [[ "$1" == "ready" ]]; then
        echo "forge-jvc"
        exit 0
      fi
      if [[ "$1" == "set-state" ]]; then
        echo "Set state"
        exit 0
      fi
      if [[ "$1" == "comments" && "$2" == "add" ]]; then
        echo "Added comment"
        exit 0
      fi
      echo "Unknown command: $*" >&2
      exit 1
    `);
    mockFiles.push(mock);

    const result = runDepGuard([
      'apply-decision',
      'forge-src',
      'forge-other',
      'forge-src',
      'Approved because shared logic changes affect the dashboard flow.',
    ], {
      BD_CMD: mock,
      MOCK_LOG: logPath,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Approved dependency applied');
    expect(fs.readFileSync(logPath, 'utf8')).not.toContain('dep remove forge-other forge-src');
  });

  test('failed rollback after cycle validation surfaces a manual intervention error', () => {
    const logPath = path.join(os.tmpdir(), `dep-guard-rollback-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
    logFiles.push(logPath);
    const mock = createMockBd(`
      echo "$*" >> "$MOCK_LOG"
      if [[ "$1" == "dep" && "$2" == "add" ]]; then
        echo "Added dependency: $3 depends on $4"
        exit 0
      fi
      if [[ "$1" == "dep" && "$2" == "cycles" ]]; then
        echo "Cycle detected: forge-other -> forge-src -> forge-other"
        exit 0
      fi
      if [[ "$1" == "dep" && "$2" == "remove" ]]; then
        echo "Rollback failed" >&2
        exit 1
      fi
      echo "Unknown command: $*" >&2
      exit 1
    `);
    mockFiles.push(mock);

    const result = runDepGuard([
      'apply-decision',
      'forge-src',
      'forge-other',
      'forge-src',
      'Approved because shared logic changes affect the dashboard flow.',
    ], {
      BD_CMD: mock,
      MOCK_LOG: logPath,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/rollback|manual intervention/i);
  });

  test('failed ready/state persistence rolls back the dependency edge before exiting', () => {
    const logPath = path.join(os.tmpdir(), `dep-guard-ready-failure-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
    logFiles.push(logPath);
    const mock = createMockBd(`
      echo "$*" >> "$MOCK_LOG"
      if [[ "$1" == "dep" && "$2" == "add" ]]; then
        echo "Added dependency: $3 depends on $4"
        exit 0
      fi
      if [[ "$1" == "dep" && "$2" == "cycles" ]]; then
        echo "No cycles detected"
        exit 0
      fi
      if [[ "$1" == "graph" ]]; then
        echo "forge-src -> forge-other"
        exit 0
      fi
      if [[ "$1" == "ready" ]]; then
        echo "ready failed" >&2
        exit 1
      fi
      if [[ "$1" == "dep" && "$2" == "remove" ]]; then
        echo "Removed dependency"
        exit 0
      fi
      if [[ "$1" == "set-state" || "$1" == "comments" ]]; then
        echo "Should not persist after ready failure" >&2
        exit 1
      fi
      echo "Unknown command: $*" >&2
      exit 1
    `);
    mockFiles.push(mock);

    const result = runDepGuard([
      'apply-decision',
      'forge-src',
      'forge-other',
      'forge-src',
      'Approved because shared logic changes affect the dashboard flow.',
    ], {
      BD_CMD: mock,
      MOCK_LOG: logPath,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/ready work|rollback|manual intervention/i);

    const log = fs.readFileSync(logPath, 'utf8');
    expect(log).toContain('dep add forge-other forge-src');
    expect(log).toContain('ready');
    expect(log).toContain('dep remove forge-other forge-src');
    expect(log).not.toContain('set-state forge-src');
    expect(log).not.toContain('comments add forge-src');
  });
});
