'use strict';

const { describe, test, expect } = require('bun:test');
const {
  buildGates,
  lintableFiles,
  runEslint,
  runSonar,
  runAffectedTests,
} = require('../../lib/preflight/gates');

describe('lintableFiles', () => {
  test('keeps js/mjs/cjs, drops others and node_modules', () => {
    const out = lintableFiles([
      'lib/a.js', 'scripts/b.mjs', 'x.cjs',
      'README.md', 'data.json', 'node_modules/pkg/index.js',
    ]);
    expect(out).toEqual(['lib/a.js', 'scripts/b.mjs', 'x.cjs']);
  });
});

describe('buildGates — composition', () => {
  const deps = {
    eslint: (files) => ({ ok: true, summary: `lint:${JSON.stringify(files)}` }),
    structural: () => ({ ok: true, summary: 'structural' }),
    sonar: (files) => ({ ok: true, summary: `sonar:${JSON.stringify(files)}` }),
    affected: () => ({ ok: true, summary: 'affected' }),
  };

  test('produces the four gates in the required order', () => {
    const gates = buildGates({ projectRoot: '/x', changedFiles: [], deps });
    expect(gates.map((g) => g.name)).toEqual([
      'lint',
      'drift/registry/mirror',
      'sonar (cognitive-complexity=15)',
      'affected-tests',
    ]);
  });

  test('each gate delegates to its injected sub-runner', async () => {
    const gates = buildGates({ projectRoot: '/x', changedFiles: ['lib/a.js'], deps });
    const outcomes = await Promise.all(gates.map((g) => g.run()));
    expect(outcomes[0].summary).toBe('lint:["lib/a.js"]');
    expect(outcomes[1].summary).toBe('structural');
    expect(outcomes[2].summary).toBe('sonar:["lib/a.js"]');
    expect(outcomes[3].summary).toBe('affected');
  });

  test('changed-file mode passes changedFiles to lint; --all passes null (lint everything)', async () => {
    const changed = ['lib/a.js'];
    const scoped = buildGates({ projectRoot: '/x', changedFiles: changed, deps });
    expect((await scoped[0].run()).summary).toBe('lint:["lib/a.js"]');

    const all = buildGates({ projectRoot: '/x', changedFiles: changed, runAll: true, deps });
    expect((await all[0].run()).summary).toBe('lint:null');
  });
});

describe('runEslint — real runner (injected spawn)', () => {
  test('no changed JS files → passes without spawning', () => {
    let called = false;
    const spawn = () => { called = true; return { status: 0 }; };
    const res = runEslint(['README.md'], { projectRoot: '/x', spawn });
    expect(res.ok).toBe(true);
    expect(called).toBe(false);
  });

  test('spawns eslint with --max-warnings 0 and the target files; maps exit status', () => {
    const calls = [];
    const spawn = (cmd, args) => { calls.push({ cmd, args }); return { status: 1 }; };
    const res = runEslint(['lib/a.js', 'lib/b.js'], { projectRoot: '/x', spawn });
    expect(res.ok).toBe(false);
    const args = calls[0].args;
    expect(args).toContain('--max-warnings');
    expect(args).toContain('0');
    expect(args).toContain('lib/a.js');
    expect(args).toContain('lib/b.js');
  });

  test('null files (lint-all) targets the whole tree', () => {
    const calls = [];
    const spawn = (cmd, args) => { calls.push(args); return { status: 0 }; };
    const res = runEslint(null, { projectRoot: '/x', spawn });
    expect(res.ok).toBe(true);
    expect(calls[0]).toContain('.');
  });
});

describe('runSonar — real runner (injected spawn)', () => {
  test('runs eslint with the isolated sonar config and pinned rules on changed files', () => {
    const calls = [];
    const spawn = (cmd, args) => { calls.push(args); return { status: 0 }; };
    const res = runSonar(['lib/a.js'], { projectRoot: '/x', spawn });
    expect(res.ok).toBe(true);
    const args = calls[0];
    expect(args.join(' ')).toContain('--config');
    expect(args.some((a) => String(a).includes('sonar'))).toBe(true);
    expect(args).toContain('lib/a.js');
  });

  test('no changed JS files → skip-pass without spawning', () => {
    let called = false;
    const spawn = () => { called = true; return { status: 0 }; };
    const res = runSonar([], { projectRoot: '/x', spawn });
    expect(res.ok).toBe(true);
    expect(called).toBe(false);
  });
});

describe('runAffectedTests — real runner (injected)', () => {
  test('no affected tests → fast-lane pass without spawning', () => {
    let called = false;
    const spawn = () => { called = true; return { status: 0 }; };
    const res = runAffectedTests({
      projectRoot: '/x',
      changedFiles: [],
      spawn,
      resolveTests: () => [],
    });
    expect(res.ok).toBe(true);
    expect(called).toBe(false);
  });

  test('affected tests resolved → runs them and maps status', () => {
    const calls = [];
    const spawn = (cmd, args) => { calls.push({ cmd, args }); return { status: 0 }; };
    const res = runAffectedTests({
      projectRoot: '/x',
      changedFiles: ['lib/a.js'],
      spawn,
      resolveTests: () => ['test/a.test.js'],
    });
    expect(res.ok).toBe(true);
    expect(calls[0].args).toContain('test/a.test.js');
  });
});
