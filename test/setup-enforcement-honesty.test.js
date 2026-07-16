'use strict';

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// `forge setup` must describe what the installed hooks will ACTUALLY enforce given
// the resolved .forge/config.yaml — the hook scripts install unconditionally but are
// inert when their gate/rail is disabled, so setup must not over-claim (issue eda6d866).
const setup = require('../lib/commands/setup');

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
});
