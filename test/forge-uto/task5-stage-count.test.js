import { describe, test, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../');

describe('Task 5: Stage count update', () => {
  const forgeSrc = fs.readFileSync(path.join(root, 'bin/forge.js'), 'utf8');
  // SKILL_CONTENT, CURSOR_RULE, and stage references were extracted to lib/commands/setup.js
  const setupSrc = fs.readFileSync(path.join(root, 'lib/commands/setup.js'), 'utf8');

  test('bin/forge.js does not contain "9-stage"', () => {
    expect(forgeSrc).not.toContain('9-stage');
  });

  test('bin/forge.js contains "7-stage"', () => {
    // 7-stage description now lives in setup.js (SKILL_CONTENT / CURSOR_RULE)
    expect(setupSrc).toContain('7-stage');
  });

  test('SKILL_CONTENT heading says ## 7 Stages not ## 9 Stages', () => {
    expect(setupSrc).not.toContain('## 9 Stages');
    expect(setupSrc).toContain('## 7 Stages');
  });

  test('SKILL_CONTENT workflow flow uses 7-stage commands', () => {
    expect(setupSrc).not.toContain('/status -> /research -> /plan');
    expect(setupSrc).toContain('/status -> /plan -> /dev');
  });

  test('SKILL_CONTENT plan row does not reference OpenSpec', () => {
    expect(setupSrc).not.toContain('OpenSpec if strategic');
  });

  test('CURSOR_RULE description says 7-Stage not 9-Stage', () => {
    expect(setupSrc).not.toContain('Forge 9-Stage TDD Workflow');
    expect(setupSrc).toContain('Forge 7-Stage TDD Workflow');
  });
});
