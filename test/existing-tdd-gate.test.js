'use strict';

/**
 * `forge setup` must DETECT a repo's pre-existing pre-commit TDD / source-test coupling
 * gate and DEFER to it instead of silently stacking Forge's own `rail.tdd_intent` gate on
 * top — the in-the-wild beta.3 adoption report (kernel 5b425a85, predecessor 2699b234):
 * "TWO TDD gates firing on the same commit ... no detection/reconciliation".
 *
 * Detection is by MECHANISM (whatever pre-commit runner is actually installed), not by a
 * hardcoded filename list, and the deferral must be VISIBLE — never a silent skip.
 */

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  detectExistingTddGate,
  describeExistingGateDeferral,
} = require('../lib/existing-tdd-gate');
const {
  FORGE_USER_LEFTHOOK_YML,
  FORGE_USER_LEFTHOOK_YML_NO_TDD,
  installNativeGitHooks,
} = require('../lib/lefthook-wiring');
const setup = require('../lib/commands/setup');

let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-tdd-gate-detect-'));
  fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(relative, content) {
  const abs = path.join(root, relative);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

// A minimal real `.git` directory so resolveGitHooksDir() resolves without a git spawn.
function initGitDir() {
  fs.mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true });
}

describe('detectExistingTddGate — finds a pre-existing coupling/TDD gate by mechanism', () => {
  test('lefthook.yml pre-commit running a source/test coupling script is detected', () => {
    write('lefthook.yml', [
      'pre-commit:',
      '  commands:',
      '    coupling:',
      '      run: node scripts/check-source-test-coupling.mjs',
    ].join('\n'));

    const detection = detectExistingTddGate(root);

    expect(detection.found).toBe(true);
    expect(detection.source).toContain('lefthook.yml');
    expect(detection.command).toContain('check-source-test-coupling.mjs');
  });

  test('husky pre-commit running a TDD check is detected', () => {
    write('.husky/pre-commit', '#!/bin/sh\nnpm run tdd-check\n');

    const detection = detectExistingTddGate(root);

    expect(detection.found).toBe(true);
    expect(detection.source).toContain('.husky/pre-commit');
  });

  test('a native .git/hooks/pre-commit coupling gate is detected', () => {
    initGitDir();
    write('.git/hooks/pre-commit', '#!/bin/sh\nnode tools/require-tests.js || exit 1\n');

    const detection = detectExistingTddGate(root);

    expect(detection.found).toBe(true);
    expect(detection.source).toContain('pre-commit');
  });

  test('.pre-commit-config.yaml hook entry enforcing tests is detected', () => {
    write('.pre-commit-config.yaml', [
      'repos:',
      '  - repo: local',
      '    hooks:',
      '      - id: tdd-guard',
      '        name: TDD guard',
      '        entry: python tools/tdd_guard.py',
    ].join('\n'));

    const detection = detectExistingTddGate(root);

    expect(detection.found).toBe(true);
  });
});

describe('detectExistingTddGate — does not over-trigger', () => {
  test('a repo with no pre-commit mechanism at all → nothing detected', () => {
    expect(detectExistingTddGate(root).found).toBe(false);
  });

  test("a pre-commit that is NOT a TDD/coupling gate (formatting) → nothing detected", () => {
    write('lefthook.yml', [
      'pre-commit:',
      '  commands:',
      '    format:',
      '      run: npx prettier --write {staged_files}',
    ].join('\n'));

    expect(detectExistingTddGate(root).found).toBe(false);
  });

  // Re-run safety: Forge's OWN gate must never be mistaken for a pre-existing third-party
  // gate, or a second `forge setup` would defer to the gate it installed on the first run.
  test("Forge's own check-tdd.js pre-commit job is NOT counted as a pre-existing gate", () => {
    write('lefthook.yml', FORGE_USER_LEFTHOOK_YML);

    expect(detectExistingTddGate(root).found).toBe(false);
  });

  // Real shape from Forge's OWN dev lefthook.yml: the job NAME (`tdd-check`) matches the
  // classifier, but the command it runs is Forge's own gate — exclusion must win.
  test("a job NAMED like a TDD check but RUNNING Forge's own gate is not counted", () => {
    write('lefthook.yml', [
      'pre-commit:',
      '  commands:',
      '    tdd-check:',
      '      run: node .forge/hooks/check-tdd.js',
      '      tags: tdd',
    ].join('\n'));

    expect(detectExistingTddGate(root).found).toBe(false);
  });

  test("Forge's own native pre-commit hook is NOT counted as a pre-existing gate", () => {
    initGitDir();
    write('lefthook.yml', FORGE_USER_LEFTHOOK_YML);
    installNativeGitHooks(root);

    expect(detectExistingTddGate(root).found).toBe(false);
  });
});

describe('detectExistingTddGate — unknown content falls to the SAFE side (defer, not stack)', () => {
  test('an unparseable lefthook config with a pre-commit section defers rather than stacks', () => {
    write('lefthook.yml', 'pre-commit:\n  commands:\n   :::not: valid: yaml: [\n');

    const detection = detectExistingTddGate(root);

    expect(detection.found).toBe(true);
    expect(detection.unknown).toBe(true);
  });
});

describe('describeExistingGateDeferral — the deferral must be VISIBLE', () => {
  test('report names what was detected, what was NOT installed, and how to opt in', () => {
    write('lefthook.yml', [
      'pre-commit:',
      '  commands:',
      '    coupling:',
      '      run: node scripts/check-source-test-coupling.mjs',
    ].join('\n'));

    const report = describeExistingGateDeferral(detectExistingTddGate(root));

    expect(report).toContain('check-source-test-coupling.mjs'); // what was detected
    expect(report).toMatch(/did not install|not installed|deferred/i); // what Forge did NOT do
    expect(report).toContain('forge gate enable rail.tdd_intent'); // the one-line opt-in
  });
});

describe('deferral wiring — no second pre-commit TDD gate is installed', () => {
  test('the deferred lefthook.yml keeps pre-push but carries NO Forge TDD pre-commit job', () => {
    expect(FORGE_USER_LEFTHOOK_YML).toContain('check-tdd.js'); // baseline: the normal config wires it
    expect(FORGE_USER_LEFTHOOK_YML_NO_TDD).not.toContain('check-tdd.js');
    expect(FORGE_USER_LEFTHOOK_YML_NO_TDD).toContain('pre-push');
  });

  test('installNativeGitHooks can skip pre-commit so the repo keeps its own gate alone', () => {
    initGitDir();

    const result = installNativeGitHooks(root, { skipHooks: ['pre-commit'] });

    expect(result.written).not.toContain('pre-commit');
    expect(result.written).toContain('pre-push');
    expect(fs.existsSync(path.join(root, '.git', 'hooks', 'pre-commit'))).toBe(false);
  });

  test('applying the deferral makes rail.tdd_intent resolve as inactive (no double gate)', () => {
    write('lefthook.yml', [
      'pre-commit:',
      '  commands:',
      '    coupling:',
      '      run: node scripts/check-source-test-coupling.mjs',
    ].join('\n'));

    expect(setup.resolveHookEnforcementState(root).tddActive).toBe(true); // default-ON baseline

    setup.applyExistingGateDeferral(root, detectExistingTddGate(root));

    expect(setup.resolveHookEnforcementState(root).tddActive).toBe(false);
  });

  test('a repo with NO existing gate keeps rail.tdd_intent default-ON (untouched)', () => {
    setup.applyExistingGateDeferral(root, detectExistingTddGate(root));

    expect(setup.resolveHookEnforcementState(root).tddActive).toBe(true);
  });

  // The user already chose Forge's gate despite having their own — a re-run of `forge setup`
  // must not undo it, or the `forge gate enable rail.tdd_intent` we advertise would not stick.
  test('an explicit rail.tdd_intent choice survives the deferral', () => {
    write('lefthook.yml', 'pre-commit:\n  commands:\n    c:\n      run: node scripts/check-source-test-coupling.mjs\n');
    write('.forge/config.yaml', 'workflow:\n  gates:\n    rail.tdd_intent:\n      enabled: true\n');

    const result = setup.applyExistingGateDeferral(root, detectExistingTddGate(root));

    expect(result.deferred).toBe(false);
    expect(result.reason).toBe('explicit-user-choice');
    expect(setup.resolveHookEnforcementState(root).tddActive).toBe(true);
  });
});

// The adopter's reported symptom, end to end (kernel 5b425a85): a repo whose husky pre-commit
// already runs its own coupling gate must NOT come out of `forge setup` with a second one.
describe('installGitHooks — adopter repo with a pre-existing coupling gate', () => {
  let savedRoot;

  beforeEach(() => {
    savedRoot = setup._getState().projectRoot;
    fs.mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true });
    write('.husky/pre-commit', '#!/bin/sh\nnode scripts/check-source-test-coupling.mjs\n');
    setup._setState({ projectRoot: root });
  });

  afterEach(() => {
    setup._setState({ projectRoot: savedRoot });
  });

  test('defers visibly instead of stacking a second TDD gate', () => {
    const messages = [];
    const restore = [console.log, console.warn, console.info, console.error];
    console.log = console.warn = console.info = console.error = (...args) => messages.push(args.join(' '));
    try {
      setup.installGitHooks();
    } finally {
      [console.log, console.warn, console.info, console.error] = restore;
    }
    const output = messages.join('\n');

    // Visible: the adopter can see what was detected and how to choose Forge's gate instead.
    expect(output).toContain('check-source-test-coupling.mjs');
    expect(output).toContain('forge gate enable rail.tdd_intent');

    // Not stacked: Forge's gate is inert and no Forge pre-commit hook was wired.
    expect(setup.resolveHookEnforcementState(root).tddActive).toBe(false);
    expect(fs.existsSync(path.join(root, '.git', 'hooks', 'pre-commit'))).toBe(false);
    const lefthookYml = path.join(root, 'lefthook.yml');
    if (fs.existsSync(lefthookYml)) {
      expect(fs.readFileSync(lefthookYml, 'utf8')).not.toContain('check-tdd.js');
    }

    // The adopter's own gate is untouched.
    expect(fs.readFileSync(path.join(root, '.husky', 'pre-commit'), 'utf8'))
      .toContain('check-source-test-coupling.mjs');
  });

  // Qodo finding on PR #458: the wiring was keyed off `existingGate.found` while the config
  // write was keyed off the deferral, so a user who explicitly chose Forge's gate got config
  // saying "enabled" and no hook installed — making `forge gate enable rail.tdd_intent` a
  // no-op in exactly the repos this feature exists for.
  test('an explicit rail.tdd_intent choice still gets Forge hook wiring installed', () => {
    write('.forge/config.yaml', 'workflow:\n  gates:\n    rail.tdd_intent:\n      enabled: true\n');

    const messages = [];
    const restore = [console.log, console.warn, console.info, console.error];
    console.log = console.warn = console.info = console.error = (...args) => messages.push(args.join(' '));
    try {
      setup.installGitHooks();
    } finally {
      [console.log, console.warn, console.info, console.error] = restore;
    }
    const output = messages.join('\n');

    // Config and wiring must agree: the gate stays enabled AND the job is actually wired.
    expect(setup.resolveHookEnforcementState(root).tddActive).toBe(true);
    const lefthookYml = path.join(root, 'lefthook.yml');
    if (fs.existsSync(lefthookYml)) {
      expect(fs.readFileSync(lefthookYml, 'utf8')).toContain('check-tdd.js');
    }

    // And we must not claim a deferral that did not happen.
    expect(output).not.toContain('Forge did NOT install its own TDD gate');
    expect(output).toContain('did NOT defer');
  });

  // Qodo finding on PR #458: setConfigOverride was unguarded, so a malformed .forge/config.yaml
  // made `forge setup` fail outright purely because an existing gate was detected.
  test('a malformed .forge/config.yaml does not make the deferral throw', () => {
    write('.forge/config.yaml', 'workflow:\n  gates:\n   : : not: valid: yaml: [\n');

    let result;
    expect(() => {
      result = setup.applyExistingGateDeferral(root, detectExistingTddGate(root));
    }).not.toThrow();
    expect(result.deferred).toBe(false);
    expect(result.reason).toBe('config-write-failed');
  });
});
