const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, expect, test } = require('bun:test');
const setupCommand = require('../lib/commands/setup');

const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-setup-assets-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('setup runtime assets', () => {
  test('runtime asset repair does not scaffold all agent assets in an uninitialized repo', () => {
    const tmpDir = makeTempDir();

    const result = setupCommand.repairWorkflowRuntimeAssets(tmpDir);

    expect(result).toEqual({
      attempted: false,
      agents: [],
      repaired: [],
      missing: [],
    });
    expect(fs.existsSync(path.join(tmpDir, 'scripts', 'smart-status.sh'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'scripts', 'greptile-resolve.sh'))).toBe(false);
  });
});
