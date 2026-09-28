const { describe, test, expect, beforeAll, afterAll } = require('bun:test');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const packageJson = require('../package.json');

// Every user-facing entry script must enforce the runtime floor from
// lib/node-requirement.js. Published executables come from package.json `bin`;
// EXTRA_ENTRY_SCRIPTS lists shipped scripts users run directly. Each entry
// needs a work-doing argv here, so a new bin fails this test until it is gated.
const WORK_ARGS = {
  'bin/forge.js': ['status'],
  'bin/forge-preflight.js': ['status'],
  'bin/forge-cmd.js': ['status'],
};
const EXTRA_ENTRY_SCRIPTS = ['bin/forge-cmd.js'];

function entryScripts() {
  const bins = Object.values(packageJson.bin).map((file) => file.replace(/^\.\//, ''));
  return [...new Set([...bins, ...EXTRA_ENTRY_SCRIPTS])];
}

let tempDir;
let node22;
let bunEmulating22;

function writePreload(name, versionsPatch) {
  const file = path.join(tempDir, `${name}.cjs`);
  fs.writeFileSync(file, `Object.defineProperty(process, 'versions', {
  value: { ...process.versions, ...${JSON.stringify(versionsPatch)} },
  configurable: true,
});\n`);
  return file;
}

function run(preload, script, argv) {
  return spawnSync(process.platform === 'win32' ? 'node.exe' : 'node', ['-r', preload, path.join(repoRoot, script), ...argv], {
    cwd: tempDir,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, FORGE_SHEPHERD_DISABLE: '1', NO_COLOR: '1' },
  });
}

describe('every published entry script enforces the runtime floor', () => {
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-bin-gate-'));
    node22 = writePreload('node22', { node: '22.16.0' });
    bunEmulating22 = writePreload('bun', { node: '22.6.0', bun: '1.2.14' });
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('package.json bin covers the known executables', () => {
    expect(Object.keys(packageJson.bin).sort()).toEqual(['forge', 'forge-preflight', 'forge-workflow']);
    for (const script of entryScripts()) {
      expect(WORK_ARGS[script]).toBeDefined();
    }
  });

  for (const script of entryScripts()) {
    test(`${script} refuses Node 22 before doing work`, () => {
      const result = run(node22, script, WORK_ARGS[script]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Node.js 24+ required (current: v22.16.0)');
    }, 60000);

    test(`${script} accepts Bun reporting an emulated Node 22`, () => {
      const result = run(bunEmulating22, script, WORK_ARGS[script]);
      expect(result.stderr).not.toContain('Node.js 24+ required');
      expect(result.stderr).not.toContain('Bun 1.2+ required');
    }, 60000);
  }

  test('forge-preflight help stays exempt on Node 22', () => {
    const result = run(node22, 'bin/forge-preflight.js', ['--help']);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('Node.js 24+ required');
  }, 60000);
});
