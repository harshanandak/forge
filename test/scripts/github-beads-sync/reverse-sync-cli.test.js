const { describe, it, expect, beforeEach, afterEach } = require('bun:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CLI_PATH = path.resolve(__dirname, '../../../scripts/github-beads-sync/reverse-sync-cli.mjs');

function runCli(args, opts = {}) {
  return execFileSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 10000,
    ...opts,
  });
}

/** Extract the pretty-printed JSON object from CLI stdout (ignoring trailing summary line) */
function parseResult(stdout) {
  const lastBrace = stdout.lastIndexOf('}');
  return JSON.parse(stdout.slice(0, lastBrace + 1));
}

describe('reverse-sync-cli.mjs', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reverse-sync-cli-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should exit 1 with usage when no args provided', () => {
    try {
      runCli([]);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.status).toBe(1);
      expect(err.stderr.toString()).toContain('Usage:');
    }
  });

  it('should exit 1 with usage when only one arg provided', () => {
    const oldFile = path.join(tmpDir, 'old.jsonl');
    fs.writeFileSync(oldFile, '');
    try {
      runCli([oldFile]);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.status).toBe(1);
      expect(err.stderr.toString()).toContain('Usage:');
    }
  });

  it('should exit 0 with empty files (no transitions)', () => {
    const oldFile = path.join(tmpDir, 'old.jsonl');
    const newFile = path.join(tmpDir, 'new.jsonl');
    fs.writeFileSync(oldFile, '');
    fs.writeFileSync(newFile, '');

    const stdout = runCli([oldFile, newFile]);
    const result = parseResult(stdout);
    expect(result.closed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('should detect a closure transition and output JSON result', () => {
    const oldFile = path.join(tmpDir, 'old.jsonl');
    const newFile = path.join(tmpDir, 'new.jsonl');

    const issue = { id: 'forge-abc', title: 'Test', status: 'open', description: 'https://github.com/test/repo/issues/5' };
    const closedIssue = { ...issue, status: 'closed' };

    fs.writeFileSync(oldFile, JSON.stringify(issue) + '\n');
    fs.writeFileSync(newFile, JSON.stringify(closedIssue) + '\n');

    // Will fail because gh CLI is not available in test, but it should attempt the close
    // and report an error (exit 1), not a usage error
    try {
      const stdout = runCli([oldFile, newFile]);
      // If gh is available, it would attempt to close — either way, result should have structure
      const result = parseResult(stdout);
      expect(result).toHaveProperty('closed');
      expect(result).toHaveProperty('errors');
    } catch (err) {
      // gh CLI not found = error in closing, not a crash
      expect(err.status).toBe(1);
      expect(err.stderr.toString()).toContain('failed to close');
    }
  });

  it('should skip issues without GitHub URL in description', () => {
    const oldFile = path.join(tmpDir, 'old.jsonl');
    const newFile = path.join(tmpDir, 'new.jsonl');

    const issue = { id: 'forge-xyz', title: 'No URL', status: 'open', description: 'just text' };
    const closedIssue = { ...issue, status: 'closed' };

    fs.writeFileSync(oldFile, JSON.stringify(issue) + '\n');
    fs.writeFileSync(newFile, JSON.stringify(closedIssue) + '\n');

    const stdout = runCli([oldFile, newFile]);
    const result = parseResult(stdout);
    expect(result.skipped.length).toBe(1);
    expect(result.closed).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});
