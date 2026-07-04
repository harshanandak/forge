'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, expect, test } = require('bun:test');

const YAML = require('yaml');

const gateCommand = require('../../lib/commands/gate');
const optionsCommand = require('../../lib/commands/options');

const tempRoots = [];

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-gate-verb-'));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
  return root;
}

function readConfig(root) {
  return YAML.parse(fs.readFileSync(path.join(root, '.forge', 'config.yaml'), 'utf8'));
}

function gates(options) {
  return JSON.parse(options.output).items;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('forge gate verb', () => {
  test('disable writes workflow.gates.<id>.enabled=false AND forge options gates --json reflects it', async () => {
    const root = makeProject();

    const result = await gateCommand.handler(['disable', 'gate.plan-exit'], {}, root);
    expect(result.success).toBe(true);

    // Write side.
    expect(readConfig(root).workflow.gates['gate.plan-exit'].enabled).toBe(false);

    // Read side through the shipped resolver — zero new read code.
    const options = await optionsCommand.handler(['gates', '--json'], {}, root);
    expect(gates(options).find(g => g.id === 'gate.plan-exit').enabled).toBe(false);
  });

  test('enable flips it back to true', async () => {
    const root = makeProject();
    await gateCommand.handler(['disable', 'gate.plan-exit'], {}, root);
    await gateCommand.handler(['enable', 'gate.plan-exit'], {}, root);
    const options = await optionsCommand.handler(['gates', '--json'], {}, root);
    expect(gates(options).find(g => g.id === 'gate.plan-exit').enabled).toBe(true);
  });

  test('rejects an unknown gate id at write time (nothing written)', async () => {
    const root = makeProject();
    const result = await gateCommand.handler(['disable', 'gate.does-not-exist'], {}, root);
    expect(result.success).toBe(false);
    expect(fs.existsSync(path.join(root, '.forge', 'config.yaml'))).toBe(false);
  });

  test('rejects a missing/invalid action', async () => {
    const root = makeProject();
    expect((await gateCommand.handler([], {}, root)).success).toBe(false);
    expect((await gateCommand.handler(['toggle', 'gate.plan-exit'], {}, root)).success).toBe(false);
    expect((await gateCommand.handler(['disable'], {}, root)).success).toBe(false);
  });
});
