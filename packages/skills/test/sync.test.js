/**
 * Tests for skills sync command
 *
 * Following TDD approach: Write tests first, then implement
 */

import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { syncCommand } from '../src/commands/sync.js';

describe('Sync Command', () => {
  const testDir = join(process.cwd(), 'test-temp-sync');
  const skillsDir = join(testDir, '.skills');

  beforeEach(() => {
    // Create test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });
    mkdirSync(skillsDir, { recursive: true });

    // Create registry
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
      config: {
        agents: {},
        autoSync: true,
        autoUpdateAgentsMd: true,
        preserveAgentsMd: false
      }
    };

    writeFileSync(
      join(skillsDir, '.registry.json'),
      JSON.stringify(registry, null, 2)
    );

    // Create test skills
    const skillDir1 = join(skillsDir, 'test-skill');
    mkdirSync(skillDir1, { recursive: true });
    writeFileSync(
      join(skillDir1, 'SKILL.md'),
      '---\ntitle: Test Skill\n---\n\n# Test Skill\n\nTest content'
    );
    writeFileSync(
      join(skillDir1, '.skill-meta.json'),
      JSON.stringify({ id: 'test-skill', title: 'Test Skill' }, null, 2)
    );

    const skillDir2 = join(skillsDir, 'another-skill');
    mkdirSync(skillDir2, { recursive: true });
    writeFileSync(
      join(skillDir2, 'SKILL.md'),
      '---\ntitle: Another Skill\n---\n\n# Another Skill\n\nAnother test content'
    );
    writeFileSync(
      join(skillDir2, '.skill-meta.json'),
      JSON.stringify({ id: 'another-skill', title: 'Another Skill' }, null, 2)
    );

    // Change to test directory
    process.chdir(testDir);
  });

  afterEach(() => {
    // Cleanup
    process.chdir(join(process.cwd(), '..'));
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test('syncCommand copies skills to detected agent directories', async () => {
    // Create agent directories
    mkdirSync('.cursor', { recursive: true });
    mkdirSync('.github', { recursive: true });

    await syncCommand({});

    // Verify skills were copied to Cursor
    expect(existsSync('.cursor/skills/test-skill/SKILL.md')).toBe(true);
    expect(existsSync('.cursor/skills/test-skill/.skill-meta.json')).toBe(true);
    expect(existsSync('.cursor/skills/another-skill/SKILL.md')).toBe(true);

    // Verify skills were copied to GitHub
    expect(existsSync('.github/skills/test-skill/SKILL.md')).toBe(true);
    expect(existsSync('.github/skills/test-skill/.skill-meta.json')).toBe(true);
    expect(existsSync('.github/skills/another-skill/SKILL.md')).toBe(true);
  });

  test('syncCommand creates agent skills directories if missing', async () => {
    mkdirSync('.cursor', { recursive: true });

    await syncCommand({});

    expect(existsSync('.cursor/skills')).toBe(true);
  });

  test('syncCommand only syncs to enabled agents', async () => {
    // Create all agent directories
    mkdirSync('.cursor', { recursive: true });
    mkdirSync('.github', { recursive: true });
    mkdirSync('.cline', { recursive: true }); // Disabled by default
    mkdirSync('.continue', { recursive: true }); // Disabled by default

    await syncCommand({});

    // Enabled agents should have skills
    expect(existsSync('.cursor/skills/test-skill/SKILL.md')).toBe(true);
    expect(existsSync('.github/skills/test-skill/SKILL.md')).toBe(true);

    // Disabled agents should NOT have skills
    expect(existsSync('.cline/skills/test-skill/SKILL.md')).toBe(false);
    expect(existsSync('.continue/skills/test-skill/SKILL.md')).toBe(false);
  });

  test('syncCommand handles no agents gracefully', async () => {
    // No agent directories created
    const output = await captureOutput(async () => {
      await syncCommand({});
    });

    expect(output).toMatch(/no agents detected/i);
  });

  test('syncCommand handles empty skills directory', async () => {
    mkdirSync('.cursor', { recursive: true });

    // Remove all skills
    rmSync(join(skillsDir, 'test-skill'), { recursive: true });
    rmSync(join(skillsDir, 'another-skill'), { recursive: true });

    // Update registry
    const registry = JSON.parse(readFileSync(join(skillsDir, '.registry.json'), 'utf8'));
    registry.skills = {};
    writeFileSync(join(skillsDir, '.registry.json'), JSON.stringify(registry, null, 2));

    const output = await captureOutput(async () => {
      await syncCommand({});
    });

    expect(output).toMatch(/no skills to sync/i);
  });

  test('syncCommand overwrites existing agent skills', async () => {
    mkdirSync('.cursor', { recursive: true });

    // Create old version
    mkdirSync('.cursor/skills/test-skill', { recursive: true });
    writeFileSync('.cursor/skills/test-skill/SKILL.md', 'OLD CONTENT');

    await syncCommand({});

    // Verify new content
    const content = readFileSync('.cursor/skills/test-skill/SKILL.md', 'utf8');
    expect(content).toContain('Test Skill');
    expect(content).toContain('Test content');
    expect(content).not.toContain('OLD CONTENT');
  });

  test('syncCommand displays sync summary', async () => {
    mkdirSync('.cursor', { recursive: true });
    mkdirSync('.github', { recursive: true });

    const output = await captureOutput(async () => {
      await syncCommand({});
    });

    expect(output).toContain('test-skill');
    expect(output).toContain('another-skill');
    expect(output).toContain('cursor');
    expect(output).toContain('github');
    expect(output).toMatch(/2 skills?/i);
    expect(output).toMatch(/2 agents?/i);
  });

  test('syncCommand handles missing registry', async () => {
    rmSync(join(skillsDir, '.registry.json'));

    await expect(syncCommand({})).rejects.toThrow();
  });

  test('syncCommand copies all files in skill directory', async () => {
    mkdirSync('.cursor', { recursive: true });

    // Add extra file to skill
    writeFileSync(join(skillsDir, 'test-skill', 'README.md'), 'Extra file');

    await syncCommand({});

    expect(existsSync('.cursor/skills/test-skill/README.md')).toBe(true);
    const content = readFileSync('.cursor/skills/test-skill/README.md', 'utf8');
    expect(content).toBe('Extra file');
  });

  test('syncCommand validates source skill directories', async () => {
    mkdirSync('.cursor', { recursive: true });

    // Create invalid skill (missing SKILL.md)
    const invalidSkillDir = join(skillsDir, 'invalid-skill');
    mkdirSync(invalidSkillDir, { recursive: true });
    writeFileSync(join(invalidSkillDir, 'other.txt'), 'Not a skill');

    await syncCommand({});

    // Invalid skill should not be synced
    expect(existsSync('.cursor/skills/invalid-skill')).toBe(false);

    // Valid skills should still be synced
    expect(existsSync('.cursor/skills/test-skill/SKILL.md')).toBe(true);
  });

  test('syncCommand shows progress for each agent', async () => {
    mkdirSync('.cursor', { recursive: true });
    mkdirSync('.github', { recursive: true });

    const output = await captureOutput(async () => {
      await syncCommand({});
    });

    // Should show sync messages for each agent
    expect(output).toContain('cursor');
    expect(output).toContain('github');
  });

  test('syncCommand updates registry with sync timestamp', async () => {
    mkdirSync('.cursor', { recursive: true });

    const beforeSync = Date.now();
    await syncCommand({});
    const afterSync = Date.now();

    const registry = JSON.parse(readFileSync(join(skillsDir, '.registry.json'), 'utf8'));
    expect(registry.config.lastSync).toBeDefined();

    const syncTime = new Date(registry.config.lastSync).getTime();
    expect(syncTime >= beforeSync).toBe(true);
    expect(syncTime <= afterSync).toBe(true);
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
