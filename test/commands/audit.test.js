const { describe, expect, test, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const addCommand = require('../../lib/commands/add');
const auditCommand = require('../../lib/commands/audit');

const tempRoots = [];

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-audit-command-'));
  tempRoots.push(root);
  fs.writeFileSync(path.join(root, 'plugin.json'), '{"id":"local"}\n', 'utf8');
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('forge audit command', () => {
  test('verifies lockfile integrity hashes', async () => {
    const root = makeRepo();
    await addCommand.handler(['./plugin.json', '--name', 'local'], {}, root);

    const clean = await auditCommand.handler(['verify'], {}, root);
    expect(clean.success).toBe(true);
    expect(clean.output).toContain('[PASS] local');

    fs.writeFileSync(path.join(root, 'plugin.json'), '{"id":"tampered"}\n', 'utf8');
    const tampered = await auditCommand.handler(['verify'], {}, root);
    expect(tampered.success).toBe(false);
    expect(tampered.output).toContain('[FAIL] local');
    expect(tampered.error).toBe(tampered.output);
  });

  test('reports malformed lockfiles as structured failures', async () => {
    const root = makeRepo();
    fs.writeFileSync(path.join(root, 'forge.lock'), '{not json', 'utf8');

    const result = await auditCommand.handler(['verify'], {}, root);

    expect(result.success).toBe(false);
    expect(result.error).toContain('JSON');
    expect(result.output).toBeUndefined();
  });
});
