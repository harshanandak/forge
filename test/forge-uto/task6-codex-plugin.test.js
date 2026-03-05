import { describe, test, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../');

describe('Task 6: Codex plugin', () => {
  test('lib/agents/codex.plugin.json exists', () => {
    expect(fs.existsSync(path.join(root, 'lib/agents/codex.plugin.json'))).toBe(true);
  });

  test('plugin has correct id and rootConfig', () => {
    const plugin = JSON.parse(fs.readFileSync(path.join(root, 'lib/agents/codex.plugin.json'), 'utf8'));
    expect(plugin.id).toBe('codex');
    expect(plugin.files.rootConfig).toBe('AGENTS.md');
  });

  test('plugin homepage is correct', () => {
    const plugin = JSON.parse(fs.readFileSync(path.join(root, 'lib/agents/codex.plugin.json'), 'utf8'));
    expect(plugin.homepage).toBe('https://github.com/openai/codex');
  });
});
