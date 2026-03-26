/**
 * Tests for postinstall guard behavior (forge-kgg2)
 *
 * Validates:
 * 1. Postinstall path checks npm_lifecycle_event (no surprise file changes)
 * 2. Postinstall message detects package manager from lock files (not hardcoded)
 * 3. minimalInstall() only runs on explicit invocation, not during postinstall
 */

const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');

const FORGE_JS_PATH = path.resolve(__dirname, '..', 'bin', 'forge.js');
const source = fs.readFileSync(FORGE_JS_PATH, 'utf-8');

describe('postinstall guard', () => {
  test('checks npm_lifecycle_event to detect postinstall context', () => {
    expect(source).toContain("process.env.npm_lifecycle_event === 'postinstall'");
  });

  test('postinstall branch does not call minimalInstall()', () => {
    // Verify the postinstall block itself doesn't contain minimalInstall
    const postinstallBlock = source.match(
      /npm_lifecycle_event === 'postinstall'\) \{([\s\S]*?)\} else \{/
    );
    expect(postinstallBlock).not.toBeNull();
    expect(postinstallBlock[1]).not.toContain('minimalInstall');
  });

  test('minimalInstall() is in the explicit invocation branch (not postinstall)', () => {
    // minimalInstall should be called in the else branch after the postinstall check
    expect(source).toMatch(/\} else \{[\s\S]*?\/\/ Explicit invocation[\s\S]*?minimalInstall\(\)/);
  });
});

describe('postinstall setup instruction uses detected package manager', () => {
  test('detects bun lockfile for setup command', () => {
    // The postinstall branch should check for bun.lockb/bun.lock
    const postinstallBlock = source.match(
      /npm_lifecycle_event === 'postinstall'\) \{([\s\S]*?)\} else \{/
    );
    expect(postinstallBlock).not.toBeNull();
    expect(postinstallBlock[1]).toContain('bun.lockb');
    expect(postinstallBlock[1]).toContain('bunx');
  });

  test('detects pnpm lockfile for setup command', () => {
    const postinstallBlock = source.match(
      /npm_lifecycle_event === 'postinstall'\) \{([\s\S]*?)\} else \{/
    );
    expect(postinstallBlock[1]).toContain('pnpm-lock.yaml');
    expect(postinstallBlock[1]).toContain('pnpm dlx');
  });

  test('detects yarn lockfile for setup command', () => {
    const postinstallBlock = source.match(
      /npm_lifecycle_event === 'postinstall'\) \{([\s\S]*?)\} else \{/
    );
    expect(postinstallBlock[1]).toContain('yarn.lock');
    expect(postinstallBlock[1]).toContain('yarn dlx');
  });

  test('defaults to npx when no lockfile found', () => {
    const postinstallBlock = source.match(
      /npm_lifecycle_event === 'postinstall'\) \{([\s\S]*?)\} else \{/
    );
    expect(postinstallBlock[1]).toContain("'npx'");
  });

  test('does not hardcode bunx as the only option', () => {
    // The setup instruction should use a variable, not a hardcoded string
    const postinstallBlock = source.match(
      /npm_lifecycle_event === 'postinstall'\) \{([\s\S]*?)\} else \{/
    );
    // Should NOT contain a hardcoded 'bunx forge setup' string literal
    expect(postinstallBlock[1]).not.toMatch(/console\.log\(\s*['"].*bunx forge setup.*['"]\s*\)/);
  });
});
