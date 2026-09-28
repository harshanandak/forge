// Structural guard for CodeQL js/shell-command-injection-from-environment (#134).
// The marker test must never hand bash a command string (`bash -c ...`): CodeQL
// models every `-c` argument as shell input derived from absolute paths. The
// fake-git runs go through committed wrapper scripts instead.

import { describe, expect, test } from 'bun:test';
const fs = require('node:fs');
const path = require('node:path');

const MARKER_TEST = path.join(__dirname, 'setup-fixtures-marker.test.js');
const WRAPPERS = ['with-fake-git.sh', 'make-fake-git.sh'];

describe('setup-fixtures-marker.test.js shell usage', () => {
  const source = fs.readFileSync(MARKER_TEST, 'utf8');

  test('never passes a -c command string to bash', () => {
    expect(source).not.toMatch(/['"`]-c['"`]/);
  });

  for (const name of WRAPPERS) {
    test(`runs through the committed ${name} script`, () => {
      expect(fs.existsSync(path.join(__dirname, name))).toBe(true);
      expect(source).toContain(`'${name}'`);
    });
  }
});
