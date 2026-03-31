/**
 * Tests for Task 3: Remove postinstall + add first-run detection (forge-iv1p)
 *
 * Validates:
 * 1. package.json does not contain "postinstall" key
 * 2. bin/forge.js contains FORGE_SETUP_REQUIRED string
 * 3. First-run check skips for setup, --help, -h, --version, -V commands
 */

const { describe, test, expect } = require('bun:test');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PACKAGE_JSON_PATH = path.join(ROOT, 'package.json');
const FORGE_JS_PATH = path.join(ROOT, 'bin', 'forge.js');

describe('postinstall removal', () => {
  test('package.json does not contain a postinstall script', () => {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
    expect(pkg.scripts).not.toHaveProperty('postinstall');
  });
});

describe('first-run detection', () => {
  const forgeSource = fs.readFileSync(FORGE_JS_PATH, 'utf-8');

  test('bin/forge.js contains FORGE_SETUP_REQUIRED message', () => {
    expect(forgeSource).toContain('FORGE_SETUP_REQUIRED');
  });

  test('first-run check skips for setup command', () => {
    // The skip list should include 'setup'
    expect(forgeSource).toMatch(/setup/);
    // Should have logic that skips the AGENTS.md check for setup (via !== exclusion)
    expect(forgeSource).toMatch(/command\s*!==\s*['"]setup['"]/);
  });

  test('first-run check skips for help flags (--help, -h)', () => {
    // The code should check for help flags before the AGENTS.md check
    expect(forgeSource).toMatch(/flags\.help/);
  });

  test('first-run check skips for version flags (--version, -V)', () => {
    // The code should check for version flags
    expect(forgeSource).toMatch(/flags\.version/);
  });

  test('first-run detection checks for AGENTS.md existence', () => {
    expect(forgeSource).toContain('AGENTS.md');
    expect(forgeSource).toContain('npx forge setup');
  });

  test('first-run detection exits with code 1', () => {
    // Should set process.exitCode = 1 or call process.exit(1)
    expect(forgeSource).toMatch(/process\.exit(Code\s*=\s*1|\(1\))/);
  });
});
