'use strict';

/**
 * `forge control` — tri-state control ONLY for gates/rails (B6 / 7dc59af2).
 *
 * The command reuses the exact resolver-enforced surface
 * (`workflow.gates.<id>.enabled`) that `forge gate` writes, so setting a state is
 * genuinely honored at run time (asserted via getResolvedRuntimeGraph). It
 * REFUSES mcp/rules/skills with the guarantee-matrix message rather than pretend
 * enforcement it cannot deliver. `status` renders the all-surface read with
 * enforcement-locus badges.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, expect, test } = require('bun:test');

const YAML = require('yaml');

const controlCommand = require('../../lib/commands/control');
const { getResolvedRuntimeGraph } = require('../../lib/core/runtime-graph');

const tempRoots = [];

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-control-'));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
  return root;
}

function readConfig(root) {
  return YAML.parse(fs.readFileSync(path.join(root, '.forge', 'config.yaml'), 'utf8'));
}

function configPath(root) {
  return path.join(root, '.forge', 'config.yaml');
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('forge control — set tri-state on gates/rails (reuses workflow.gates.<id>.enabled)', () => {
  // NOTE: these assert the resolved graph REFLECTS the config write (registry
  // reflection), NOT that anything denies on it — no runtime consumer reads
  // these flags to refuse today (see docs/reference/control-plane-guarantees.md).
  test('optional on a gate writes enabled=false AND the resolved registry reflects it', async () => {
    const root = makeProject();
    const result = await controlCommand.handler(['gate.plan-exit', 'optional'], {}, root);
    expect(result.success).toBe(true);
    expect(readConfig(root).workflow.gates['gate.plan-exit'].enabled).toBe(false);

    const gate = getResolvedRuntimeGraph({ projectRoot: root })
      .gates.find(g => g.id === 'gate.plan-exit');
    expect(gate.enabled).toBe(false);
  });

  test('mandatory flips the registry value back to enabled=true', async () => {
    const root = makeProject();
    await controlCommand.handler(['gate.plan-exit', 'optional'], {}, root);
    await controlCommand.handler(['gate.plan-exit', 'mandatory'], {}, root);
    const gate = getResolvedRuntimeGraph({ projectRoot: root })
      .gates.find(g => g.id === 'gate.plan-exit');
    expect(gate.enabled).toBe(true);
  });

  test('permission on a human gate writes enabled=true', async () => {
    const root = makeProject();
    const result = await controlCommand.handler(['gate.merge', 'permission'], {}, root);
    expect(result.success).toBe(true);
    expect(readConfig(root).workflow.gates['gate.merge'].enabled).toBe(true);
  });

  test('optional on rail.kernel_tracking flips the resolved-registry rail off', async () => {
    const root = makeProject();
    const result = await controlCommand.handler(['rail.kernel_tracking', 'optional'], {}, root);
    expect(result.success).toBe(true);
    const rail = getResolvedRuntimeGraph({ projectRoot: root })
      .rails.find(r => r.id === 'rail.kernel_tracking');
    expect(rail.enabled).toBe(false);
  });
});

describe('forge control — honest refusals (nothing written)', () => {
  test('mcp/rules/skills are refused with the guarantee-matrix pointer', async () => {
    const root = makeProject();
    for (const id of ['mcp.context7', 'rule.tdd', 'skill.plan']) {
      const result = await controlCommand.handler([id, 'mandatory'], {}, root);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/presence-only/i);
      expect(result.error).toMatch(/not enforceable/i);
      expect(result.error).toMatch(/control-plane-guarantees\.md/);
    }
    // Nothing was written for any advisory surface.
    expect(fs.existsSync(configPath(root))).toBe(false);
  });

  test('permission on a non-human gate is refused', async () => {
    const root = makeProject();
    const result = await controlCommand.handler(['gate.plan-exit', 'permission'], {}, root);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/human gate/i);
    expect(fs.existsSync(configPath(root))).toBe(false);
  });

  test('an unknown gate id is refused at write time (nothing written)', async () => {
    const root = makeProject();
    const result = await controlCommand.handler(['gate.does-not-exist', 'mandatory'], {}, root);
    expect(result.success).toBe(false);
    expect(fs.existsSync(configPath(root))).toBe(false);
  });

  test('an invalid state value is refused', async () => {
    const root = makeProject();
    const result = await controlCommand.handler(['gate.plan-exit', 'sometimes'], {}, root);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/mandatory|optional|permission/);
    expect(fs.existsSync(configPath(root))).toBe(false);
  });

  test('missing arguments show usage', async () => {
    const root = makeProject();
    expect((await controlCommand.handler([], {}, root)).success).toBe(false);
    expect((await controlCommand.handler(['gate.plan-exit'], {}, root)).success).toBe(false);
  });
});

describe('forge control status — all-surface read with enforcement-locus badges', () => {
  test('--json lists every controllable surface with badge + locus + state', async () => {
    const root = makeProject();
    const result = await controlCommand.handler(['status', '--json'], {}, root);
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output);
    const items = parsed.items ?? parsed;

    const planExit = items.find(i => i.id === 'gate.plan-exit');
    expect(planExit).toMatchObject({
      surface: 'gate',
      controllable: true,
      badge: 'DECLARED (no runtime consumer yet)',
      locus: 'registry — declared, not yet enforced',
      state: 'mandatory',
    });

    const merge = items.find(i => i.id === 'gate.merge');
    expect(merge).toMatchObject({
      surface: 'human-gate',
      badge: 'DENY-ON-CHECK',
    });
    expect(merge.locus).toMatch(/deny-on-check/);

    // Honesty invariant: the status view never badges any flag ENFORCED.
    for (const item of items) {
      expect(item.badge).not.toMatch(/ENFORCED/);
    }
  });

  test('status reflects a control change', async () => {
    const root = makeProject();
    await controlCommand.handler(['gate.plan-exit', 'optional'], {}, root);
    const result = await controlCommand.handler(['status', '--json'], {}, root);
    const items = JSON.parse(result.output).items;
    const planExit = items.find(i => i.id === 'gate.plan-exit');
    expect(planExit.state).toBe('optional');
    expect(planExit.badge).toBe('OFF (optional)');
  });

  test('human-readable status names the guarantee-matrix doc', async () => {
    const root = makeProject();
    const result = await controlCommand.handler(['status'], {}, root);
    expect(result.success).toBe(true);
    expect(result.output).toMatch(/control-plane-guarantees\.md/);
  });
});
