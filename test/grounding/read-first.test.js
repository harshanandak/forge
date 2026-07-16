'use strict';

// Unit coverage for the gate.read_first consultation (lib/grounding/read-first.js)
// and the P1 registration of rail.grounding + gate.read_first + gate.cite in the
// runtime graph. checkReadFirst is fail-closed: no context.loaded event for the
// issue this session/window -> a block result with the exact remedy command.
// rail.grounding OR gate.read_first disabled -> allow (logged).

const { describe, expect, test } = require('bun:test');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const { getDefaultRuntimeGraph, getResolvedRuntimeGraph } = require('../../lib/core/runtime-graph');
const { checkReadFirst, buildReadFirstBlockMessage } = require('../../lib/grounding/read-first');
const { recordContextLoaded } = require('../../lib/grounding/context-events');
const { buildMigratedKernelIssueDeps } = require('../../lib/kernel/cli-broker-factory');

const UNUSED_ROOT = '/unused-because-deps-are-injected';

async function freshKernel() {
  return buildMigratedKernelIssueDeps({ databasePath: ':memory:' });
}
async function seedIssue(kernel, id) {
  const res = await kernel.kernelBroker.runIssueOperation(
    'create', ['--id', id, '--title', 'unit', '--type', 'task'], { actor: 'seed', origin: 'test' },
  );
  expect(res.ok).toBe(true);
  return res.data.id;
}
function deps(kernel) {
  return { kernelBroker: kernel.kernelBroker, kernelDriver: kernel.kernelDriver };
}

describe('grounding primitive registration (runtime graph)', () => {
  test('rail.grounding is a default-ON, UNLOCKED master rail', () => {
    const graph = getDefaultRuntimeGraph();
    const rail = graph.rails.find(r => r.id === 'rail.grounding');
    expect(rail).toBeDefined();
    expect(rail.enabled).toBe(true);
    expect(rail.locked).toBe(false);
  });

  test('gate.read_first and gate.cite are default-ON, UNLOCKED, phase-less gates', () => {
    const graph = getDefaultRuntimeGraph();
    for (const id of ['gate.read_first', 'gate.cite']) {
      const gate = graph.gates.find(g => g.id === id);
      expect(gate).toBeDefined();
      expect(gate.enabled).toBe(true);
      expect(gate.locked).toBe(false);
      expect(gate.phase).toBeUndefined();
      expect(gate.requires).toEqual([]);
    }
  });

  test('workflow.gates toggles disable rail.grounding and gate.read_first (zero new toggle code)', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'forge-grounding-'));
    try {
      mkdirSync(path.join(root, '.forge'), { recursive: true });
      writeFileSync(
        path.join(root, '.forge', 'config.yaml'),
        'workflow:\n  gates:\n    gate.read_first:\n      enabled: false\n    rail.grounding:\n      enabled: false\n',
      );
      const graph = getResolvedRuntimeGraph({ projectRoot: root });
      expect(graph.gates.find(g => g.id === 'gate.read_first').enabled).toBe(false);
      expect(graph.rails.find(r => r.id === 'rail.grounding').enabled).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('checkReadFirst consultation (fail-closed)', () => {
  const graphOn = () => ({
    rails: [{ id: 'rail.grounding', enabled: true }],
    gates: [{ id: 'gate.read_first', enabled: true }],
  });

  test('blocks with the exact remedy command when the issue was never read', async () => {
    const kernel = await freshKernel();
    const issue = await seedIssue(kernel, 'rf-block');
    const block = await checkReadFirst(UNUSED_ROOT, issue, {
      ...deps(kernel), resolveRuntimeGraph: graphOn,
    });
    expect(block).not.toBeNull();
    expect(block.success).toBe(false);
    expect(block.exitCode).toBeGreaterThan(0);
    expect(block.error).toContain(`forge recap ${issue}`);
    expect(block.error).toContain('first');
  });

  test('allows after a context.loaded event exists for the issue in the window', async () => {
    const kernel = await freshKernel();
    const issue = await seedIssue(kernel, 'rf-allow');
    const now = '2026-07-16T12:00:00.000Z';
    await recordContextLoaded(UNUSED_ROOT, {
      issueId: issue, cmd: 'recap', env: { FORGE_ACTOR: 'alice' }, deps: deps(kernel), now,
    });
    const block = await checkReadFirst(UNUSED_ROOT, issue, {
      ...deps(kernel), resolveRuntimeGraph: graphOn, now,
    });
    expect(block).toBeNull();
  });

  test('rail.grounding disabled -> allow (returns null)', async () => {
    const kernel = await freshKernel();
    const issue = await seedIssue(kernel, 'rf-rail-off');
    const graphRailOff = () => ({
      rails: [{ id: 'rail.grounding', enabled: false }],
      gates: [{ id: 'gate.read_first', enabled: true }],
    });
    const block = await checkReadFirst(UNUSED_ROOT, issue, {
      ...deps(kernel), resolveRuntimeGraph: graphRailOff,
    });
    expect(block).toBeNull();
  });

  test('gate.read_first disabled -> allow (returns null)', async () => {
    const kernel = await freshKernel();
    const issue = await seedIssue(kernel, 'rf-gate-off');
    const graphGateOff = () => ({
      rails: [{ id: 'rail.grounding', enabled: true }],
      gates: [{ id: 'gate.read_first', enabled: false }],
    });
    const block = await checkReadFirst(UNUSED_ROOT, issue, {
      ...deps(kernel), resolveRuntimeGraph: graphGateOff,
    });
    expect(block).toBeNull();
  });

  test('buildReadFirstBlockMessage contains the copy-pastable remedy', () => {
    const msg = buildReadFirstBlockMessage('abc123');
    expect(msg).toContain('gate.read_first');
    expect(msg).toContain('forge recap abc123 first');
  });
});
