'use strict';

const { describe, expect, test, afterAll, setDefaultTimeout } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadOkfConfig, isOkfEnabled, setOkfEnabled } = require('../../lib/doc-gate/okf-config');

// Disk I/O on Windows CI can exceed the 5s default.
setDefaultTimeout(30000);

const createdDirs = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-okf-config-'));
  createdDirs.push(dir);
  return dir;
}
const cfgFile = dir => path.join(dir, '.forge', 'doc-gate.json');

afterAll(() => {
  for (const dir of createdDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('doc-gate okf toggle (.forge/doc-gate.json)', () => {
  test('status defaults to disabled when no config exists', () => {
    const dir = tmpDir();
    expect(isOkfEnabled(dir)).toBe(false);
    expect(loadOkfConfig(dir).okf.enabled).toBe(false);
    // Reading must not create the file.
    expect(fs.existsSync(cfgFile(dir))).toBe(false);
  });

  test('enable writes .forge/doc-gate.json {okf:{enabled:true}}', () => {
    const dir = tmpDir();
    setOkfEnabled(dir, true);
    expect(fs.existsSync(cfgFile(dir))).toBe(true);
    expect(JSON.parse(fs.readFileSync(cfgFile(dir), 'utf8'))).toEqual({ okf: { enabled: true } });
    expect(isOkfEnabled(dir)).toBe(true);
  });

  test('disable reverts enabled to false', () => {
    const dir = tmpDir();
    setOkfEnabled(dir, true);
    setOkfEnabled(dir, false);
    expect(isOkfEnabled(dir)).toBe(false);
    expect(JSON.parse(fs.readFileSync(cfgFile(dir), 'utf8'))).toEqual({ okf: { enabled: false } });
  });

  test('malformed config is treated as disabled (fail-safe), never throws', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, '.forge'));
    fs.writeFileSync(cfgFile(dir), '{ this is not json');
    expect(isOkfEnabled(dir)).toBe(false);
    expect(loadOkfConfig(dir).okf.enabled).toBe(false);
  });

  test('a non-object okf key is coerced to disabled', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, '.forge'));
    fs.writeFileSync(cfgFile(dir), JSON.stringify({ okf: 'yes' }));
    expect(isOkfEnabled(dir)).toBe(false);
  });

  test('toggling preserves unrelated top-level keys', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, '.forge'));
    fs.writeFileSync(cfgFile(dir), JSON.stringify({ other: 1, okf: { enabled: false } }));
    setOkfEnabled(dir, true);
    const cfg = JSON.parse(fs.readFileSync(cfgFile(dir), 'utf8'));
    expect(cfg.other).toBe(1);
    expect(cfg.okf.enabled).toBe(true);
  });

  test('refuses to write the config through a symlink', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, '.forge'));
    let linked = true;
    try {
      fs.symlinkSync(path.join(os.tmpdir(), 'forge-okf-evil-config'), cfgFile(dir));
    } catch { linked = false; }
    if (!linked) return; // platform without symlink perms
    expect(() => setOkfEnabled(dir, true)).toThrow(/symlink/i);
  });
});
