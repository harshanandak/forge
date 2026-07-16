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

  test('MALFORMED config => enforce (true) EVEN when it embeds a disabled tdd_intent block', () => {
    // Security regression (T1): a broken file (unterminated flow sequence) that also
    // contains a `tdd_intent ... enabled: false` fragment must NOT switch the gate off
    // via the fuzzy raw-text scan. Parser presence is split from parse success, so a
    // YAML.parse error fails TOWARD enforcement — corrupt config keeps TDD ON. The
    // raw-text scan now runs ONLY when the yaml module is genuinely absent (issue eda6d866).
    writeConfig("rails:\n  tdd_intent:\n    enabled: false\nprotectedPaths: ['oops\n");
    expect(isTddEnabled(root)).toBe(true);
  });
});
