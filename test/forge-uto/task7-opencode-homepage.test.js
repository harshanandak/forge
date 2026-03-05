import { describe, test, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../');

describe('Task 7: OpenCode plugin homepage', () => {
  test('homepage is opencode.ai not github.com/opencode', () => {
    const plugin = JSON.parse(fs.readFileSync(path.join(root, 'lib/agents/opencode.plugin.json'), 'utf8'));
    expect(plugin.homepage).not.toContain('github.com/opencode');
    expect(plugin.homepage).toBe('https://opencode.ai');
  });
});
