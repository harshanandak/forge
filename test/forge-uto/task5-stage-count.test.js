import { describe, test, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../');

describe('Task 5: workflow template language', () => {
  const src = fs.readFileSync(path.join(root, 'bin/forge.js'), 'utf8');

  test('bin/forge.js does not contain "9-stage"', () => {
    expect(src).not.toContain('9-stage');
  });

  test('bin/forge.js does not advertise a fixed 7-stage product identity', () => {
    expect(src).not.toContain('7-stage TDD-first workflow');
  });

  // The umbrella workflow template moved out of bin/forge.js (SKILL_CONTENT)
  // into the canonical kernel skill during the command→skills migration.
  const kernelSkill = fs.readFileSync(path.join(root, 'skills/kernel/SKILL.md'), 'utf8');

  test('kernel skill frames stages as a template, not a fixed count', () => {
    expect(kernelSkill).not.toContain('## 9 Stages');
    expect(kernelSkill).not.toContain('## 7 Stages');
    expect(kernelSkill).toContain('## Stage skills (the TDD ladder)');
  });

  test('kernel skill keeps the default stage order', () => {
    expect(kernelSkill).not.toContain('status → research → plan');
    expect(kernelSkill).toContain('status → plan → dev');
  });

  test('SKILL_CONTENT plan row does not reference OpenSpec', () => {
    expect(src).not.toContain('OpenSpec if strategic');
  });

  test('CURSOR_RULE description uses template language', () => {
    expect(src).not.toContain('Forge 9-Stage TDD Workflow');
    expect(src).not.toContain('Forge 7-Stage TDD Workflow');
    expect(src).toContain('Forge TDD Workflow Template');
  });
});
