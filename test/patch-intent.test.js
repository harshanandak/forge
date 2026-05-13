const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { afterEach, describe, expect, test } = require('bun:test');

const {
  buildUnifiedDiffFromRecords,
  discoverAnchors,
  loadPatchIntentConfig,
  loadPatchIntentRecords,
  recordPatchIntentFromDiff,
  resolvePatchIntentRecords,
} = require('../lib/patch-intent');

const tempRoots = [];

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-patch-intent-'));
  tempRoots.push(root);
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: root });
  return root;
}

function writeFile(root, relativePath, body) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, body, 'utf8');
}

function commitAll(root, message = 'baseline') {
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', message], { cwd: root, stdio: 'ignore' });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('patch intent records', () => {
  test('discovers stable anchors in managed files', () => {
    const root = makeRepo();
    writeFile(root, '.claude/commands/validate.md', [
      '# Validate',
      '',
      '<!-- forge-anchor:stage.validate -->',
      'Run checks.',
      '',
    ].join('\n'));

    const anchors = discoverAnchors(root);

    expect(anchors.get('stage.validate').path).toBe('.claude/commands/validate.md');
    expect(anchors.get('stage.validate').line).toBe(3);
  });

  test('records diff hunks with stable IDs and replaces existing patch.md blocks', () => {
    const root = makeRepo();
    writeFile(root, '.claude/commands/validate.md', [
      '# Validate',
      '',
      '<!-- forge-anchor:stage.validate -->',
      'Run checks.',
      '',
    ].join('\n'));
    commitAll(root);
    writeFile(root, '.claude/commands/validate.md', [
      '# Validate',
      '',
      '<!-- forge-anchor:stage.validate -->',
      'Run checks carefully.',
      '',
    ].join('\n'));

    const first = recordPatchIntentFromDiff(root, { now: new Date('2026-05-13T00:00:00Z') });
    const second = recordPatchIntentFromDiff(root, { now: new Date('2026-05-13T00:00:01Z') });
    const records = loadPatchIntentRecords(root).records;

    expect(first.records).toHaveLength(1);
    expect(second.records[0].id).toBe(first.records[0].id);
    expect(records).toHaveLength(1);
    expect(records[0].anchorId).toBe('stage.validate');
    expect(records[0].diff).toContain('Run checks carefully.');
  });

  test('round-trips record output back through git apply', () => {
    const root = makeRepo();
    writeFile(root, '.claude/commands/dev.md', [
      '# Dev',
      '',
      '<!-- forge-anchor:stage.dev -->',
      'Implement.',
      '',
    ].join('\n'));
    commitAll(root);
    writeFile(root, '.claude/commands/dev.md', [
      '# Dev',
      '',
      '<!-- forge-anchor:stage.dev -->',
      'Implement with tests.',
      '',
    ].join('\n'));
    const expectedDiff = execFileSync('git', ['diff', '--', '.claude/commands/dev.md'], {
      cwd: root,
      encoding: 'utf8',
    });

    const result = recordPatchIntentFromDiff(root);
    execFileSync('git', ['checkout', '--', '.claude/commands/dev.md'], { cwd: root });
    execFileSync('git', ['apply'], {
      cwd: root,
      input: buildUnifiedDiffFromRecords(result.records),
    });

    const actualDiff = execFileSync('git', ['diff', '--', '.claude/commands/dev.md'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(actualDiff).toBe(expectedDiff);
  });

  test('resolves record paths after a managed file rename', () => {
    const root = makeRepo();
    writeFile(root, 'old/validate.md', [
      '<!-- forge-anchor:stage.validate -->',
      'Run checks.',
      '',
    ].join('\n'));
    writeFile(root, '.forge/patch.md', [
      '# Forge Patch Intent',
      '',
      '<!-- forge-patch-intent:v1',
      'id: patch_stage_validate_example',
      'anchorId: stage.validate',
      'path: old/validate.md',
      'createdAt: 2026-05-13T00:00:00.000Z',
      'source: git-diff',
      'status: active',
      '-->',
      '```diff',
      'diff --git a/old/validate.md b/old/validate.md',
      '--- a/old/validate.md',
      '+++ b/old/validate.md',
      '@@ -1,2 +1,2 @@',
      ' <!-- forge-anchor:stage.validate -->',
      '-Run checks.',
      '+Run checks carefully.',
      '```',
      '<!-- /forge-patch-intent -->',
      '',
    ].join('\n'));
    fs.mkdirSync(path.join(root, 'new'), { recursive: true });
    fs.renameSync(path.join(root, 'old', 'validate.md'), path.join(root, 'new', 'validate.md'));

    const resolved = resolvePatchIntentRecords(root);

    expect(resolved.records[0].status).toBe('renamed');
    expect(resolved.records[0].currentPath).toBe('new/validate.md');
  });

  test('reports orphaned records when the target anchor is undeclared', () => {
    const root = makeRepo();
    writeFile(root, '.forge/patch.md', [
      '# Forge Patch Intent',
      '',
      '<!-- forge-patch-intent:v1',
      'id: patch_missing',
      'anchorId: stage.missing',
      'path: missing.md',
      'createdAt: 2026-05-13T00:00:00.000Z',
      'source: git-diff',
      'status: active',
      '-->',
      '```diff',
      'diff --git a/missing.md b/missing.md',
      '--- a/missing.md',
      '+++ b/missing.md',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '```',
      '<!-- /forge-patch-intent -->',
      '',
    ].join('\n'));

    const resolved = resolvePatchIntentRecords(root);

    expect(resolved.orphans).toHaveLength(1);
    expect(resolved.orphans[0].anchorId).toBe('stage.missing');
  });

  test('honors patchIntent config path, aliases, and disabled state', () => {
    const root = makeRepo();
    writeFile(root, '.forge/config.yaml', [
      'patchIntent:',
      '  path: .forge/custom-patch.md',
      '  anchorAliases:',
      '    stage.old: stage.new',
      '',
    ].join('\n'));
    writeFile(root, 'commands/new.md', '<!-- forge-anchor:stage.new -->\nNew anchor.\n');
    writeFile(root, '.forge/custom-patch.md', [
      '# Forge Patch Intent',
      '',
      '<!-- forge-patch-intent:v1',
      'id: patch_alias',
      'anchorId: stage.old',
      'path: commands/old.md',
      'createdAt: 2026-05-13T00:00:00.000Z',
      'source: git-diff',
      'status: active',
      '-->',
      '```diff',
      'diff --git a/commands/old.md b/commands/old.md',
      '--- a/commands/old.md',
      '+++ b/commands/old.md',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '```',
      '<!-- /forge-patch-intent -->',
      '',
    ].join('\n'));

    const config = loadPatchIntentConfig(root);
    const resolved = resolvePatchIntentRecords(root);

    expect(config.path).toBe('.forge/custom-patch.md');
    expect(resolved.records[0].resolvedAnchorId).toBe('stage.new');
    expect(resolved.records[0].currentPath).toBe('commands/new.md');

    writeFile(root, '.forge/config.yaml', 'patchIntent:\n  enabled: false\n');
    expect(() => recordPatchIntentFromDiff(root)).toThrow('disabled');
  });

  test('forge patch record --from-diff writes patch.md', () => {
    const root = makeRepo();
    writeFile(root, 'AGENTS.md', '# Agent\n');
    writeFile(root, '.claude/commands/ship.md', [
      '# Ship',
      '',
      '<!-- forge-anchor:stage.ship -->',
      'Create PR.',
      '',
    ].join('\n'));
    commitAll(root);
    writeFile(root, '.claude/commands/ship.md', [
      '# Ship',
      '',
      '<!-- forge-anchor:stage.ship -->',
      'Create PR with evidence.',
      '',
    ].join('\n'));

    const cli = path.join(__dirname, '..', 'bin', 'forge.js');
    const result = spawnSync(process.execPath, [cli, 'patch', 'record', '--from-diff', '--path', root], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Recorded 1 patch intent');
    expect(fs.readFileSync(path.join(root, '.forge', 'patch.md'), 'utf8')).toContain('stage.ship');
  });
});

