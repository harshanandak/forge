'use strict';

const { describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { syncAgentSkills } = require('../scripts/sync-agent-skills');

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
          if (args[0] === 'diff') return '';
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
          if (args[0] === 'diff') return '';
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
});
