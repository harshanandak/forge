'use strict';

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// `forge setup` must describe what the installed hooks will ACTUALLY enforce given
// the resolved .forge/config.yaml — the hook scripts install unconditionally but are
// inert when their gate/rail is disabled, so setup must not over-claim (issue eda6d866).
const setup = require('../lib/commands/setup');
const { renderAdoptionConfigYaml } = require('../lib/adoption-profiles');

let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-setup-honesty-'));
  fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeConfig(yaml) {
  fs.writeFileSync(path.join(root, '.forge', 'config.yaml'), yaml, 'utf8');
}

describe('describeHookEnforcement (honest resolved-state summary)', () => {
  test('no config → default enforcement is active', () => {
    const desc = setup.describeHookEnforcement(root);
    expect(desc).toContain('TDD gate: active');
  });

  test('empty protectedPaths → protected-path reported inert', () => {
    writeConfig('protectedPaths: []\n');
    const desc = setup.describeHookEnforcement(root);
    expect(desc).toMatch(/protected-path: disabled in config/);
  });

  test('configured protectedPaths → protected-path reported active with count', () => {
    writeConfig('protectedPaths:\n  - .forge/config.yaml\n  - AGENTS.md\n');
    const desc = setup.describeHookEnforcement(root);
    expect(desc).toMatch(/protected-path: active \(2 paths\)/);
  });

  test('minimal profile → describe reports the TDD gate disabled', () => {
    writeConfig(renderAdoptionConfigYaml('minimal'));
    const desc = setup.describeHookEnforcement(root);
    expect(desc).toMatch(/TDD gate: disabled/);
  });
});

describe('resolveHookEnforcementState (config-resolved hook state)', () => {
  test('minimal profile disables the TDD rail → tddActive false, resolved true', () => {
    writeConfig(renderAdoptionConfigYaml('minimal'));
    const state = setup.resolveHookEnforcementState(root);
    expect(state.tddActive).toBe(false);
    expect(state.resolved).toBe(true);
  });

  test('gate-disable shape (workflow.gates[rail.tdd_intent].enabled:false) → tddActive false', () => {
    writeConfig('workflow:\n  gates:\n    rail.tdd_intent:\n      enabled: false\n');
    const state = setup.resolveHookEnforcementState(root);
    expect(state.tddActive).toBe(false);
    expect(state.resolved).toBe(true);
  });

  test('full-profile shape (rails.tdd_intent.enabled:false) → tddActive false', () => {
    writeConfig('rails:\n  rail.tdd_intent:\n    enabled: false\n');
    const state = setup.resolveHookEnforcementState(root);
    expect(state.tddActive).toBe(false);
    expect(state.resolved).toBe(true);
  });

  test('no config → default enforcement on (tddActive true)', () => {
    const state = setup.resolveHookEnforcementState(root);
    expect(state.tddActive).toBe(true);
    expect(state.resolved).toBe(true);
  });

  test('corrupt YAML → fail TOWARD enforcement (tddActive true, resolved false)', () => {
    writeConfig('workflow:\n  gates:\n   : : : broken\n  - not valid yaml\n');
    const state = setup.resolveHookEnforcementState(root);
    expect(state.tddActive).toBe(true);
    expect(state.resolved).toBe(false);
  });

  test('flipping config true→false re-resolves without any reinstall', () => {
    writeConfig('rails:\n  rail.tdd_intent:\n    enabled: true\n');
    expect(setup.resolveHookEnforcementState(root).tddActive).toBe(true);
    writeConfig('rails:\n  rail.tdd_intent:\n    enabled: false\n');
    expect(setup.resolveHookEnforcementState(root).tddActive).toBe(false);
  });
});
