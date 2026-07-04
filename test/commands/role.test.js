'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, expect, test } = require('bun:test');

const YAML = require('yaml');

const roleCommand = require('../../lib/commands/role');
const optionsCommand = require('../../lib/commands/options');

const tempRoots = [];

function makeProject({ skills = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-role-verb-'));
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
  return YAML.parse(fs.readFileSync(path.join(root, '.forge', 'config.yaml'), 'utf8'));
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('forge role verb', () => {
  test('--use writes roles.<role>.skill AND forge options roles --json reflects it', async () => {
    const root = makeProject({ skills: ['my-plan'] });

    const result = await roleCommand.handler(['plan', '--use', 'my-plan'], {}, root);
    expect(result.success).toBe(true);

    expect(readConfig(root).roles.plan.skill).toBe('my-plan');

    const options = await optionsCommand.handler(['roles', '--json'], {}, root);
    const role = JSON.parse(options.output).items.find(item => item.role === 'plan');
    expect(role.skill).toBe('my-plan');
    expect(role.configSource).toBe('.forge/config.yaml');
  });

  test('--ideology writes roles.<role>.ideology', async () => {
    const root = makeProject({ skills: ['my-plan'] });
    await roleCommand.handler(['plan', '--use', 'my-plan', '--ideology', 'spec-first'], {}, root);
    const config = readConfig(root);
    expect(config.roles.plan.skill).toBe('my-plan');
    expect(config.roles.plan.ideology).toBe('spec-first');
  });

  test('binds a bring-your-own (open-world) skill name that is not a plan sub-skill', async () => {
    const root = makeProject({ skills: ['totally-custom'] });
    const result = await roleCommand.handler(['dev', '--use', 'totally-custom'], {}, root);
    expect(result.success).toBe(true);
    expect(readConfig(root).roles.dev.skill).toBe('totally-custom');
  });

  test('rejects an unresolvable skill at write time (nothing written)', async () => {
    const root = makeProject();
    const result = await roleCommand.handler(['plan', '--use', 'ghost-skill'], {}, root);
    expect(result.success).toBe(false);
    expect(fs.existsSync(path.join(root, '.forge', 'config.yaml'))).toBe(false);
  });

  test('rejects an unknown role at write time (nothing written)', async () => {
    const root = makeProject({ skills: ['my-plan'] });
    const result = await roleCommand.handler(['not-a-role', '--use', 'my-plan'], {}, root);
    expect(result.success).toBe(false);
    expect(fs.existsSync(path.join(root, '.forge', 'config.yaml'))).toBe(false);
  });

  test('requires at least one of --use / --ideology', async () => {
    const root = makeProject();
    const result = await roleCommand.handler(['plan'], {}, root);
    expect(result.success).toBe(false);
  });
});
