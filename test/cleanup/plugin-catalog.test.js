const { describe, test, expect } = require('bun:test');
const { join } = require('path');
const { readFileSync, existsSync } = require('fs');

const AGENTS_DIR = join(__dirname, '..', '..', 'lib', 'agents');

/** Load plugin JSON from disk (avoids bun require cache) */
function loadPlugin(agent) {
  const filePath = join(AGENTS_DIR, `${agent}.plugin.json`);
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

const SUPPORTED_AGENTS = [
  'claude',
  'cursor',
  'cline',
  'opencode',
  'copilot',
  'kilocode',
  'roo',
  'codex',
];

describe('agent plugin catalog — capability flags', () => {
  for (const agent of SUPPORTED_AGENTS) {
    describe(agent, () => {
      test('plugin.json exists and loads', () => {
        const plugin = loadPlugin(agent);
        expect(plugin).toBeTruthy();
        expect(plugin.id).toBe(agent);
      });

      test('capabilities.commands is true', () => {
        const plugin = loadPlugin(agent);
        expect(plugin.capabilities.commands).toBe(true);
      });

      test('directories object is not empty', () => {
        const plugin = loadPlugin(agent);
        expect(plugin.directories).toBeTruthy();
        expect(Object.keys(plugin.directories).length).toBeGreaterThan(0);
      });
    });
  }

  describe('claude — hooks capability', () => {
    test('capabilities.hooks is true', () => {
      const plugin = loadPlugin('claude');
      expect(plugin.capabilities.hooks).toBe(true);
    });
  });

  describe('no dropped agent plugin files', () => {
    test('continue.plugin.json does not exist', () => {
      const filePath = join(AGENTS_DIR, 'continue.plugin.json');
      expect(existsSync(filePath)).toBe(false);
    });
  });
});
