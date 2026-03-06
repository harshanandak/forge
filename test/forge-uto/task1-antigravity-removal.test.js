import { describe, test, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../');

describe('Task 1: Antigravity removal', () => {
  test('lib/agents/antigravity.plugin.json does not exist', () => {
    expect(fs.existsSync(path.join(root, 'lib/agents/antigravity.plugin.json'))).toBe(false);
  });

  test('GEMINI.md does not exist', () => {
    expect(fs.existsSync(path.join(root, 'GEMINI.md'))).toBe(false);
  });

  test('.agent/ directory does not exist', () => {
    expect(fs.existsSync(path.join(root, '.agent'))).toBe(false);
  });
});
