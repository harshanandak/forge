const { describe, expect, test, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const addCommand = require('../../lib/commands/add');
const upgradeCommand = require('../../lib/commands/upgrade');

const tempRoots = [];

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-upgrade-command-'));
  tempRoots.push(root);
  fs.writeFileSync(path.join(root, 'AGENTS.md'), [
    '# Agents',
    '<!-- forge-anchor:stage.plan -->',
    'Plan instructions.',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(root, 'plugin.json'), '{"id":"local"}\n', 'utf8');
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('forge upgrade command', () => {
  test('dry-run consumes config, patch intent, and lock trust state without mutation', async () => {
    const root = makeRepo();
    await addCommand.handler(['./plugin.json', '--name', 'local'], {}, root);
    await addCommand.handler(['gh:owner/repo/plugin', '--name', 'remote', '--allow-untrusted'], {}, root);
    const beforeLog = fs.readFileSync(path.join(root, '.forge', 'log.jsonl'), 'utf8');

    const result = await upgradeCommand.handler(['--dry-run'], { dryRun: true }, root);

    expect(result.success).toBe(true);
    expect(result.output).toContain('Forge upgrade dry-run');
    expect(result.output).toContain('[PASS] Runtime config');
    expect(result.output).toContain('[PASS] Patch intent: 0 record(s), 0 orphan(s)');
    expect(result.output).toContain('[FAIL] Lock trust: 2 extension(s), 1 untrusted opt-in');
    expect(result.output).toContain('[WARN] remote: remote source integrity cannot be rechecked');
    expect(result.output).toContain('Non-scope: rollback snapshots and full restore are not implemented');
    expect(fs.readFileSync(path.join(root, '.forge', 'log.jsonl'), 'utf8')).toBe(beforeLog);
  });

  test('self-heal creates only missing safe metadata and is idempotent', async () => {
    const root = makeRepo();
    fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
    fs.rmSync(path.join(root, '.forge'), { recursive: true, force: true });

    const first = await upgradeCommand.handler(['--self-heal'], {}, root);

    expect(first.success).toBe(true);
    expect(first.output).toContain('Self-heal applied');
    expect(fs.existsSync(path.join(root, '.forge', 'log.jsonl'))).toBe(true);

    const second = await upgradeCommand.handler(['--self-heal'], {}, root);
    expect(second.success).toBe(true);
    expect(second.output).toContain('No self-heal actions needed');
  });

  test('self-heal reports integrity failures without repairing them', async () => {
    const root = makeRepo();
    await addCommand.handler(['./plugin.json', '--name', 'local'], {}, root);
    fs.writeFileSync(path.join(root, 'plugin.json'), '{"id":"tampered"}\n', 'utf8');

    const result = await upgradeCommand.handler(['--self-heal'], {}, root);

    expect(result.success).toBe(false);
    expect(result.output).toContain('[FAIL] local: integrity mismatch');
    expect(result.output).toContain('Self-heal refused unrecoverable lock integrity failure');
    expect(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8')).toContain('tampered');
  });
});
