/**
 * Tests for shared validation utilities
 *
 * Following TDD approach: Write tests first, then implement
 */

import { test, expect, describe } from 'bun:test';
import { validateSkillName, ensurePathWithin } from '../src/lib/validation.js';
import { join } from 'path';

describe('validateSkillName', () => {
  test('accepts valid skill names', () => {
    expect(() => validateSkillName('my-skill')).not.toThrow();
    expect(() => validateSkillName('test_skill')).not.toThrow();
    expect(() => validateSkillName('skill123')).not.toThrow();
    expect(() => validateSkillName('a')).not.toThrow();
  });

  test('rejects undefined or null', () => {
    expect(() => validateSkillName(undefined)).toThrow('Skill name is required');
    expect(() => validateSkillName(null)).toThrow('Skill name is required');
    expect(() => validateSkillName('')).toThrow('Skill name is required');
  });

  test('rejects non-string values', () => {
    expect(() => validateSkillName(123)).toThrow('Skill name is required');
    expect(() => validateSkillName({})).toThrow('Skill name is required');
    expect(() => validateSkillName([])).toThrow('Skill name is required');
  });

  test('rejects skill names that are too long', () => {
    const longName = 'a'.repeat(101);
    expect(() => validateSkillName(longName)).toThrow('too long');
  });

  test('rejects path traversal attempts', () => {
    expect(() => validateSkillName('../etc')).toThrow('Invalid skill name');
    expect(() => validateSkillName('../../passwd')).toThrow('Invalid skill name');
    expect(() => validateSkillName('..')).toThrow('Invalid skill name');
    expect(() => validateSkillName('.')).toThrow('Invalid skill name');
  });

  test('rejects skill names with invalid characters', () => {
    expect(() => validateSkillName('my skill')).toThrow('Invalid skill name');
    expect(() => validateSkillName('my/skill')).toThrow('Invalid skill name');
    expect(() => validateSkillName('my\\skill')).toThrow('Invalid skill name');
    expect(() => validateSkillName('UPPERCASE')).toThrow('Invalid skill name');
    expect(() => validateSkillName('skill@123')).toThrow('Invalid skill name');
  });

  test('rejects absolute paths', () => {
    expect(() => validateSkillName('/etc/passwd')).toThrow('Invalid skill name');
    expect(() => validateSkillName('C:\\Windows')).toThrow('Invalid skill name');
  });
});

describe('ensurePathWithin', () => {
  test('allows paths within base directory', () => {
    const base = '/home/user/project/.skills';
    const target = '/home/user/project/.skills/my-skill';

    expect(() => ensurePathWithin(base, target)).not.toThrow();
  });

  test('prevents path traversal outside base directory', () => {
    const base = '/home/user/project/.skills';
    const target = '/home/user/project/other-dir';

    expect(() => ensurePathWithin(base, target)).toThrow('Path traversal detected');
  });

  test('prevents traversal via .. sequences', () => {
    const base = '/home/user/project/.skills';
    const traversal = join(base, '../../../etc/passwd');

    expect(() => ensurePathWithin(base, traversal)).toThrow('Path traversal detected');
  });

  test('normalizes paths before comparison', () => {
    const base = '/home/user/project/.skills';
    const target = '/home/user/project/.skills/./my-skill';

    expect(() => ensurePathWithin(base, target)).not.toThrow();
  });

  test.skipIf(process.platform !== 'win32')('handles Windows paths', () => {
    const base = 'C:\\Users\\test\\.skills';
    const target = 'C:\\Users\\test\\.skills\\my-skill';

    expect(() => ensurePathWithin(base, target)).not.toThrow();
  });

  test.skipIf(process.platform !== 'win32')('prevents Windows path traversal', () => {
    const base = 'C:\\Users\\test\\.skills';
    const target = 'C:\\Users\\test\\other-dir';

    expect(() => ensurePathWithin(base, target)).toThrow('Path traversal detected');
  });
});
