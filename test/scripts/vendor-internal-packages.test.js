'use strict';

const { expect, test } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCRIPT = path.resolve(__dirname, '../../scripts/vendor-internal-packages.js');

test('prepare cleans partial vendor output when a copy fails', () => {
  let cleanupCalls = 0;
  const fakeFs = {
    ...fs,
    cpSync() {
      throw new Error('injected copy failure');
    },
    rmSync() {
      cleanupCalls += 1;
    },
  };
  const source = fs.readFileSync(SCRIPT, 'utf8');
  const sandbox = {
    __dirname: path.dirname(SCRIPT),
    module: { exports: {} },
    process: { argv: ['node', SCRIPT, 'prepare'] },
    require(specifier) {
      if (specifier === 'node:fs') return fakeFs;
      if (specifier === 'node:path') return path;
      throw new Error(`unexpected require: ${specifier}`);
    },
  };

  expect(() => vm.runInNewContext(source, sandbox, { filename: SCRIPT }))
    .toThrow('injected copy failure');
  expect(cleanupCalls).toBe(2);
});
