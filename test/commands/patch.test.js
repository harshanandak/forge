const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { afterEach, describe, expect, test } = require('bun:test');

const patchCommand = require('../../lib/commands/patch');

const tempRoots = [];

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-patch-command-'));
  tempRoots.push(root);
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: root });
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Agent\n', 'utf8');
  fs.mkdirSync(path.join(root, '.claude', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'commands', 'patch.md'), [
    '# Patch',
    '',
    '<!-- forge-anchor:stage.patch -->',
    'Original.',
    '',
  ].join('\n'), 'utf8');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'baseline'], { cwd: root, stdio: 'ignore' });
  fs.writeFileSync(path.join(root, '.claude', 'commands', 'patch.md'), [
    '# Patch',
    '',
    '<!-- forge-anchor:stage.patch -->',
    'Changed.',
    '',
  ].join('\n'), 'utf8');
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('forge patch command', () => {
  test('record --from-diff reports written patch intent records', async () => {
    const projectRoot = makeRepo();

    const result = await patchCommand.handler(['record', '--from-diff'], {}, projectRoot);

    expect(result.success).toBe(true);
    expect(result.output).toContain('Recorded 1 patch intent');
    expect(result.output).toContain('stage.patch');
  });

  test('record requires --from-diff', async () => {
    const result = await patchCommand.handler(['record'], {}, process.cwd());

    expect(result.success).toBe(false);
    expect(result.error).toContain('Missing --from-diff');
  });
});

