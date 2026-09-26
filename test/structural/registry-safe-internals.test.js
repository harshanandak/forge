'use strict';

const { describe, expect, test } = require('bun:test');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const manifest = require('../../package.json');

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'bundledDependencies',
  'optionalDependencies',
  'peerDependencies',
];

function dependencyNames(value) {
  if (Array.isArray(value)) return value;
  return Object.keys(value || {});
}

describe('registry-safe internal runtimes', () => {
  test('publish manifest declares no @forge package in any dependency field', () => {
    for (const field of DEPENDENCY_FIELDS) {
      expect(dependencyNames(manifest[field]).filter((name) => name.startsWith('@forge/')))
        .toEqual([]);
    }
  });

  test.each(['contracts', 'memory', 'flow'])(
    '#forge/%s resolves the workspace implementation during repository development',
    (name) => {
      expect(require(`#forge/${name}`)).toBe(require(path.join(ROOT, 'packages', name)));
    },
  );
});
