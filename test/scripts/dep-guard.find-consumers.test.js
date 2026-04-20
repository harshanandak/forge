const { describe, test, expect } = require('bun:test');
const { runDepGuard } = require('./dep-guard.helpers');

describe('scripts/dep-guard.sh > find-consumers', () => {
  test('known function found: sanitize appears in at least one script', () => {
    const result = runDepGuard(['find-consumers', 'sanitize']);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/scripts\/.*\.sh/);
    expect(result.stdout).not.toContain('No consumers found');
  });

  test('nonexistent name prints "No consumers found" and exits 0', () => {
    const result = runDepGuard(['find-consumers', 'zzz_nonexistent_xyz_12345']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No consumers found');
  });

  test('empty input (no args) exits 1', () => {
    const result = runDepGuard(['find-consumers']);
    expect(result.status).toBe(1);
  });

  test('leading-hyphen pattern is not interpreted as grep flag', () => {
    const result = runDepGuard(['find-consumers', '--version']);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toMatch(/grep|GNU|ripgrep/i);
    expect(result.stderr ?? '').not.toMatch(/grep|GNU|ripgrep/i);
  });

  test('self-exclusion: dep-guard.sh is not a matched file', () => {
    const result = runDepGuard(['find-consumers', 'dep-guard']);
    const lines = result.stdout.split('\n').filter(Boolean);

    for (const line of lines) {
      const filePath = line.split(':')[0];
      expect(filePath).not.toContain('dep-guard.sh');
    }
  });
});
