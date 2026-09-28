const { describe, test, expect, beforeAll, afterAll } = require('bun:test');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const forgeBin = path.join(__dirname, '..', 'bin', 'forge.js');
let tempDir;

// Preload that makes the real Node process report a different runtime, so the
// CLI entrypoint gate is exercised on the actual dispatch path.
function writePreload(name, versionsPatch) {
  const file = path.join(tempDir, `${name}.cjs`);
  fs.writeFileSync(file, `Object.defineProperty(process, 'versions', {
  value: { ...process.versions, ...${JSON.stringify(versionsPatch)} },
  configurable: true,
});\n`);
  return file;
}

function runForge(preload, forgeArgs) {
  return spawnSync(process.platform === 'win32' ? 'node.exe' : 'node', ['-r', preload, forgeBin, ...forgeArgs], {
    cwd: tempDir,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, FORGE_SHEPHERD_DISABLE: '1', NO_COLOR: '1' },
  });
}

describe('CLI entrypoint runtime gate', () => {
  let node22;
  let bunEmulating22;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runtime-gate-'));
    node22 = writePreload('node22', { node: '22.16.0' });
    bunEmulating22 = writePreload('bun', { node: '22.6.0', bun: '1.2.14' });
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('Node 22 is refused before a registry command dispatches', () => {
    const result = runForge(node22, ['status']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Node.js 24+ required (current: v22.16.0)');
    expect(result.stderr).toContain('Upgrade Node.js');
  }, 60000);

  test('Node 22 is refused for profile setup that bypasses checkPrerequisites', () => {
    const result = runForge(node22, ['setup', '--minimal', '--dry-run']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Node.js 24+ required');
  }, 60000);

  test('--version and --help still work on Node 22', () => {
    for (const flag of [['--version'], ['-V'], ['status', '--version']]) {
      const version = runForge(node22, flag);
      expect(version.status).toBe(0);
      expect(version.stdout).toMatch(/Forge v\d/);
    }
    const help = runForge(node22, ['--help']);
    expect(help.status).toBe(0);
    expect(help.stderr).not.toContain('Node.js 24+ required');
  }, 60000);

  test('Bun reporting an emulated Node 22 is not refused', () => {
    const result = runForge(bunEmulating22, ['status']);
    expect(result.stderr).not.toContain('Node.js 24+ required');
    expect(result.stderr).not.toContain('Bun 1.2+ required');
  }, 60000);
});
