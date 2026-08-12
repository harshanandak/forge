'use strict';

const { describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { changedSkillFiles, syncAgentSkills } = require('../scripts/sync-agent-skills');

const HEAD = 'a'.repeat(40);

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-skill-authority-'));
  fs.mkdirSync(path.join(root, 'skills', 'review'), { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'skills', 'review'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skills', 'review', 'SKILL.md'), 'canonical bytes\n');
  fs.writeFileSync(path.join(root, '.agents', 'skills', 'review', 'SKILL.md'), 'old bytes\n');
  return root;
}

describe('command-owned agent skill sync', () => {
  test('authorizes before writing, proves exact bytes, completes, then stages', async () => {
    const root = fixture();
    const calls = [];
    try {
      const result = await syncAgentSkills({
        root,
        env: { FORGE_ACTOR: 'skill-sync-owner' },
        execFileSync: (_command, args) => {
          if (args[0] === 'rev-parse') return `${HEAD}\n`;
          if (args[0] === 'diff' || args[0] === 'ls-files') return '';
          calls.push('stage');
          return '';
        },
        issueAuthorization: async (_root, params) => {
          calls.push('authorize');
          expect(params).toEqual({
            actor: 'skill-sync-owner',
            path: '.agents/skills/review/SKILL.md',
            sourceHead: HEAD,
            writeIntent: 'update',
          });
          expect(fs.readFileSync(path.join(root, '.agents/skills/review/SKILL.md'), 'utf8')).toBe('old bytes\n');
          return { success: true, capabilityId: 'capability-1' };
        },
        completeAuthorization: async (_root, params) => {
          calls.push('complete');
          expect(params.capabilityId).toBe('capability-1');
          expect(fs.readFileSync(path.join(root, '.agents/skills/review/SKILL.md'), 'utf8')).toBe('canonical bytes\n');
          return { success: true };
        },
      });

      expect(calls).toEqual(['authorize', 'complete', 'stage']);
      expect(result.changed).toEqual(['.agents/skills/review/SKILL.md']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails closed without authority and leaves mirror bytes untouched', async () => {
    const root = fixture();
    let staged = false;
    try {
      await expect(syncAgentSkills({
        root,
        env: { FORGE_ACTOR: 'skill-sync-owner' },
        execFileSync: (_command, args) => {
          if (args[0] === 'rev-parse') return `${HEAD}\n`;
          if (args[0] === 'diff' || args[0] === 'ls-files') return '';
          staged = true;
          return '';
        },
        issueAuthorization: async () => ({ success: false, error: 'missing authority' }),
      })).rejects.toThrow('authorization failed');
      expect(staged).toBe(false);
      expect(fs.readFileSync(path.join(root, '.agents/skills/review/SKILL.md'), 'utf8')).toBe('old bytes\n');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('reauthorizes unstaged generated drift after completion fails before staging', async () => {
    const root = fixture();
    const run = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    let completions = 0;
    let authorizations = 0;
    try {
      expect(run(['init']).status).toBe(0);
      expect(run(['config', 'user.email', 'forge-test@example.invalid']).status).toBe(0);
      expect(run(['config', 'user.name', 'Forge Test']).status).toBe(0);
      expect(run(['add', '.']).status).toBe(0);
      expect(run(['commit', '-m', 'base']).status).toBe(0);
      fs.writeFileSync(path.join(root, 'skills/review/SKILL.md'), 'new canonical bytes\n');
      expect(run(['add', 'skills/review/SKILL.md']).status).toBe(0);
      const options = {
        root,
        env: { FORGE_ACTOR: 'skill-retry-owner' },
        issueAuthorization: async () => ({ success: true, capabilityId: `capability-${++authorizations}` }),
        completeAuthorization: async () => (
          ++completions === 1
            ? { success: false, error: 'forced completion failure' }
            : { success: true }
        ),
      };

      await expect(syncAgentSkills(options)).rejects.toThrow('completion failed');
      expect(run(['diff', '--name-only']).stdout.trim()).toBe('.agents/skills/review/SKILL.md');
      expect(run(['diff', '--cached', '--name-only']).stdout).not.toContain('.agents/skills/review/SKILL.md');

      await syncAgentSkills(options);
      expect(authorizations).toBe(2);
      expect(run(['diff', '--cached', '--name-only']).stdout).toContain('.agents/skills/review/SKILL.md');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('defers sync when staged canonical bytes have a later unstaged edit', async () => {
    const root = fixture();
    const run = args => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    let authorizations = 0;
    try {
      fs.writeFileSync(path.join(root, '.agents/skills/review/SKILL.md'), 'base canonical bytes\n');
      fs.writeFileSync(path.join(root, 'skills/review/SKILL.md'), 'base canonical bytes\n');
      expect(run(['init']).status).toBe(0);
      expect(run(['config', 'user.email', 'forge-test@example.invalid']).status).toBe(0);
      expect(run(['config', 'user.name', 'Forge Test']).status).toBe(0);
      expect(run(['add', '.']).status).toBe(0);
      expect(run(['commit', '-m', 'base']).status).toBe(0);

      fs.writeFileSync(path.join(root, 'skills/review/SKILL.md'), 'staged canonical bytes\n');
      expect(run(['add', 'skills/review/SKILL.md']).status).toBe(0);
      fs.writeFileSync(path.join(root, 'skills/review/SKILL.md'), 'unstaged canonical bytes\n');

      await expect(syncAgentSkills({
        root,
        env: { FORGE_ACTOR: 'skill-index-parity-owner' },
        issueAuthorization: async () => {
          authorizations += 1;
          return { success: true, capabilityId: 'must-not-be-issued' };
        },
        completeAuthorization: async () => ({ success: true }),
      })).rejects.toThrow('unstaged canonical skill changes');

      expect(authorizations).toBe(0);
      expect(fs.readFileSync(path.join(root, '.agents/skills/review/SKILL.md'), 'utf8')).toBe('base canonical bytes\n');
      expect(run(['diff', '--cached', '--name-only']).stdout).not.toContain('.agents/skills/review/SKILL.md');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('fails closed when canonical index parity cannot be inspected', async () => {
    const root = fixture();
    let authorizations = 0;
    try {
      await expect(syncAgentSkills({
        root,
        env: { FORGE_ACTOR: 'skill-index-inspection-owner' },
        execFileSync: (_command, args) => {
          if (args[0] === 'rev-parse') return `${HEAD}\n`;
          if (args.at(-1) === 'skills') throw new Error('forced git inspection failure');
          if (args[0] === 'diff' || args[0] === 'ls-files') return '';
          return '';
        },
        issueAuthorization: async () => {
          authorizations += 1;
          return { success: true, capabilityId: 'must-not-be-issued' };
        },
      })).rejects.toThrow('forced git inspection failure');
      expect(authorizations).toBe(0);
      expect(fs.readFileSync(path.join(root, '.agents/skills/review/SKILL.md'), 'utf8')).toBe('old bytes\n');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('defers mirror deletion after an unstaged canonical deletion', async () => {
    const root = fixture();
    const run = args => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    let authorizations = 0;
    try {
      fs.writeFileSync(path.join(root, '.agents/skills/review/SKILL.md'), 'base canonical bytes\n');
      fs.writeFileSync(path.join(root, 'skills/review/SKILL.md'), 'base canonical bytes\n');
      expect(run(['init']).status).toBe(0);
      expect(run(['config', 'user.email', 'forge-test@example.invalid']).status).toBe(0);
      expect(run(['config', 'user.name', 'Forge Test']).status).toBe(0);
      expect(run(['add', '.']).status).toBe(0);
      expect(run(['commit', '-m', 'base']).status).toBe(0);

      fs.writeFileSync(path.join(root, 'skills/review/SKILL.md'), 'staged canonical bytes\n');
      expect(run(['add', 'skills/review/SKILL.md']).status).toBe(0);
      fs.rmSync(path.join(root, 'skills/review'), { recursive: true, force: true });

      await expect(syncAgentSkills({
        root,
        env: { FORGE_ACTOR: 'skill-delete-index-parity-owner' },
        issueAuthorization: async () => {
          authorizations += 1;
          return { success: true, capabilityId: 'must-not-be-issued' };
        },
        completeAuthorization: async () => ({ success: true }),
      })).rejects.toThrow('unstaged canonical skill changes');

      expect(authorizations).toBe(0);
      expect(fs.readFileSync(path.join(root, '.agents/skills/review/SKILL.md'), 'utf8')).toBe('base canonical bytes\n');
      expect(run(['diff', '--cached', '--name-only']).stdout).not.toContain('.agents/skills/review/SKILL.md');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('blocks a staged skill when another skill has an unstaged edit', async () => {
    const root = fixture();
    const run = args => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    let authorizations = 0;
    try {
      fs.writeFileSync(path.join(root, '.agents/skills/review/SKILL.md'), 'review base\n');
      fs.writeFileSync(path.join(root, 'skills/review/SKILL.md'), 'review base\n');
      fs.mkdirSync(path.join(root, '.agents/skills/ship'), { recursive: true });
      fs.mkdirSync(path.join(root, 'skills/ship'), { recursive: true });
      fs.writeFileSync(path.join(root, '.agents/skills/ship/SKILL.md'), 'ship base\n');
      fs.writeFileSync(path.join(root, 'skills/ship/SKILL.md'), 'ship base\n');
      expect(run(['init']).status).toBe(0);
      expect(run(['config', 'user.email', 'forge-test@example.invalid']).status).toBe(0);
      expect(run(['config', 'user.name', 'Forge Test']).status).toBe(0);
      expect(run(['add', '.']).status).toBe(0);
      expect(run(['commit', '-m', 'base']).status).toBe(0);

      fs.writeFileSync(path.join(root, 'skills/ship/SKILL.md'), 'ship staged\n');
      expect(run(['add', 'skills/ship/SKILL.md']).status).toBe(0);
      fs.writeFileSync(path.join(root, 'skills/review/SKILL.md'), 'review unstaged\n');

      await expect(syncAgentSkills({
        root,
        env: { FORGE_ACTOR: 'skill-mixed-parity-owner' },
        issueAuthorization: async () => {
          authorizations += 1;
          return { success: true, capabilityId: 'must-not-be-issued' };
        },
        completeAuthorization: async () => ({ success: true }),
      })).rejects.toThrow('unstaged canonical skill changes');

      expect(authorizations).toBe(0);
      expect(fs.readFileSync(path.join(root, '.agents/skills/ship/SKILL.md'), 'utf8')).toBe('ship base\n');
      expect(run(['diff', '--cached', '--name-only']).stdout).not.toContain('.agents/skills/ship/SKILL.md');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('blocks a canonical skill recreated after its staged deletion', async () => {
    const root = fixture();
    const run = args => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    let authorizations = 0;
    try {
      fs.writeFileSync(path.join(root, '.agents/skills/review/SKILL.md'), 'base canonical bytes\n');
      fs.writeFileSync(path.join(root, 'skills/review/SKILL.md'), 'base canonical bytes\n');
      expect(run(['init']).status).toBe(0);
      expect(run(['config', 'user.email', 'forge-test@example.invalid']).status).toBe(0);
      expect(run(['config', 'user.name', 'Forge Test']).status).toBe(0);
      expect(run(['add', '.']).status).toBe(0);
      expect(run(['commit', '-m', 'base']).status).toBe(0);

      expect(run(['rm', 'skills/review/SKILL.md']).status).toBe(0);
      fs.mkdirSync(path.join(root, 'skills/review'), { recursive: true });
      fs.writeFileSync(path.join(root, 'skills/review/SKILL.md'), 'recreated canonical bytes\n');

      await expect(syncAgentSkills({
        root,
        env: { FORGE_ACTOR: 'skill-recreated-delete-owner' },
        issueAuthorization: async () => {
          authorizations += 1;
          return { success: true, capabilityId: 'must-not-be-issued' };
        },
        completeAuthorization: async () => ({ success: true }),
      })).rejects.toThrow('unstaged canonical skill changes');

      expect(authorizations).toBe(0);
      expect(run(['diff', '--cached', '--name-only']).stdout).toContain('skills/review/SKILL.md');
      expect(run(['diff', '--cached', '--name-only']).stdout).not.toContain('.agents/skills/review/SKILL.md');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('real hook accepts one exact sync and denies replay or foreign actor', async () => {
    const root = fixture();
    const actor = 'skill-sync-integration';
    const checker = path.resolve(__dirname, '../scripts/protected-state-check.js');
    const run = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    const check = (checkActor = actor) => spawnSync(process.execPath, [checker], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, FORGE_PROTECTED_STATE_ACTOR: checkActor },
    });
    try {
      fs.writeFileSync(path.join(root, 'skills/review/SKILL.md'), 'old bytes\n');
      expect(run(['init']).status).toBe(0);
      expect(run(['config', 'user.email', 'forge-test@example.invalid']).status).toBe(0);
      expect(run(['config', 'user.name', 'Forge Test']).status).toBe(0);
      expect(run(['add', '.']).status).toBe(0);
      expect(run(['commit', '-m', 'base']).status).toBe(0);
      fs.writeFileSync(path.join(root, 'skills/review/SKILL.md'), 'canonical bytes\n');
      expect(run(['add', 'skills/review/SKILL.md']).status).toBe(0);

      await syncAgentSkills({ root, env: { FORGE_ACTOR: actor } });
      expect(check('foreign-actor').status).toBe(1);
      expect(check().status).toBe(0);

	  await syncAgentSkills({ root, env: { FORGE_ACTOR: actor } });
	  expect(check().status).toBe(0);
      expect(check().status).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('authorizes and completes canonical skill removal before staging the mirror deletion', async () => {
    const root = fixture();
    const actor = 'skill-delete-integration';
    const checker = path.resolve(__dirname, '../scripts/protected-state-check.js');
    const run = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    try {
      expect(run(['init']).status).toBe(0);
      expect(run(['config', 'user.email', 'forge-test@example.invalid']).status).toBe(0);
      expect(run(['config', 'user.name', 'Forge Test']).status).toBe(0);
      expect(run(['add', '.']).status).toBe(0);
      expect(run(['commit', '-m', 'base']).status).toBe(0);
      fs.rmSync(path.join(root, 'skills/review'), { recursive: true, force: true });
      expect(run(['add', '--all', '--', 'skills/review']).status).toBe(0);

      await syncAgentSkills({ root, env: { FORGE_ACTOR: actor } });
      expect(fs.existsSync(path.join(root, '.agents/skills/review'))).toBe(false);
      const check = spawnSync(process.execPath, [checker], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, FORGE_PROTECTED_STATE_ACTOR: actor },
      });
      expect(check.status).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('reauthorizes an absent generated mirror after delete completion fails before staging', async () => {
    const root = fixture();
    const actor = 'skill-delete-retry-owner';
    const checker = path.resolve(__dirname, '../scripts/protected-state-check.js');
    const run = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    let completions = 0;
    let authorizations = 0;
    try {
      expect(run(['init']).status).toBe(0);
      expect(run(['config', 'user.email', 'forge-test@example.invalid']).status).toBe(0);
      expect(run(['config', 'user.name', 'Forge Test']).status).toBe(0);
      expect(run(['add', '.']).status).toBe(0);
      expect(run(['commit', '-m', 'base']).status).toBe(0);
      fs.rmSync(path.join(root, 'skills/review'), { recursive: true, force: true });
      expect(run(['add', '--all', '--', 'skills/review']).status).toBe(0);
      const options = {
        root,
        env: { FORGE_ACTOR: actor },
        issueAuthorization: async (_root, params) => {
          authorizations += 1;
          expect(params.writeIntent).toBe('delete');
          expect(params.path).toBe('.agents/skills/review/SKILL.md');
          return { success: true, capabilityId: `delete-capability-${authorizations}` };
        },
        completeAuthorization: async () => (
          ++completions === 1
            ? { success: false, error: 'forced delete completion failure' }
            : { success: true }
        ),
      };

      await expect(syncAgentSkills(options)).rejects.toThrow('completion failed');
      expect(fs.existsSync(path.join(root, '.agents/skills/review/SKILL.md'))).toBe(false);
      expect(run(['diff', '--name-only']).stdout).toContain('.agents/skills/review/SKILL.md');
      expect(run(['diff', '--cached', '--name-only']).stdout).not.toContain('.agents/skills/review/SKILL.md');

      await syncAgentSkills(options);
      expect(authorizations).toBe(2);
      expect(run(['diff', '--cached', '--name-only']).stdout).toContain('.agents/skills/review/SKILL.md');
      expect(spawnSync(process.execPath, [checker], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, FORGE_PROTECTED_STATE_ACTOR: actor },
      }).status).toBe(1); // injected authority seams never mint real Kernel evidence

	  fs.mkdirSync(path.join(root, 'skills/review'), { recursive: true });
	  fs.writeFileSync(path.join(root, 'skills/review/SKILL.md'), 'canonical reappeared\n');
	  expect(changedSkillFiles(root).some(file => file.writeIntent === 'delete')).toBe(false);
	  expect(run(['diff', '--cached', '--name-only']).stdout).toContain('.agents/skills/review/SKILL.md');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
