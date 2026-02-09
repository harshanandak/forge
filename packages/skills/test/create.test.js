/**
 * Tests for skills create command
 *
 * Following TDD approach: Write tests first, then implement
 */

import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createCommand } from '../src/commands/create.js';
import { loadTemplate, renderTemplate } from '../src/lib/template.js';

describe('Template Loading', () => {
  test('loadTemplate returns default template content', () => {
    const content = loadTemplate('default');
    expect(content).toContain('---');
    expect(content).toContain('title: {{title}}');
    expect(content).toContain('## Purpose');
  });

  test('loadTemplate returns research template content', () => {
    const content = loadTemplate('research');
    expect(content).toContain('category: research');
    expect(content).toContain('## Phase 1: Planning');
  });

  test('loadTemplate returns coding template content', () => {
    const content = loadTemplate('coding');
    expect(content).toContain('category: coding');
    expect(content).toContain('**RED**');
    expect(content).toContain('**GREEN**');
    expect(content).toContain('**REFACTOR**');
  });

  test('loadTemplate throws error for invalid template', () => {
    expect(() => loadTemplate('invalid-template')).toThrow();
  });
});

describe('Template Rendering', () => {
  test('renderTemplate replaces variables correctly', () => {
    const template = 'title: {{title}}\nauthor: {{author}}';
    const variables = {
      title: 'My Skill',
      author: 'Test User'
    };

    const result = renderTemplate(template, variables);

    expect(result).toContain('title: My Skill');
    expect(result).toContain('author: Test User');
    expect(result).not.toContain('{{title}}');
    expect(result).not.toContain('{{author}}');
  });

  test('renderTemplate handles missing variables gracefully', () => {
    const template = 'title: {{title}}\nauthor: {{author}}';
    const variables = { title: 'My Skill' };

    const result = renderTemplate(template, variables);

    expect(result).toContain('title: My Skill');
    expect(result).toContain('author: {{author}}'); // Unchanged
  });

  test('renderTemplate handles date formatting', () => {
    const template = 'created: {{created}}';
    const variables = { created: '2026-02-07' };

    const result = renderTemplate(template, variables);

    expect(result).toContain('created: 2026-02-07');
  });
});

describe('Create Command Integration', () => {
  const testDir = join(process.cwd(), 'test-temp');
  const skillsDir = join(testDir, '.skills');

  beforeEach(() => {
    // Create test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });
    mkdirSync(skillsDir, { recursive: true });

    // Create minimal registry
    writeFileSync(
      join(skillsDir, '.registry.json'),
      JSON.stringify({
        version: '1.0.0',
        skills: {},
        config: {}
      })
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

  test('createCommand creates skill directory', async () => {
    await createCommand('my-skill', {
      template: 'default',
      title: 'My Skill',
      description: 'Test skill',
      category: 'coding',
      author: 'Test User',
      nonInteractive: true, // Skip prompts for testing
      noSync: true // Skip auto-sync for testing
    });

    const skillDir = join(skillsDir, 'my-skill');
    expect(existsSync(skillDir)).toBe(true);
  });

  test('createCommand creates SKILL.md file', async () => {
    await createCommand('my-skill', {
      template: 'default',
      title: 'My Skill',
      description: 'Test skill',
      category: 'coding',
      author: 'Test User',
      nonInteractive: true,
      noSync: true
    });

    const skillMdPath = join(skillsDir, 'my-skill', 'SKILL.md');
    expect(existsSync(skillMdPath)).toBe(true);

    const content = readFileSync(skillMdPath, 'utf8');
    expect(content).toContain('title: My Skill');
    expect(content).toContain('description: Test skill');
    expect(content).toContain('category: coding');
  });

  test('createCommand creates .skill-meta.json file', async () => {
    await createCommand('my-skill', {
      template: 'default',
      title: 'My Skill',
      description: 'Test skill',
      category: 'coding',
      author: 'Test User',
      nonInteractive: true,
      noSync: true
    });

    const metaPath = join(skillsDir, 'my-skill', '.skill-meta.json');
    expect(existsSync(metaPath)).toBe(true);

    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    expect(meta.id).toBe('my-skill');
    expect(meta.title).toBe('My Skill');
    expect(meta.description).toBe('Test skill');
    expect(meta.category).toBe('coding');
    expect(meta.version).toBe('1.0.0');
  });

  test('createCommand updates .registry.json', async () => {
    await createCommand('my-skill', {
      template: 'default',
      title: 'My Skill',
      description: 'Test skill',
      category: 'coding',
      author: 'Test User',
      nonInteractive: true,
      noSync: true
    });

    const registryPath = join(skillsDir, '.registry.json');
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));

    expect(registry.skills['my-skill']).toBeDefined();
    expect(registry.skills['my-skill'].title).toBe('My Skill');
  });

  test('createCommand uses specified template', async () => {
    await createCommand('research-skill', {
      template: 'research',
      title: 'Research Skill',
      description: 'Test research',
      author: 'Test User',
      nonInteractive: true,
      noSync: true
    });

    const skillMdPath = join(skillsDir, 'research-skill', 'SKILL.md');
    const content = readFileSync(skillMdPath, 'utf8');

    expect(content).toContain('category: research');
    expect(content).toContain('Phase 1: Planning');
  });

  test('createCommand fails if skill already exists', async () => {
    // Create skill first time
    await createCommand('my-skill', {
      template: 'default',
      title: 'My Skill',
      description: 'Test skill',
      category: 'coding',
      author: 'Test User',
      nonInteractive: true,
      noSync: true
    });

    // Try to create again
    await expect(
      createCommand('my-skill', {
        template: 'default',
        title: 'My Skill 2',
        description: 'Test skill 2',
        category: 'coding',
        author: 'Test User',
        nonInteractive: true
      })
    ).rejects.toThrow('Skill already exists');
  });

  test('createCommand handles invalid skill name', async () => {
    await expect(
      createCommand('invalid name', {
        template: 'default',
        nonInteractive: true,
        noSync: true
      })
    ).rejects.toThrow('Invalid skill name');
  });

  test('createCommand sets correct timestamps', async () => {
    const beforeCreate = Date.now();

    await createCommand('my-skill', {
      template: 'default',
      title: 'My Skill',
      description: 'Test skill',
      category: 'coding',
      author: 'Test User',
      nonInteractive: true,
      noSync: true
    });

    const afterCreate = Date.now();

    const metaPath = join(skillsDir, 'my-skill', '.skill-meta.json');
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));

    // Check format
    expect(meta.created).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(meta.updated).toBe(meta.created);

    // Check timestamps are within reasonable range (with 100ms tolerance for CI timing)
    const createdTime = new Date(meta.created).getTime();
    const tolerance = 100; // 100ms tolerance for slow CI environments
    expect(createdTime >= beforeCreate - tolerance).toBe(true);
    expect(createdTime <= afterCreate + tolerance).toBe(true);
  });
});
