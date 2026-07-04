'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, expect, test } = require('bun:test');

const optionsCommand = require('../../lib/commands/options');

const tempRoots = [];

function makeProject(configBody) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-options-roles-'));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
  if (configBody != null) {
    fs.writeFileSync(path.join(root, '.forge', 'config.yaml'), configBody);
  }
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('forge options roles', () => {
  test('--json lists the default roles bound to their like-named skills', async () => {
    const root = makeProject(null);
    const result = await optionsCommand.handler(['roles', '--json'], {}, root);
    const parsed = JSON.parse(result.output);
    expect(parsed.kind).toBe('roles');
    const byRole = Object.fromEntries(parsed.items.map(item => [item.role, item]));
    expect(Object.keys(byRole).sort()).toEqual(
      ['dev', 'plan', 'review', 'ship', 'validate', 'verify'],
    );
    expect(byRole.plan.skill).toBe('plan');
    expect(byRole.plan.configSource).toBe('package-defaults');
  });

  test('--json reflects a roles override from .forge/config.yaml', async () => {
    const root = makeProject('roles:\n  plan:\n    skill: my-plan\n    ideology: spec-first\n');
    const result = await optionsCommand.handler(['roles', '--json'], {}, root);
    const role = JSON.parse(result.output).items.find(item => item.role === 'plan');
    expect(role.skill).toBe('my-plan');
    expect(role.ideology).toBe('spec-first');
    expect(role.configSource).toBe('.forge/config.yaml');
  });

  test('text output summarizes a role as its bound skill', async () => {
    const root = makeProject(null);
    const result = await optionsCommand.handler(['roles'], {}, root);
    expect(result.output).toContain('role.plan (skill=plan)');
  });
});
