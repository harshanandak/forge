'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, expect, test } = require('bun:test');

const YAML = require('yaml');

const {
  setConfigOverride,
  removeConfigOverride,
  resolveSkill,
  loadRawConfig,
} = require('../lib/config-writer');

const tempRoots = [];

/**
 * Create an isolated temp project with a `.forge/` dir and, optionally, one or
 * more bring-your-own skills under `.skills/<name>/SKILL.md`.
 */
function makeProject({ skills = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-config-writer-'));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
  for (const name of skills) {
    const dir = path.join(root, '.skills', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `# ${name}\n`);
  }
  return root;
}

function readConfig(root) {
  const raw = fs.readFileSync(path.join(root, '.forge', 'config.yaml'), 'utf8');
  return YAML.parse(raw);
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('config-writer sparse writer', () => {
  test('creates .forge/config.yaml and sets a nested key via an array key-path', () => {
    const root = makeProject();
    setConfigOverride(root, ['workflow', 'gates', 'gate.plan-exit', 'enabled'], false);
    const config = readConfig(root);
    // Array key-path keeps the dotted gate id 'gate.plan-exit' as ONE key.
    expect(config.workflow.gates['gate.plan-exit'].enabled).toBe(false);
  });

  test('preserves existing sibling keys on update', () => {
    const root = makeProject();
    setConfigOverride(root, ['workflow', 'gates', 'gate.plan-exit', 'enabled'], false);
    setConfigOverride(root, ['roles', 'plan', 'skill'], 'my-plan');
    setConfigOverride(root, ['workflow', 'gates', 'gate.dev-exit', 'enabled'], false);
    const config = readConfig(root);
    expect(config.workflow.gates['gate.plan-exit'].enabled).toBe(false);
    expect(config.workflow.gates['gate.dev-exit'].enabled).toBe(false);
    expect(config.roles.plan.skill).toBe('my-plan');
  });

  test('removeConfigOverride resets a key and prunes empty ancestors', () => {
    const root = makeProject();
    setConfigOverride(root, ['workflow', 'gates', 'gate.plan-exit', 'enabled'], false);
    const result = removeConfigOverride(root, ['workflow', 'gates', 'gate.plan-exit', 'enabled']);
    expect(result.removed).toBe(true);
    // The whole now-empty workflow branch is pruned, keeping the surface sparse.
    expect(loadRawConfig(root)).toEqual({});
  });

  test('removeConfigOverride is a no-op for an absent key', () => {
    const root = makeProject();
    const result = removeConfigOverride(root, ['roles', 'plan', 'skill']);
    expect(result.removed).toBe(false);
  });

  test('rejects a malformed key-path', () => {
    const root = makeProject();
    expect(() => setConfigOverride(root, [], true)).toThrow();
  });

  test('resolveSkill finds a .skills shadow skill and returns null for a missing one', () => {
    const root = makeProject({ skills: ['my-plan'] });
    expect(resolveSkill(root, 'my-plan')).not.toBeNull();
    expect(resolveSkill(root, 'ghost-skill')).toBeNull();
  });

  test('resolveSkill rejects path-traversal names', () => {
    const root = makeProject({ skills: ['my-plan'] });
    expect(resolveSkill(root, '../my-plan')).toBeNull();
    expect(resolveSkill(root, '')).toBeNull();
  });
});
