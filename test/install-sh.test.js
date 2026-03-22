const { describe, it, expect } = require('bun:test');
const { readFileSync } = require('fs');
const { join } = require('path');

const ROOT = join(__dirname, '..');
const content = readFileSync(join(ROOT, 'install.sh'), 'utf8');
const lines = content.split('\n');

describe('install.sh thin bootstrapper', () => {
  it('should be under 50 lines', () => {
    expect(lines.length).toBeLessThanOrEqual(50);
  });

  it('should use strict bash settings', () => {
    expect(content).toContain('#!/usr/bin/env bash');
    expect(content).toContain('set -euo pipefail');
  });

  it('should contain a deprecation/bootstrapper notice', () => {
    const hasNotice =
      content.includes('bootstrapper') || content.includes('deprecat');
    expect(hasNotice).toBe(true);
  });

  it('should install the forge-workflow package with bun', () => {
    expect(content).toContain('bun add -D forge-workflow');
  });

  it('should fall back to npm install', () => {
    expect(content).toContain('npm install -D forge-workflow');
  });

  it('should delegate to bunx forge setup', () => {
    expect(content).toContain('bunx forge setup');
  });

  it('should delegate to npx forge setup as fallback', () => {
    expect(content).toContain('npx forge setup');
  });

  it('should pass through all CLI args via $@', () => {
    // Both delegation paths must forward args
    expect(content).toContain('bunx forge setup "$@"');
    expect(content).toContain('npx forge setup "$@"');
  });

  it('should handle missing package manager with exit 1', () => {
    expect(content).toContain('exit 1');
  });

  it('should print install instructions when no package manager found', () => {
    const hasInstructions =
      content.includes('https://bun.sh') || content.includes('install bun');
    expect(hasInstructions).toBe(true);
  });

  it('should exit with the delegated command exit code', () => {
    expect(content).toContain('exit $?');
  });
});
