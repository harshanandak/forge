/**
 * Hermes adapter lane (roadmap forge-2agy.9.7.x).
 *
 * Hermes is a harness that consumes Forge project state through the
 * `forge orient` / `forge recap` CLI surface. It is intentionally NOT a
 * command-sync target (no entry in scripts/sync-commands AGENT_ADAPTERS), so
 * its plugin manifest must declare skills wiring WITHOUT declaring
 * `capabilities.commands` — otherwise scripts/check-agents.js fails because
 * there is no Forge sync adapter for it.
 *
 * These tests lock that contract plus the consumption-skill invariants
 * (orient/recap as authority, no direct Forge-state profile writes).
 */

const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');

const { validatePluginSchema } = require('../../lib/plugin-manager');
const { checkAgents } = require('../../scripts/check-agents');

const repoRoot = path.resolve(__dirname, '..', '..');
const pluginPath = path.join(repoRoot, 'lib', 'agents', 'hermes.plugin.json');
const skillPath = path.join(repoRoot, 'skills', 'hermes-forge', 'SKILL.md');
const integrationDocPath = path.join(repoRoot, 'docs', 'reference', 'HERMES_INTEGRATION.md');

function loadHermesPlugin() {
  return JSON.parse(fs.readFileSync(pluginPath, 'utf8'));
}

describe('hermes.plugin.json — manifest contract', () => {
  test('manifest exists and parses as JSON', () => {
    expect(fs.existsSync(pluginPath)).toBe(true);
    expect(loadHermesPlugin()).toBeTruthy();
  });

  test('declares the hermes identity', () => {
    const plugin = loadHermesPlugin();
    expect(plugin.id).toBe('hermes');
    expect(typeof plugin.name).toBe('string');
    expect(typeof plugin.version).toBe('string');
  });

  test('does NOT declare commands capability (no Forge sync adapter exists)', () => {
    const plugin = loadHermesPlugin();
    expect(plugin.capabilities.commands).toBeFalsy();
  });

  test('wires a skills directory for the consumption skill', () => {
    const plugin = loadHermesPlugin();
    expect(plugin.capabilities.skills).toBe(true);
    expect(typeof plugin.directories.skills).toBe('string');
    expect(plugin.directories.skills.length).toBeGreaterThan(0);
  });

  test('declares a valid support status and surface', () => {
    const plugin = loadHermesPlugin();
    expect(['first-class', 'supported', 'compatibility']).toContain(plugin.support.status);
    expect(typeof plugin.support.surface).toBe('string');
  });

  test('passes validatePluginSchema with no errors', () => {
    const result = validatePluginSchema(loadHermesPlugin());
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test('introduces no agent-parity errors in checkAgents', () => {
    const { errors } = checkAgents(repoRoot);
    const hermesErrors = errors.filter((error) => /hermes/i.test(error));
    expect(hermesErrors).toEqual([]);
  });
});

describe('skills/hermes-forge/SKILL.md — consumption contract', () => {
  test('skill template exists with hermes-forge frontmatter', () => {
    expect(fs.existsSync(skillPath)).toBe(true);
    const body = fs.readFileSync(skillPath, 'utf8');
    expect(body.startsWith('---')).toBe(true);
    expect(body).toContain('name: hermes-forge');
  });

  test('treats forge orient / forge recap as project-state authority', () => {
    const body = fs.readFileSync(skillPath, 'utf8');
    expect(body).toContain('forge orient');
    expect(body).toContain('forge recap');
  });

  test('forbids writing Hermes-native profile state into Forge state', () => {
    const body = fs.readFileSync(skillPath, 'utf8');
    // Stable invariant phrase — guards the no-profile-write boundary.
    expect(body).toContain('MUST NOT write Hermes profile');
  });
});

describe('docs/reference/HERMES_INTEGRATION.md — memory boundary', () => {
  test('documents the Forge-Kernel vs Hermes-native memory boundary', () => {
    expect(fs.existsSync(integrationDocPath)).toBe(true);
    const body = fs.readFileSync(integrationDocPath, 'utf8');
    expect(body).toContain('Forge Kernel');
    expect(body).toContain('Hermes');
  });
});
