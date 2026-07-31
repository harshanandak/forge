const { describe, expect, test, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const addCommand = require('../../lib/commands/add');
const upgradeCommand = require('../../lib/commands/upgrade');
const { FORGE_HOOK_CONTRACT, mergeClaudeSettings } = require('../../lib/hook-renderer');

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

    expect(result.success).toBe(false);
    expect(result.output).toContain('Forge upgrade dry-run');
    expect(result.error).toBe(result.output);
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
    expect(fs.existsSync(path.join(root, '.claude'))).toBe(false);

    const second = await upgradeCommand.handler(['--self-heal'], {}, root);
    expect(second.success).toBe(true);
    expect(second.output).toContain('No self-heal actions needed');
  });

  test('self-heal restores missing Claude lifecycle groups without replacing user hooks', async () => {
    const root = makeRepo();
    const settingsPath = path.join(root, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      model: 'sonnet',
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'node user-welcome.js' }] }],
      },
    }, null, 2));

    const result = await upgradeCommand.handler(['--self-heal'], {}, root);
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const commands = event => settings.hooks[event].flatMap(group => group.hooks.map(hook => hook.command));

    expect(result.success).toBe(true);
    expect(settings.model).toBe('sonnet');
    expect(commands('SessionStart')).toContain('node user-welcome.js');
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PreCompact', 'Stop']) {
      expect(commands(event).filter(command => command.includes('forge.js')).length).toBeGreaterThan(0);
    }

    await upgradeCommand.handler(['--self-heal'], {}, root);
    const twice = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PreCompact', 'Stop']) {
      expect(twice.hooks[event].filter(group =>
        group.hooks.some(hook => hook.command.includes('forge.js')))).toHaveLength(1);
      const forgeCommands = twice.hooks[event]
        .flatMap(group => group.hooks.map(hook => hook.command))
        .filter(command => command.includes('forge.js'));
      expect(new Set(forgeCommands).size).toBe(forgeCommands.length);
    }
  });

  test('self-heal leaves semantically complete compact Claude settings unchanged', async () => {
    const root = makeRepo();
    const settingsPath = path.join(root, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const compact = JSON.stringify(JSON.parse(mergeClaudeSettings('', FORGE_HOOK_CONTRACT)));
    fs.writeFileSync(settingsPath, compact);

    await upgradeCommand.handler(['--self-heal'], {}, root);

    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(compact);
  });

  test('self-heal deduplicates canonical lifecycle groups and commands only', async () => {
    const root = makeRepo();
    const settingsPath = path.join(root, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const settings = JSON.parse(mergeClaudeSettings('', FORGE_HOOK_CONTRACT));
    settings.hooks.SessionStart.push(structuredClone(settings.hooks.SessionStart[0]));
    settings.hooks.UserPromptSubmit[0].hooks.push(
      structuredClone(settings.hooks.UserPromptSubmit[0].hooks[0]),
    );
    settings.hooks.Stop.unshift({
      hooks: [{ type: 'command', command: 'node user-notify.js' }],
    });
    fs.writeFileSync(settingsPath, JSON.stringify(settings));

    await upgradeCommand.handler(['--self-heal'], {}, root);

    const repaired = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const forgeGroups = event => repaired.hooks[event].filter(group =>
      group.hooks.some(hook => hook.command.includes('forge.js')));
    expect(forgeGroups('SessionStart')).toHaveLength(1);
    expect(forgeGroups('UserPromptSubmit')).toHaveLength(1);
    const promptCommands = forgeGroups('UserPromptSubmit')[0].hooks.map(hook => hook.command);
    expect(new Set(promptCommands).size).toBe(promptCommands.length);
    expect(repaired.hooks.Stop.flatMap(group => group.hooks.map(hook => hook.command)))
      .toContain('node user-notify.js');
  });

  test('self-heal preserves user commands sharing a stale Forge group', async () => {
    const root = makeRepo();
    const settingsPath = path.join(root, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const settings = JSON.parse(mergeClaudeSettings('', FORGE_HOOK_CONTRACT));
    const promptGroup = settings.hooks.UserPromptSubmit[0];
    promptGroup.hooks.push(structuredClone(promptGroup.hooks[0]));
    promptGroup.hooks.push({ type: 'command', command: 'node user-prompt-audit.js' });
    settings.hooks.UserPromptSubmit.push({
      hooks: [{ type: 'command', command: 'node user-separate-audit.js' }],
    });
    fs.writeFileSync(settingsPath, JSON.stringify(settings));

    await upgradeCommand.handler(['--self-heal'], {}, root);

    const repaired = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const promptCommands = repaired.hooks.UserPromptSubmit
      .flatMap(group => group.hooks.map(hook => hook.command));
    expect(promptCommands).toContain('node user-prompt-audit.js');
    expect(promptCommands).toContain('node user-separate-audit.js');
    for (const action of ['inbox-pickup', 'shepherd-events', 'memory-recall']) {
      expect(promptCommands.filter(command => command.includes(`hooks ${action}`))).toHaveLength(1);
    }
  });

  test('self-heal backs up malformed Claude settings without overwriting them', async () => {
    const root = makeRepo();
    const settingsPath = path.join(root, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const malformed = '{ // user JSONC\n "hooks": {}\n}\n';
    fs.writeFileSync(settingsPath, malformed);

    const result = await upgradeCommand.handler(['--self-heal'], {}, root);

    expect(result.success).toBe(true);
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(malformed);
    expect(fs.existsSync(`${settingsPath}.bak`)).toBe(true);

    await upgradeCommand.handler(['--self-heal'], {}, root);
    expect(fs.existsSync(`${settingsPath}.bak.1`)).toBe(false);
  });

  test('self-heal does not inspect or rewrite Claude settings symlinked outside the project', async () => {
    const root = makeRepo();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-upgrade-outside-'));
    tempRoots.push(outside);
    const settingsPath = path.join(root, '.claude', 'settings.json');
    const outsideSettings = path.join(outside, 'settings.json');
    const original = '{"model":"outside"}\n';
    fs.writeFileSync(outsideSettings, original);
    try {
      if (process.platform === 'win32') {
        fs.symlinkSync(outside, path.dirname(settingsPath), 'junction');
      } else {
        fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
        fs.symlinkSync(outsideSettings, settingsPath);
      }
    } catch (error) {
      if (['EACCES', 'EPERM', 'ENOTSUP'].includes(error.code)) return;
      throw error;
    }

    const result = await upgradeCommand.handler(['--self-heal'], {}, root);

    expect(result.success).toBe(true);
    expect(result.output).not.toContain('Merge missing Forge-owned Claude lifecycle hooks');
    expect(fs.readFileSync(outsideSettings, 'utf8')).toBe(original);
  });

  test('self-heal does not inspect or rewrite hardlinked Claude settings', async () => {
    const root = makeRepo();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-upgrade-outside-'));
    tempRoots.push(outside);
    const settingsPath = path.join(root, '.claude', 'settings.json');
    const outsideSettings = path.join(outside, 'settings.json');
    const original = '{"model":"outside"}\n';
    fs.writeFileSync(outsideSettings, original);
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    try {
      fs.linkSync(outsideSettings, settingsPath);
    } catch (error) {
      if (['EACCES', 'EPERM', 'ENOTSUP'].includes(error.code)) return;
      throw error;
    }

    const result = await upgradeCommand.handler(['--self-heal'], {}, root);

    expect(fs.statSync(settingsPath).nlink).toBeGreaterThan(1);
    expect(result.success).toBe(true);
    expect(result.output).not.toContain('Merge missing Forge-owned Claude lifecycle hooks');
    expect(fs.readFileSync(outsideSettings, 'utf8')).toBe(original);
  });

  test('honors parsed kebab-case dry-run flags', async () => {
    const root = makeRepo();

    const result = await upgradeCommand.handler([], { 'dry-run': true }, root);

    expect(result.success).toBe(true);
    expect(result.output).toContain('Forge upgrade dry-run');
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
