'use strict';

// Name-matched regression test for lib/adapters/greptile-review-adapter.js.
// Guards the windowsHide fix (kernel issue 931e7924): the adapter's default git
// runner is reachable from the shepherd's review-thread reading, which runs in
// the detached background watcher on Windows. Without windowsHide:true every
// git call there flashes a console window. OS window behaviour can't be asserted
// cross-platform, so this is a structural check of the module's runner source.

const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');

describe('greptile-review-adapter git runner (issue 931e7924)', () => {
  test('default exec sets windowsHide on execFileSync', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'lib', 'adapters', 'greptile-review-adapter.js'),
      'utf8',
    );
    const callRe = /\bexecFileSync\s*\(\s*[^)\s]/g;
    let match;
    let sites = 0;
    while ((match = callRe.exec(source)) !== null) {
      sites += 1;
      const slice = source.slice(match.index, match.index + 400);
      expect(slice).toContain('windowsHide');
    }
    expect(sites).toBeGreaterThan(0);
  });
});
