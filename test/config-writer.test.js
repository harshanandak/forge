'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, expect, test } = require('bun:test');

const YAML = require('yaml');

const gateCommand = require('../lib/commands/gate');
const roleCommand = require('../lib/commands/role');
const optionsCommand = require('../lib/commands/options');
const { setConfigOverride, removeConfigOverride, resolveSkill } = require('../lib/config-writer');

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

describe('config-writer + forge gate/role verbs', () => {
  test('sparse writer creates .forge/config.yaml and sets a nested dotted key', () => {
    const root = makeProject();
    setConfigOverride(root, ['workflow', 'gates', 'gate.plan-exit', 'enabled'], false);
    const config = readConfig(root);
    expect(config.workflow.gates['gate.plan-exit'].enabled).toBe(false);
  });

  test('sparse writer preserves existing keys on update', () => {
    const root = makeProject();
    setConfigOverride(root, ['workflow', 'gates', 'gate.plan-exit', 'enabled'], false);
    setConfigOverride(root, ['workflow', 'gates', 'gate.dev-exit', 'enabled'], false);
    const config = readConfig(root);
    expect(config.workflow.gates['gate.plan-exit'].enabled).toBe(false);
    expect(config.workflow.gates['gate.dev-exit'].enabled).toBe(false);
  });

  test('removeConfigOverride resets a key and prunes empty ancestors', () => {
    const root = makeProject();
    setConfigOverride(root, ['workflow', 'gates', 'gate.plan-exit', 'enabled'], false);
    removeConfigOverride(root, ['workflow', 'gates', 'gate.plan-exit', 'enabled']);
    const config = readConfig(root);
    expect(config.workflow?.gates?.['gate.plan-exit']).toBeUndefined();
  });

  test('forge gate disable gate.plan-exit writes enabled=false AND forge options gates --json reflects it', async () => {
    const root = makeProject();

    const result = await gateCommand.handler(['disable', 'gate.plan-exit'], {}, root);
    expect(result.success).toBe(true);

    // Write side: the surface records the override.
    const config = readConfig(root);
    expect(config.workflow.gates['gate.plan-exit'].enabled).toBe(false);

    // Read side: the shipped resolver reflects it through forge options gates --json.
    const options = await optionsCommand.handler(['gates', '--json'], {}, root);
    const parsed = JSON.parse(options.output);
    const gate = parsed.items.find(item => item.id === 'gate.plan-exit');
    expect(gate.enabled).toBe(false);
  });

  test('forge gate enable flips it back to true', async () => {
    const root = makeProject();
    await gateCommand.handler(['disable', 'gate.plan-exit'], {}, root);
    await gateCommand.handler(['enable', 'gate.plan-exit'], {}, root);
    const options = await optionsCommand.handler(['gates', '--json'], {}, root);
    const gate = JSON.parse(options.output).items.find(item => item.id === 'gate.plan-exit');
    expect(gate.enabled).toBe(true);
  });

  test('forge gate rejects an unknown gate id at write time', async () => {
    const root = makeProject();
    const result = await gateCommand.handler(['disable', 'gate.does-not-exist'], {}, root);
    expect(result.success).toBe(false);
    expect(fs.existsSync(path.join(root, '.forge', 'config.yaml'))).toBe(false);
  });

  test('forge role plan --use my-plan writes roles.plan.skill AND forge options roles --json reflects it', async () => {
    const root = makeProject({ skills: ['my-plan'] });

    const result = await roleCommand.handler(['plan', '--use', 'my-plan'], {}, root);
    expect(result.success).toBe(true);

    const config = readConfig(root);
    expect(config.roles.plan.skill).toBe('my-plan');

    const options = await optionsCommand.handler(['roles', '--json'], {}, root);
    const parsed = JSON.parse(options.output);
    const role = parsed.items.find(item => item.role === 'plan');
    expect(role.skill).toBe('my-plan');
  });

  test('forge role --ideology writes roles.<role>.ideology', async () => {
    const root = makeProject({ skills: ['my-plan'] });
    await roleCommand.handler(['plan', '--use', 'my-plan', '--ideology', 'spec-first'], {}, root);
    const config = readConfig(root);
    expect(config.roles.plan.skill).toBe('my-plan');
    expect(config.roles.plan.ideology).toBe('spec-first');
  });

  test('forge role rejects an unresolvable skill at write time', async () => {
    const root = makeProject();
    const result = await roleCommand.handler(['plan', '--use', 'ghost-skill'], {}, root);
    expect(result.success).toBe(false);
    expect(fs.existsSync(path.join(root, '.forge', 'config.yaml'))).toBe(false);
  });

  test('forge role rejects an unknown role at write time', async () => {
    const root = makeProject({ skills: ['my-plan'] });
    const result = await roleCommand.handler(['not-a-role', '--use', 'my-plan'], {}, root);
    expect(result.success).toBe(false);
    expect(fs.existsSync(path.join(root, '.forge', 'config.yaml'))).toBe(false);
  });

  test('resolveSkill finds a .skills shadow skill', () => {
    const root = makeProject({ skills: ['my-plan'] });
    expect(resolveSkill(root, 'my-plan')).not.toBeNull();
    expect(resolveSkill(root, 'ghost-skill')).toBeNull();
  });
});
