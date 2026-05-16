const { describe, expect, test, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const addCommand = require('../../lib/commands/add');

const tempRoots = [];

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-add-command-'));
  tempRoots.push(root);
  fs.writeFileSync(path.join(root, 'plugin.json'), '{"id":"local"}\n', 'utf8');
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('forge add command', () => {
  test('adds trusted local sources to forge.lock', async () => {
    const root = makeRepo();

    const result = await addCommand.handler(['./plugin.json', '--name', 'local'], {}, root);

    expect(result.success).toBe(true);
    expect(result.output).toContain('Added local');
    expect(fs.readFileSync(path.join(root, 'forge.lock'), 'utf8')).toContain('"name": "local"');
  });

  test('requires --allow-untrusted for remote locators', async () => {
    const root = makeRepo();

    const refused = await addCommand.handler(['https://example.com/plugin.tgz', '--name', 'remote'], {}, root);
    expect(refused.success).toBe(false);
    expect(refused.error).toContain('--allow-untrusted');

    const allowed = await addCommand.handler([
      'https://example.com/plugin.tgz',
      '--name',
      'remote',
      '--allow-untrusted',
    ], {}, root);
    expect(allowed.success).toBe(true);
    expect(allowed.output).toContain('untrusted source accepted');
  });

  test('parses flag values without treating them as the source', async () => {
    const root = makeRepo();

    const result = await addCommand.handler(['--name', 'local', './plugin.json'], {}, root);

    expect(result.success).toBe(true);
    expect(result.output).toContain('Added local');
    expect(fs.readFileSync(path.join(root, 'forge.lock'), 'utf8')).toContain('"source": "./plugin.json"');
  });
});
