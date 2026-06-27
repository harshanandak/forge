/**
 * Tests for agent parity and explicit exceptions in the skills-only surface.
 *
 * The canonical workflow source is root skills/. Agent harness skill dirs are
 * generated from it by `skills sync` / `forge setup`. There is no command-sync
 * adapter layer anymore (the .claude/commands surface was removed in PR-A0).
 */

const fs = require('node:fs');
const path = require('node:path');
const { describe, test, expect } = require('bun:test');

const repoRoot = path.resolve(__dirname, '..');
const SUPPORTED_AGENTS = ['claude', 'codex', 'cursor', 'hermes'];

describe('agent parity gaps', () => {
  test('all supported agents have plugin definitions', () => {
    const agentsDir = path.join(repoRoot, 'lib', 'agents');
    for (const agent of SUPPORTED_AGENTS) {
      expect(fs.existsSync(path.join(agentsDir, `${agent}.plugin.json`))).toBe(true);
    }
  });

  test('canonical workflow source is skills/', () => {
    const skillsDir = path.join(repoRoot, 'skills');
    expect(fs.existsSync(skillsDir)).toBe(true);
    const entries = fs.readdirSync(skillsDir).filter((d) =>
      fs.statSync(path.join(skillsDir, d)).isDirectory()
    );
    expect(entries.length).toBeGreaterThan(0);
    // The umbrella + a representative stage skill are present.
    expect(entries).toContain('kernel');
    expect(entries).toContain('plan');
  });

  test('every plugin declaring skills capability configures a skills directory', () => {
    const agentsDir = path.join(repoRoot, 'lib', 'agents');
    for (const file of fs.readdirSync(agentsDir).filter((f) => f.endsWith('.plugin.json'))) {
      const plugin = JSON.parse(fs.readFileSync(path.join(agentsDir, file), 'utf8'));
      if (plugin.capabilities && plugin.capabilities.skills) {
        expect(plugin.directories && plugin.directories.skills).toBeTruthy();
      }
    }
  });

  test('removed agents have no plugin definitions', () => {
    const agentsDir = path.join(repoRoot, 'lib', 'agents');
    for (const removed of ['cline', 'copilot', 'kilocode', 'opencode', 'roo']) {
      expect(fs.existsSync(path.join(agentsDir, `${removed}.plugin.json`))).toBe(false);
    }
  });
});
