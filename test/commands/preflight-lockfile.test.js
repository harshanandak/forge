/**
 * Tests for preflight lockfile-based package manager detection (forge-1zqd)
 *
 * Validates that forge-preflight.js detects package manager from lock files
 * and uses `run test` (not bare `test`) to invoke the package.json test script.
 */

const { describe, test, expect } = require('bun:test');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PREFLIGHT_PATH = path.resolve(__dirname, '..', '..', 'bin', 'forge-preflight.js');
const source = fs.readFileSync(PREFLIGHT_PATH, 'utf-8');

describe('preflight package manager detection', () => {
  test('detects bun from bun.lockb or bun.lock', () => {
    expect(source).toContain('bun.lockb');
    expect(source).toContain('bun.lock');
  });

  test('detects pnpm from pnpm-lock.yaml', () => {
    expect(source).toContain('pnpm-lock.yaml');
  });

  test('detects yarn from yarn.lock', () => {
    expect(source).toContain('yarn.lock');
  });

  test('defaults to npm when no lock file matches', () => {
    // npm is the initial value before lock file checks
    expect(source).toMatch(/let cmd\s*=\s*["']npm["']/);
  });

  test('uses "run test" to invoke package.json script (not bare "test")', () => {
    // All package managers should use ["run", "test"] to run the package.json
    // test script, not ["test"] which invokes the built-in test runner
    const runTestMatches = source.match(/cmdArgs\s*=\s*\["run",\s*"test"\]/g);
    const bareTestMatches = source.match(/cmdArgs\s*=\s*\["test"\]/g);
    expect(runTestMatches).not.toBeNull();
    expect(runTestMatches.length).toBeGreaterThanOrEqual(4); // npm default + bun, pnpm, yarn
    expect(bareTestMatches).toBeNull(); // no bare "test" args
  });

  test('accepts docs/work design docs for dev preflight', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-preflight-work-doc-'));
    try {
      execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'pipe' });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpDir, stdio: 'pipe' });
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tmpDir, stdio: 'pipe' });
      execFileSync('git', ['commit', '--allow-empty', '-m', 'initial'], { cwd: tmpDir, stdio: 'pipe' });
      execFileSync('git', ['checkout', '-b', 'feat/work-doc-contract'], { cwd: tmpDir, stdio: 'pipe' });
      fs.mkdirSync(path.join(tmpDir, 'docs', 'work', '2026-05-04-work-doc-contract'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'docs', 'research'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'test'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'docs', 'work', '2026-05-04-work-doc-contract', 'design.md'), '# Design\n', 'utf8');
      fs.writeFileSync(path.join(tmpDir, 'docs', 'research', 'work-doc-contract.md'), '# Research\n', 'utf8');

      const result = spawnSync(process.execPath, [PREFLIGHT_PATH, 'dev'], {
        cwd: tmpDir,
        encoding: 'utf8',
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Plan file exists');
      expect(result.stdout).not.toContain('No plan file found');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
