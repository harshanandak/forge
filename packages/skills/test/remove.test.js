/**
 * Tests for skills remove command
 *
 * Following TDD approach: Write tests first, then implement
 */

import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { removeCommand } from '../src/commands/remove.js';

describe('Remove Command', () => {
  const testDir = join(process.cwd(), 'test-temp-remove');
  const skillsDir = join(testDir, '.skills');

  beforeEach(() => {
    // Create test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });
    mkdirSync(skillsDir, { recursive: true });

    // Create registry with sample skills
    const registry = {
      version: '1.0.0',
      skills: {
        'test-skill': {
          title: 'Test Skill',
          description: 'A test skill',
          category: 'coding',
          author: 'Test User',
          created: '2026-02-07',
          updated: '2026-02-07'
        },
        'another-skill': {
          title: 'Another Skill',
          description: 'Another test skill',
          category: 'research',
          author: 'Test User',
          created: '2026-02-07',
          updated: '2026-02-07'
        }
      },
      config: {}
    };

    writeFileSync(
      join(skillsDir, '.registry.json'),
      JSON.stringify(registry, null, 2)
    );

    // Create test skills
    const skillDir1 = join(skillsDir, 'test-skill');
    mkdirSync(skillDir1, { recursive: true });
    writeFileSync(join(skillDir1, 'SKILL.md'), 'Test content');
    writeFileSync(
      join(skillDir1, '.skill-meta.json'),
      JSON.stringify({ id: 'test-skill' }, null, 2)
    );

    const skillDir2 = join(skillsDir, 'another-skill');
    mkdirSync(skillDir2, { recursive: true });
    writeFileSync(join(skillDir2, 'SKILL.md'), 'Another content');
    writeFileSync(
      join(skillDir2, '.skill-meta.json'),
      JSON.stringify({ id: 'another-skill' }, null, 2)
    );

    // Change to test directory
    process.chdir(testDir);

    // Create agent directories with synced skills (after chdir)
    mkdirSync('.cursor/skills/test-skill', { recursive: true });
    writeFileSync('.cursor/skills/test-skill/SKILL.md', 'Test content');

    mkdirSync('.github/skills/test-skill', { recursive: true });
    writeFileSync('.github/skills/test-skill/SKILL.md', 'Test content');
  });

  afterEach(() => {
    // Cleanup
    process.chdir(join(process.cwd(), '..'));
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test('removeCommand removes skill from .skills/', async () => {
    await removeCommand('test-skill', { force: true });

    expect(existsSync(join(skillsDir, 'test-skill'))).toBe(false);
  });

  test('removeCommand removes skill from registry', async () => {
    await removeCommand('test-skill', { force: true });

    const registry = JSON.parse(readFileSync(join(skillsDir, '.registry.json'), 'utf8'));
    expect(registry.skills['test-skill']).toBeUndefined();
  });

  test('removeCommand keeps other skills intact', async () => {
    await removeCommand('test-skill', { force: true });

    // another-skill should still exist
    expect(existsSync(join(skillsDir, 'another-skill'))).toBe(true);

    const registry = JSON.parse(readFileSync(join(skillsDir, '.registry.json'), 'utf8'));
    expect(registry.skills['another-skill']).toBeDefined();
  });

  test('removeCommand removes skill from agent directories', async () => {
    await removeCommand('test-skill', { force: true });

    expect(existsSync('.cursor/skills/test-skill')).toBe(false);
    expect(existsSync('.github/skills/test-skill')).toBe(false);
  });

  test('removeCommand handles skill not found', async () => {
    await expect(
      removeCommand('nonexistent-skill', { force: true })
    ).rejects.toThrow('Skill not found');
  });

  test('removeCommand handles missing registry', async () => {
    rmSync(join(skillsDir, '.registry.json'));

    await expect(
      removeCommand('test-skill', { force: true })
    ).rejects.toThrow();
  });

  test('removeCommand displays success message', async () => {
    const output = await captureOutput(async () => {
      await removeCommand('test-skill', { force: true });
    });

    expect(output).toContain('test-skill');
    expect(output).toMatch(/removed/i);
  });

  test('removeCommand shows which agents were updated', async () => {
    const output = await captureOutput(async () => {
      await removeCommand('test-skill', { force: true });
    });

    expect(output).toContain('cursor');
    expect(output).toContain('github');
  });

  test('removeCommand handles agent directory not existing', async () => {
    // Remove agent directories
    rmSync('.cursor', { recursive: true, force: true });
    rmSync('.github', { recursive: true, force: true });

    // Should not throw error
    await removeCommand('test-skill', { force: true });

    expect(existsSync(join(skillsDir, 'test-skill'))).toBe(false);
  });

  test('removeCommand handles skill in agents but not in .skills/', async () => {
    // Remove from .skills/ but keep in agents
    rmSync(join(skillsDir, 'test-skill'), { recursive: true, force: true });

    // Update registry to remove skill
    const registry = JSON.parse(readFileSync(join(skillsDir, '.registry.json'), 'utf8'));
    delete registry.skills['test-skill'];
    writeFileSync(join(skillsDir, '.registry.json'), JSON.stringify(registry, null, 2));

    // Should still clean up agent directories
    await expect(
      removeCommand('test-skill', { force: true })
    ).rejects.toThrow('Skill not found');
  });

  test('removeCommand validates skill name', async () => {
    await expect(
      removeCommand('', { force: true })
    ).rejects.toThrow();
  });

  test('removeCommand prevents path traversal with ../', async () => {
    await expect(
      removeCommand('../etc', { force: true })
    ).rejects.toThrow('Invalid skill name');
  });

  test('removeCommand prevents path traversal with absolute paths', async () => {
    await expect(
      removeCommand('/etc/passwd', { force: true })
    ).rejects.toThrow('Invalid skill name');
  });

  test('removeCommand prevents path traversal with Windows paths', async () => {
    await expect(
      removeCommand('..\\..\\Windows', { force: true })
    ).rejects.toThrow('Invalid skill name');
  });

  test('removeCommand prevents uppercase skill names', async () => {
    await expect(
      removeCommand('UPPERCASE-SKILL', { force: true })
    ).rejects.toThrow('Invalid skill name');
  });
});

/**
 * Helper: Capture console output
 */
async function captureOutput(fn) {
  const originalLog = console.log;
  const originalError = console.error;
  let output = '';

  console.log = (...args) => {
    output += args.join(' ') + '\n';
  };
  console.error = (...args) => {
    output += args.join(' ') + '\n';
  };

  try {
    await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  return output;
}
