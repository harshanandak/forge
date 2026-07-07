'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, expect, test } = require('bun:test');

const YAML = require('yaml');

const gateCommand = require('../../lib/commands/gate');
const optionsCommand = require('../../lib/commands/options');
const { getResolvedRuntimeGraph } = require('../../lib/core/runtime-graph');

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

  // rail.kernel_tracking is a default-ON, UNLOCKED rail toggled through the same
  // `forge gate enable|disable` surface as gates (zero new toggle code): the id is
  // known (validate against knownGates), disable writes workflow.gates.<id>.enabled,
  // and the shipped resolver flips the rail in the resolved graph.
  test('disable rail.kernel_tracking is accepted and flips the resolved rail off', async () => {
    const root = makeProject();

    const result = await gateCommand.handler(['disable', 'rail.kernel_tracking'], {}, root);
    expect(result.success).toBe(true);
    expect(readConfig(root).workflow.gates['rail.kernel_tracking'].enabled).toBe(false);

    const rail = getResolvedRuntimeGraph({ projectRoot: root })
      .rails.find(r => r.id === 'rail.kernel_tracking');
    expect(rail.enabled).toBe(false);
  });

  test('enable flips rail.kernel_tracking back on', async () => {
    const root = makeProject();
    await gateCommand.handler(['disable', 'rail.kernel_tracking'], {}, root);
    await gateCommand.handler(['enable', 'rail.kernel_tracking'], {}, root);
    const rail = getResolvedRuntimeGraph({ projectRoot: root })
      .rails.find(r => r.id === 'rail.kernel_tracking');
    expect(rail.enabled).toBe(true);
  });

  test('forge gate check reflects a disabled rail.kernel_tracking (satisfied)', async () => {
    const root = makeProject();
    await gateCommand.handler(['disable', 'rail.kernel_tracking'], {}, root);
    // A disabled rail is satisfied without any approval event — no kernel needed.
    const check = await gateCommand.handler(['check', 'issue-1', 'rail.kernel_tracking'], {}, root);
    expect(check.success).toBe(true);
    expect(check.output).toMatch(/disabled/);
  });
});
