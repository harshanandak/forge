const fs = require('node:fs');
const path = require('node:path');
const { describe, test, expect } = require('bun:test');

const lintScriptPath = path.join(__dirname, '..', 'scripts', 'lint.js');
const lintSource = fs.readFileSync(lintScriptPath, 'utf8');

describe('scripts/lint.js — package manager delegation', () => {
  test('does not contain npx --yes (no network dependency)', () => {
    expect(lintSource).not.toContain('npx --yes');
  });

  test('contains detectPackageManager function', () => {
    expect(lintSource).toContain('detectPackageManager');
  });

  test('uses "run" and "lint" in spawnSync args for pkg-manager delegation', () => {
    // Should delegate to `<pkgManager> run lint` pattern
    expect(lintSource).toContain("'run'");
    expect(lintSource).toContain("'lint'");
  });

  test('has error handling for missing package manager', () => {
    // Should reference the detected package manager in error output
    expect(lintSource).toContain('pkgManager');
    expect(lintSource).toContain('result.error');
  });
});
