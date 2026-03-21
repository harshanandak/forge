import { describe, test, expect } from 'bun:test';
import { sanitizeTitle, sanitizeBody, sanitizeLabel } from '../../../scripts/github-beads-sync/sanitize.mjs';

describe('sanitizeTitle', () => {
  test('normal title passes through unchanged, no warnings', () => {
    const result = sanitizeTitle('Fix login button alignment');
    expect(result.sanitized).toBe('Fix login button alignment');
    expect(result.warnings).toEqual([]);
  });

  test('title with shell metacharacters strips dangerous chars', () => {
    const result = sanitizeTitle('Fix bug; rm -rf /');
    expect(result.sanitized).toBe('Fix bug rm -rf /');
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some(w => w.includes(';'))).toBe(true);
  });

  test('title with pipe and ampersand stripped', () => {
    const result = sanitizeTitle('feat | docs & tests');
    expect(result.sanitized).toBe('feat  docs  tests');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  test('title with ${{ github.token }} strips interpolation', () => {
    const result = sanitizeTitle('Deploy ${{ github.token }} leaked');
    expect(result.sanitized).toBe('Deploy  leaked');
    expect(result.warnings.some(w => w.includes('interpolation'))).toBe(true);
  });

  test('title over 256 chars truncated', () => {
    const longTitle = 'A'.repeat(300);
    const result = sanitizeTitle(longTitle);
    expect(result.sanitized.length).toBe(256);
    expect(result.warnings.some(w => w.includes('truncat'))).toBe(true);
  });

  test('empty title returns (empty) with warning', () => {
    const result = sanitizeTitle('');
    expect(result.sanitized).toBe('(empty)');
    expect(result.warnings.some(w => w.includes('empty'))).toBe(true);
  });

  test('title that becomes empty after sanitization returns (empty)', () => {
    const result = sanitizeTitle(';|&$`()<>');
    expect(result.sanitized).toBe('(empty)');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  test('unicode title preserves alphanumeric unicode, strips control chars', () => {
    const result = sanitizeTitle('修复登录按钮 bug\x00\x01');
    expect(result.sanitized).toBe('修复登录按钮 bug');
    expect(result.warnings.some(w => w.includes('control'))).toBe(true);
  });
});

describe('sanitizeBody', () => {
  test('normal body passes through unchanged', () => {
    const result = sanitizeBody('This fixes the issue with login.');
    expect(result.sanitized).toBe('This fixes the issue with login.');
    expect(result.warnings).toEqual([]);
  });

  test('body over 1024 chars truncated', () => {
    const longBody = 'B'.repeat(2000);
    const result = sanitizeBody(longBody);
    expect(result.sanitized.length).toBe(1024);
    expect(result.warnings.some(w => w.includes('truncat'))).toBe(true);
  });

  test('body with shell metacharacters stripped', () => {
    const result = sanitizeBody('Run `echo hello` and $(cmd)');
    expect(result.sanitized).toBe('Run echo hello and cmd');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  test('empty body returns (empty) with warning', () => {
    const result = sanitizeBody('');
    expect(result.sanitized).toBe('(empty)');
    expect(result.warnings.some(w => w.includes('empty'))).toBe(true);
  });
});

describe('sanitizeLabel', () => {
  test('valid label passes through unchanged', () => {
    const result = sanitizeLabel('bug-fix');
    expect(result.sanitized).toBe('bug-fix');
    expect(result.warnings).toEqual([]);
  });

  test('label with spaces and special chars cleaned', () => {
    const result = sanitizeLabel('good first issue!');
    expect(result.sanitized).toBe('goodfirstissue');
    expect(result.warnings.some(w => w.includes('invalid'))).toBe(true);
  });

  test('label over 64 chars truncated', () => {
    const longLabel = 'a'.repeat(100);
    const result = sanitizeLabel(longLabel);
    expect(result.sanitized.length).toBe(64);
    expect(result.warnings.some(w => w.includes('truncat'))).toBe(true);
  });

  test('label with dots and underscores preserved', () => {
    const result = sanitizeLabel('v2.0_release');
    expect(result.sanitized).toBe('v2.0_release');
    expect(result.warnings).toEqual([]);
  });

  test('empty label returns (empty) with warning', () => {
    const result = sanitizeLabel('');
    expect(result.sanitized).toBe('(empty)');
    expect(result.warnings.some(w => w.includes('empty'))).toBe(true);
  });
});
