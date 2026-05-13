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
  writePatchIntentRecords,
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

  test('fails fast when duplicate anchor IDs are declared', () => {
    const root = makeRepo();
    writeFile(root, 'one.md', '<!-- forge-anchor:stage.validate -->\nOne.\n');
    writeFile(root, 'two.md', '<!-- forge-anchor:stage.validate -->\nTwo.\n');

    expect(() => discoverAnchors(root)).toThrow('Duplicate forge anchor');
  });

  test('ignores anchor examples inside markdown fences', () => {
    const root = makeRepo();
    writeFile(root, 'docs/reference/patch-md-format.md', [
      '# Patch format',
      '',
      '```md',
      '<!-- forge-anchor:stage.validate -->',
      '<!-- forge-anchor:stage.validate -->',
      '```',
      '',
      '<!-- forge-anchor:docs.patch-format -->',
      'Reference text.',
      '',
    ].join('\n'));

    const anchors = discoverAnchors(root);

    expect(anchors.has('stage.validate')).toBe(false);
    expect(anchors.get('docs.patch-format').path).toBe('docs/reference/patch-md-format.md');
  });

  test('tracks markdown fence delimiters by marker and length', () => {
    const root = makeRepo();
    writeFile(root, 'docs/reference/patch-md-format.md', [
      '# Patch format',
      '',
      '````md',
      '<!-- forge-anchor:stage.validate -->',
      '```',
      '<!-- forge-anchor:stage.validate -->',
      '```',
      '````',
      '',
      '<!-- forge-anchor:docs.patch-format -->',
      'Reference text.',
      '',
    ].join('\n'));

    const anchors = discoverAnchors(root);

    expect(anchors.has('stage.validate')).toBe(false);
    expect(anchors.get('docs.patch-format').path).toBe('docs/reference/patch-md-format.md');
  });

  test('ignores inline code anchor examples', () => {
    const root = makeRepo();
    writeFile(root, 'docs/work/decisions.md', [
      'Use `<!-- forge-anchor:stage.validate -->` as an example.',
      '',
      '<!-- forge-anchor:docs.decisions -->',
      'Decision text.',
      '',
    ].join('\n'));

    const anchors = discoverAnchors(root);

    expect(anchors.has('stage.validate')).toBe(false);
    expect(anchors.get('docs.decisions').path).toBe('docs/work/decisions.md');
  });

  test('ignores anchor literals in source and test fixtures', () => {
    const root = makeRepo();
    writeFile(root, 'commands/validate.md', '<!-- forge-anchor:stage.validate -->\nRun checks.\n');
    writeFile(root, 'test/patch-intent.test.js', [
      "const fixture = '<!-- forge-anchor:stage.validate -->';",
      "const other = '<!-- forge-anchor:fixture.only -->';",
      '',
    ].join('\n'));

    const anchors = discoverAnchors(root);

    expect(anchors.get('stage.validate').path).toBe('commands/validate.md');
    expect(anchors.has('fixture.only')).toBe(false);
  });

  test('ignores fenced markdown anchors while attributing diff hunks', () => {
    const root = makeRepo();
    writeFile(root, 'docs/tool.md', [
      '<!-- forge-anchor:stage.real -->',
      'Intro text.',
      '',
      '```md',
      '<!-- forge-anchor:stage.example -->',
      'old fenced text',
      '```',
      '',
    ].join('\n'));
    commitAll(root);
    writeFile(root, 'docs/tool.md', [
      '<!-- forge-anchor:stage.real -->',
      'Intro text.',
      '',
      '```md',
      '<!-- forge-anchor:stage.example -->',
      'new fenced text',
      '```',
      '',
    ].join('\n'));

    const result = recordPatchIntentFromDiff(root);

    expect(result.records).toHaveLength(1);
    expect(result.records[0].anchorId).toBe('stage.real');
    expect(result.records[0].diff).toContain('new fenced text');
  });

  test('does not treat txt fence markers as markdown fences during attribution', () => {
    const root = makeRepo();
    writeFile(root, 'notes.txt', [
      '```',
      '<!-- forge-anchor:txt.real -->',
      'Old text.',
      '',
    ].join('\n'));
    commitAll(root);
    writeFile(root, 'notes.txt', [
      '```',
      '<!-- forge-anchor:txt.real -->',
      'New text.',
      '',
    ].join('\n'));

    const result = recordPatchIntentFromDiff(root);

    expect(result.records).toHaveLength(1);
    expect(result.records[0].anchorId).toBe('txt.real');
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

  test('records managed files with spaces in their diff paths', () => {
    const root = makeRepo();
    writeFile(root, 'a b/c.md', [
      '<!-- forge-anchor:docs.space -->',
      'Old text.',
      '',
    ].join('\n'));
    commitAll(root);
    writeFile(root, 'a b/c.md', [
      '<!-- forge-anchor:docs.space -->',
      'New text.',
      '',
    ].join('\n'));

    const result = recordPatchIntentFromDiff(root);

    expect(result.records).toHaveLength(1);
    expect(result.records[0].path).toBe('a b/c.md');
    expect(result.records[0].anchorId).toBe('docs.space');
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

  test('parses CRLF patch intent record files', () => {
    const root = makeRepo();
    writeFile(root, '.forge/patch.md', [
      '# Forge Patch Intent',
      '',
      '<!-- forge-patch-intent:v1',
      'id: patch_stage_validate_example',
      'anchorId: stage.validate',
      'path: commands/validate.md',
      'createdAt: 2026-05-13T00:00:00.000Z',
      'source: git-diff',
      'status: active',
      '-->',
      '```diff',
      'diff --git a/commands/validate.md b/commands/validate.md',
      '--- a/commands/validate.md',
      '+++ b/commands/validate.md',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '```',
      '<!-- /forge-patch-intent -->',
      '',
    ].join('\r\n'));

    const loaded = loadPatchIntentRecords(root);

    expect(loaded.records).toHaveLength(1);
    expect(loaded.records[0].anchorId).toBe('stage.validate');
  });

  test('fails loudly on malformed patch intent record blocks', () => {
    const root = makeRepo();
    writeFile(root, '.forge/patch.md', [
      '# Forge Patch Intent',
      '',
      '<!-- forge-patch-intent:v1',
      'id: patch_broken',
      'anchorId: stage.broken',
      '',
    ].join('\n'));

    expect(() => loadPatchIntentRecords(root)).toThrow('Malformed patch intent record block');
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

  test('normalizes absolute patchIntent.path values inside the project root', () => {
    const root = makeRepo();
    const absolutePatchPath = path.join(root, '.forge', 'absolute-patch.md').replace(/\\/g, '/');
    writeFile(root, '.forge/config.yaml', [
      'patchIntent:',
      `  path: ${absolutePatchPath}`,
      '',
    ].join('\n'));
    writeFile(root, 'commands/validate.md', [
      '<!-- forge-anchor:stage.validate -->',
      'Run checks.',
      '',
    ].join('\n'));
    commitAll(root);
    writeFile(root, 'commands/validate.md', [
      '<!-- forge-anchor:stage.validate -->',
      'Run checks carefully.',
      '',
    ].join('\n'));

    const config = loadPatchIntentConfig(root);
    const result = recordPatchIntentFromDiff(root);

    expect(config.path).toBe('.forge/absolute-patch.md');
    expect(result.path).toBe('.forge/absolute-patch.md');
    expect(fs.existsSync(path.join(root, '.forge', 'absolute-patch.md'))).toBe(true);
  });

  test('reports scalar patchIntent config values as invalid', () => {
    const root = makeRepo();
    writeFile(root, '.forge/config.yaml', 'patchIntent: false\n');

    const config = loadPatchIntentConfig(root);

    expect(config.errors.some(error => error.code === 'PATCH_INTENT_CONFIG_INVALID')).toBe(true);
    expect(() => resolvePatchIntentRecords(root)).toThrow('PATCH_INTENT_CONFIG_INVALID');
  });

  test('excludes configured patchIntent.path from anchor discovery and git diff recording', () => {
    const root = makeRepo();
    writeFile(root, '.forge/config.yaml', [
      'patchIntent:',
      '  path: .forge/custom-patch.md',
      '',
    ].join('\n'));
    writeFile(root, '.forge/custom-patch.md', '<!-- forge-anchor:stored.diff -->\nStored record text.\n');
    writeFile(root, 'commands/validate.md', [
      '<!-- forge-anchor:stage.validate -->',
      'Run checks.',
      '',
    ].join('\n'));
    commitAll(root);
    writeFile(root, '.forge/custom-patch.md', '<!-- forge-anchor:stored.diff -->\nChanged stored record text.\n');
    writeFile(root, 'commands/validate.md', [
      '<!-- forge-anchor:stage.validate -->',
      'Run checks carefully.',
      '',
    ].join('\n'));

    const anchors = discoverAnchors(root, { excludedPatchPath: '.forge/custom-patch.md' });
    const result = recordPatchIntentFromDiff(root);

    expect(anchors.has('stored.diff')).toBe(false);
    expect(result.records).toHaveLength(1);
    expect(result.records[0].path).toBe('commands/validate.md');
    expect(result.records[0].diff).not.toContain('custom-patch.md');
  });

  test('rejects patchIntent.path outside the project root', () => {
    const root = makeRepo();
    writeFile(root, '.forge/config.yaml', [
      'patchIntent:',
      '  path: ../outside-patch.md',
      '',
    ].join('\n'));

    const config = loadPatchIntentConfig(root);

    expect(config.errors[0].code).toBe('PATCH_INTENT_PATH_OUTSIDE_ROOT');
    expect(() => recordPatchIntentFromDiff(root)).toThrow('inside the project root');
    expect(() => resolvePatchIntentRecords(root)).toThrow('inside the project root');
  });

  test('validates explicit patchPath overrides before loading or writing records', () => {
    const root = makeRepo();

    expect(() => loadPatchIntentRecords(root, { patchPath: '../outside.md' })).toThrow('inside the project root');
    expect(() => writePatchIntentRecords(root, [], { patchPath: '../outside.md' })).toThrow('inside the project root');
  });

  test('rejects patchIntent.path that escapes through a symlink', () => {
    const root = makeRepo();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-patch-outside-'));
    tempRoots.push(outside);
    try {
      fs.symlinkSync(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return;
    }
    writeFile(root, '.forge/config.yaml', [
      'patchIntent:',
      '  path: link/patch.md',
      '',
    ].join('\n'));

    const config = loadPatchIntentConfig(root);

    expect(config.errors[0].code).toBe('PATCH_INTENT_PATH_OUTSIDE_ROOT');
    expect(() => recordPatchIntentFromDiff(root)).toThrow('inside the project root');
  });

  test('rejects diff paths outside the project root', () => {
    const root = makeRepo();
    const diff = [
      'diff --git a/../outside.md b/../outside.md',
      '--- a/../outside.md',
      '+++ b/../outside.md',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '',
    ].join('\n');

    expect(() => recordPatchIntentFromDiff(root, { diff })).toThrow('Diff path must stay inside the project root');
  });

  test('skips deleted files while recording valid patch intents from mixed diffs', () => {
    const root = makeRepo();
    writeFile(root, 'commands/validate.md', [
      '<!-- forge-anchor:stage.validate -->',
      'Run checks.',
      '',
    ].join('\n'));
    writeFile(root, 'deleted.md', 'Remove me.\n');
    commitAll(root);
    writeFile(root, 'commands/validate.md', [
      '<!-- forge-anchor:stage.validate -->',
      'Run checks carefully.',
      '',
    ].join('\n'));
    fs.unlinkSync(path.join(root, 'deleted.md'));

    const result = recordPatchIntentFromDiff(root);

    expect(result.records).toHaveLength(1);
    expect(result.records[0].path).toBe('commands/validate.md');
  });

  test('does not attribute edits to anchors that only appear after the changed lines', () => {
    const root = makeRepo();
    writeFile(root, 'commands/validate.md', [
      'Edit me.',
      '',
      '<!-- forge-anchor:stage.validate -->',
      'Run checks.',
      '',
    ].join('\n'));
    commitAll(root);
    writeFile(root, 'commands/validate.md', [
      'Edited above anchor.',
      '',
      '<!-- forge-anchor:stage.validate -->',
      'Run checks.',
      '',
    ].join('\n'));

    expect(() => recordPatchIntentFromDiff(root)).toThrow('no declared forge anchor before diff hunk');
  });

  test('rejects hunks that cross multiple anchors', () => {
    const root = makeRepo();
    writeFile(root, 'commands/validate.md', [
      '<!-- forge-anchor:stage.one -->',
      'One old.',
      '',
      '<!-- forge-anchor:stage.two -->',
      'Two old.',
      '',
    ].join('\n'));
    commitAll(root);
    writeFile(root, 'commands/validate.md', [
      '<!-- forge-anchor:stage.one -->',
      'One new.',
      '',
      '<!-- forge-anchor:stage.two -->',
      'Two new.',
      '',
    ].join('\n'));

    expect(() => recordPatchIntentFromDiff(root)).toThrow('crosses multiple forge anchors');
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
