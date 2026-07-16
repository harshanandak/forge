'use strict';

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The self-contained pre-commit TDD gate (.forge/hooks/check-tdd.js) must be INERT
// when the TDD rail is disabled in .forge/config.yaml (issue eda6d866). A minimal /
// all-disabled profile means no active enforcement — the hook reads config at run time.
const { isTddEnabled } = require('../.forge/hooks/check-tdd.js');

let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-checktdd-'));
  fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeConfig(yaml) {
  fs.writeFileSync(path.join(root, '.forge', 'config.yaml'), yaml, 'utf8');
}

describe('isTddEnabled (config-honest pre-commit gate)', () => {
  test('no config file => enforce (true)', () => {
    expect(isTddEnabled(root)).toBe(true);
  });

  test('empty config => enforce (true)', () => {
    writeConfig('');
    expect(isTddEnabled(root)).toBe(true);
  });

  test('rail.tdd_intent disabled via workflow.gates => inert (false)', () => {
    writeConfig('workflow:\n  gates:\n    "rail.tdd_intent":\n      enabled: false\n');
    expect(isTddEnabled(root)).toBe(false);
  });

  test('top-level rails.tdd_intent disabled => inert (false)', () => {
    writeConfig('rails:\n  tdd_intent:\n    enabled: false\n');
    expect(isTddEnabled(root)).toBe(false);
  });

  test('rail.tdd_intent explicitly enabled => enforce (true)', () => {
    writeConfig('workflow:\n  gates:\n    "rail.tdd_intent":\n      enabled: true\n');
    expect(isTddEnabled(root)).toBe(true);
  });

  test('unrelated gates disabled => TDD still enforced (true)', () => {
    writeConfig('workflow:\n  gates:\n    "gate.plan-exit":\n      enabled: false\n');
    expect(isTddEnabled(root)).toBe(true);
  });

  test('unparseable config => FAILS TOWARD enforcement (true) via raw-scan fallback', () => {
    // An unterminated flow sequence makes YAML.parse throw, so isTddEnabled falls to
    // the conservative raw-text scan. The corrupt text has no `rail.tdd_intent`/
    // `tdd_intent` block with `enabled: false`, so the gate a user did not disable is
    // never silently dropped — corrupt config keeps TDD ON (issue eda6d866).
    writeConfig("protectedPaths: ['.forge/config.yaml'\n");
    expect(isTddEnabled(root)).toBe(true);
  });
});
