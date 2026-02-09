/**
 * Tests for skills list command
 *
 * Following TDD approach: Write tests first, then implement
 */

import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { listCommand } from '../src/commands/list.js';

describe('List Command', () => {
  const testDir = join(process.cwd(), 'test-temp-list');
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
        'web-research': {
          title: 'Web Research',
          description: 'Search and analyze web content',
          category: 'research',
          author: 'Test User',
          created: '2026-02-07',
          updated: '2026-02-07'
        },
        'code-review': {
          title: 'Code Review',
          description: 'Review code for quality and security',
          category: 'review',
          author: 'Test User',
          created: '2026-02-06',
          updated: '2026-02-06'
        },
        'api-development': {
          title: 'API Development',
          description: 'Build RESTful APIs with TDD',
          category: 'coding',
          author: 'Another User',
          created: '2026-02-05',
          updated: '2026-02-07'
        },
        'unit-testing': {
          title: 'Unit Testing',
          description: 'Write comprehensive unit tests',
          category: 'testing',
          author: 'Test User',
          created: '2026-02-04',
          updated: '2026-02-04'
        }
      },
      config: {}
    };

    writeFileSync(
      join(skillsDir, '.registry.json'),
      JSON.stringify(registry, null, 2)
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

  test('listCommand displays all skills', async () => {
    const output = await captureOutput(async () => {
      await listCommand({});
    });

    expect(output).toContain('web-research');
    expect(output).toContain('code-review');
    expect(output).toContain('api-development');
    expect(output).toContain('unit-testing');
  });

  test('listCommand displays descriptions', async () => {
    const output = await captureOutput(async () => {
      await listCommand({});
    });

    expect(output).toContain('Search and analyze web content');
    expect(output).toContain('Review code for quality and security');
    expect(output).toContain('Build RESTful APIs with TDD');
    expect(output).toContain('Write comprehensive unit tests');
  });

  test('listCommand displays categories', async () => {
    const output = await captureOutput(async () => {
      await listCommand({});
    });

    expect(output).toContain('research');
    expect(output).toContain('review');
    expect(output).toContain('coding');
    expect(output).toContain('testing');
  });

  test('listCommand filters by category', async () => {
    const output = await captureOutput(async () => {
      await listCommand({ category: 'research' });
    });

    expect(output).toContain('web-research');
    expect(output).not.toContain('code-review');
    expect(output).not.toContain('api-development');
    expect(output).not.toContain('unit-testing');
  });

  test('listCommand filters by multiple categories', async () => {
    const output = await captureOutput(async () => {
      await listCommand({ category: 'coding' });
    });

    expect(output).toContain('api-development');
    expect(output).not.toContain('web-research');
    expect(output).not.toContain('code-review');
  });

  test('listCommand shows count of skills', async () => {
    const output = await captureOutput(async () => {
      await listCommand({});
    });

    expect(output).toMatch(/4 skills?/i);
  });

  test('listCommand handles empty registry', async () => {
    // Create empty registry
    writeFileSync(
      join(skillsDir, '.registry.json'),
      JSON.stringify({ version: '1.0.0', skills: {}, config: {} })
    );

    const output = await captureOutput(async () => {
      await listCommand({});
    });

    expect(output).toMatch(/no skills/i);
    expect(output).toContain('skills create');
  });

  test('listCommand handles missing registry', async () => {
    // Remove registry
    rmSync(join(skillsDir, '.registry.json'));

    await expect(listCommand({})).rejects.toThrow();
  });

  test('listCommand displays skills in table format', async () => {
    const output = await captureOutput(async () => {
      await listCommand({});
    });

    // Should have header-like structure
    expect(output).toContain('Name');
    expect(output).toContain('Category');
    expect(output).toContain('Description');
  });

  test('listCommand sorts skills alphabetically', async () => {
    const output = await captureOutput(async () => {
      await listCommand({});
    });

    const apiIndex = output.indexOf('api-development');
    const codeIndex = output.indexOf('code-review');
    const unitIndex = output.indexOf('unit-testing');
    const webIndex = output.indexOf('web-research');

    expect(apiIndex).toBeLessThan(codeIndex);
    expect(codeIndex).toBeLessThan(unitIndex);
    expect(unitIndex).toBeLessThan(webIndex);
  });

  test('listCommand shows helpful message for no results', async () => {
    const output = await captureOutput(async () => {
      await listCommand({ category: 'nonexistent' });
    });

    expect(output).toMatch(/no skills found/i);
    expect(output).toContain('nonexistent');
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
