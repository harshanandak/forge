const { describe, test, expect } = require('bun:test');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const toolchainPath = resolve(__dirname, '../docs/TOOLCHAIN.md');

describe('TOOLCHAIN.md beads upgrade documentation', () => {
  test('documents the current Dolt-backed beads release and migration helpers', () => {
    const content = readFileSync(toolchainPath, 'utf8');

    expect(content).toContain('v1.0.0');
    expect(content).toContain('Dolt-backed');
    expect(content).toContain('scripts/beads-migrate-to-dolt.sh');
    expect(content).toContain('scripts/beads-upgrade-smoke.sh');
    expect(content).toContain('rollback');
  });

  test('rejects the legacy SQLite dual-database setup guidance', () => {
    const content = readFileSync(toolchainPath, 'utf8');

    expect(content).not.toMatch(/0\\.49|v0\\./i);
    expect(content).not.toContain('Dual-database architecture');
    expect(content).not.toContain('beads.db');
    expect(content).not.toContain('SQLite cache');
  });
});
