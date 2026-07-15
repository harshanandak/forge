'use strict';

/**
 * `forge options gates` carries enforcement-locus badges (B6 / 724356ea).
 *
 * The all-surface read view must never imply enforcement a surface lacks, so
 * each gate item is decorated with the honest locus + badge derived from the
 * guarantee matrix (lib/control-plane.js). Human gates read PERMISSION, ordinary
 * gates read ENFORCED, and the badge string appears in the human render too.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, expect, test } = require('bun:test');

const optionsCommand = require('../../lib/commands/options');

const tempRoots = [];

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-options-badge-'));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('forge options gates — enforcement-locus badges', () => {
  test('--json decorates each gate with badge, locus, and surface', async () => {
    const root = makeProject();
    const result = await optionsCommand.handler(['gates', '--json'], {}, root);
    const items = JSON.parse(result.output).items;

    const planExit = items.find(g => g.id === 'gate.plan-exit');
    expect(planExit.badge).toBe('ENFORCED (gate)');
    expect(planExit.locus).toBe('run-time-deny (gate)');
    expect(planExit.surface).toBe('gate');

    const merge = items.find(g => g.id === 'gate.merge');
    expect(merge.badge).toBe('PERMISSION (human approval)');
    expect(merge.surface).toBe('human-gate');
  });

  test('human render includes the badge string', async () => {
    const root = makeProject();
    const result = await optionsCommand.handler(['gates'], {}, root);
    expect(result.output).toMatch(/ENFORCED \(gate\)/);
    expect(result.output).toMatch(/PERMISSION \(human approval\)/);
  });
});
