'use strict';

const { test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveRealGh } = require('../lib/native-gh');

test('native gh resolution skips a marked router using the supplied environment', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-native-gh-'));
  const routerDir = path.join(root, 'router');
  const nativeDir = path.join(root, 'native');
  fs.mkdirSync(routerDir);
  fs.mkdirSync(nativeDir);
  fs.writeFileSync(path.join(routerDir, 'gh'), '#!/bin/sh\n# forge-gh-router-v1\n', { mode: 0o755 });
  fs.writeFileSync(path.join(nativeDir, 'gh'), '#!/bin/sh\n', { mode: 0o755 });
  try {
    expect(resolveRealGh({
      platform: 'linux', env: { PATH: [routerDir, nativeDir].join(path.delimiter) }, ownPath: '/$bunfs/root/forge',
    }))
      .toBe(path.join(nativeDir, 'gh'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
