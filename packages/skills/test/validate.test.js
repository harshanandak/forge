/**
 * Tests for skills validate command
 *
 * Following TDD approach: Write tests first, then implement
 */

import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateCommand } from '../src/commands/validate.js';

describe('Validate Command', () => {
  const testDir = join(process.cwd(), 'test-temp-validate');
  const skillsDir = join(testDir, '.skills');

  beforeEach(() => {
    // Create test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });
    mkdirSync(skillsDir, { recursive: true });

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

  test('validateCommand validates valid SKILL.md', async () => {
    const skillDir = join(skillsDir, 'valid-skill');
    mkdirSync(skillDir, { recursive: true });

    const validSkill = `---
title: Valid Skill
description: A valid test skill
category: coding
version: 1.0.0
author: Test User
created: 2026-02-07
updated: 2026-02-07
---

# Valid Skill

## Purpose

Test purpose

## Instructions

Test instructions
`;

    writeFileSync(join(skillDir, 'SKILL.md'), validSkill);

    const result = await validateCommand('valid-skill');

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('validateCommand detects missing SKILL.md', async () => {
    const skillDir = join(skillsDir, 'no-file-skill');
    mkdirSync(skillDir, { recursive: true });

    const result = await validateCommand('no-file-skill');

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('SKILL.md not found');
  });

  test('validateCommand detects missing YAML frontmatter', async () => {
    const skillDir = join(skillsDir, 'no-yaml-skill');
    mkdirSync(skillDir, { recursive: true });

    writeFileSync(join(skillDir, 'SKILL.md'), '# Just a heading\n\nNo YAML frontmatter');

    const result = await validateCommand('no-yaml-skill');

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('YAML frontmatter'))).toBe(true);
  });

  test('validateCommand detects invalid YAML syntax', async () => {
    const skillDir = join(skillsDir, 'bad-yaml-skill');
    mkdirSync(skillDir, { recursive: true });

    // Use truly invalid YAML with bad indentation structure
    const badYaml = `---
title: Bad Skill
description: Bad YAML
  category: improper nesting
    subcategory: too deep
---

# Bad Skill
`;

    writeFileSync(join(skillDir, 'SKILL.md'), badYaml);

    const result = await validateCommand('bad-yaml-skill');

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('YAML') || e.includes('parse'))).toBe(true);
  });

  test('validateCommand detects missing required field: title', async () => {
    const skillDir = join(skillsDir, 'no-title-skill');
    mkdirSync(skillDir, { recursive: true });

    const noTitle = `---
description: Missing title
category: coding
---

# Skill
`;

    writeFileSync(join(skillDir, 'SKILL.md'), noTitle);

    const result = await validateCommand('no-title-skill');

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('title'))).toBe(true);
  });

  test('validateCommand detects missing required field: description', async () => {
    const skillDir = join(skillsDir, 'no-desc-skill');
    mkdirSync(skillDir, { recursive: true });

    const noDesc = `---
title: No Description
category: coding
---

# Skill
`;

    writeFileSync(join(skillDir, 'SKILL.md'), noDesc);

    const result = await validateCommand('no-desc-skill');

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('description'))).toBe(true);
  });

  test('validateCommand detects missing required field: category', async () => {
    const skillDir = join(skillsDir, 'no-cat-skill');
    mkdirSync(skillDir, { recursive: true });

    const noCat = `---
title: No Category
description: Missing category
---

# Skill
`;

    writeFileSync(join(skillDir, 'SKILL.md'), noCat);

    const result = await validateCommand('no-cat-skill');

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('category'))).toBe(true);
  });

  test('validateCommand detects invalid category', async () => {
    const skillDir = join(skillsDir, 'bad-cat-skill');
    mkdirSync(skillDir, { recursive: true });

    const badCat = `---
title: Bad Category
description: Invalid category value
category: invalid-category
---

# Skill
`;

    writeFileSync(join(skillDir, 'SKILL.md'), badCat);

    const result = await validateCommand('bad-cat-skill');

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('category'))).toBe(true);
  });

  test('validateCommand provides detailed error messages', async () => {
    const skillDir = join(skillsDir, 'multi-error-skill');
    mkdirSync(skillDir, { recursive: true });

    const multiError = `---
category: invalid
---

# Skill
`;

    writeFileSync(join(skillDir, 'SKILL.md'), multiError);

    const result = await validateCommand('multi-error-skill');

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(1); // Multiple errors
  });

  test('validateCommand displays success message for valid skill', async () => {
    const skillDir = join(skillsDir, 'valid-skill');
    mkdirSync(skillDir, { recursive: true });

    const validSkill = `---
title: Valid Skill
description: A valid test skill
category: coding
---

# Valid Skill
`;

    writeFileSync(join(skillDir, 'SKILL.md'), validSkill);

    const output = await captureOutput(async () => {
      await validateCommand('valid-skill');
    });

    expect(output).toMatch(/valid/i);
    expect(output).toMatch(/✓|✔|success/i);
  });

  test('validateCommand displays error messages for invalid skill', async () => {
    const skillDir = join(skillsDir, 'invalid-skill');
    mkdirSync(skillDir, { recursive: true });

    writeFileSync(join(skillDir, 'SKILL.md'), '# No frontmatter');

    const output = await captureOutput(async () => {
      await validateCommand('invalid-skill');
    });

    expect(output).toMatch(/invalid|error|✗/i);
  });

  test('validateCommand prevents path traversal with ../', async () => {
    const result = await validateCommand('../etc');
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('Invalid skill name'))).toBe(true);
  });

  test('validateCommand prevents path traversal with absolute paths', async () => {
    const result = await validateCommand('/etc/passwd');
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('Invalid skill name'))).toBe(true);
  });

  test('validateCommand prevents Windows path traversal', async () => {
    const result = await validateCommand(String.raw`..\..\ Windows`);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('Invalid skill name'))).toBe(true);
  });

  test('validateCommand prevents skill names with slashes', async () => {
    const result = await validateCommand('my/skill');
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('Invalid skill name'))).toBe(true);
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
