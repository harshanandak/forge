const { test, expect } = require('bun:test');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PREFLIGHT_PATH = path.resolve(__dirname, '..', '..', 'bin', 'forge-preflight.js');

test('forge-preflight dev accepts docs/work design docs', () => {
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
