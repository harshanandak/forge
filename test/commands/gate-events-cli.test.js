'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, beforeEach, describe, expect, test } = require('bun:test');

const FORGE_BIN = path.join(__dirname, '..', '..', 'bin', 'forge.js');
const ISSUE_ID = 'gate-cli-issue';
const tempRoots = [];

function run(cwd, args) {
  return spawnSync(process.execPath, [FORGE_BIN, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, FORGE_ACTOR: 'cli-tester' },
  });
}

function parseJson(stdout) {
  expect(() => JSON.parse(stdout)).not.toThrow();
  return JSON.parse(stdout);
}

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-gate-cli-'));
  tempRoots.push(root);
  expect(spawnSync('git', ['init', '-q'], { cwd: root }).status).toBe(0);
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# test\n');
  const created = run(root, [
    'create', '--id', ISSUE_ID, '--title', 'Gate CLI issue', '--type', 'task',
  ]);
  expect(created.status).toBe(0);
});

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('real forge gate CLI JSON and global flags', () => {
  test('approve, status, and check emit standalone structured JSON with global --path forms', () => {
    const root = tempRoots[0];
    const approve = run(__dirname, [
      'gate', '--path', root, 'approve', ISSUE_ID, 'gate.merge', '--ttl', '5m', '--json',
    ]);
    expect(approve.status).toBe(0);
    const approved = parseJson(approve.stdout);
    expect(approved).toMatchObject({
      schema_version: 'forge.gate.v1',
      command: 'gate.approve',
      ok: true,
      issue_id: ISSUE_ID,
      gate_id: 'gate.merge',
      duplicate: false,
    });
    expect(approved.event.control_id).toBe(`gate:${ISSUE_ID}:gate.merge`);

    const status = run(__dirname, [
      'gate', 'status', ISSUE_ID, '--json', `--path=${root}`,
    ]);
    expect(status.status).toBe(0);
    expect(parseJson(status.stdout)).toMatchObject({
      schema_version: 'forge.gate.v1',
      command: 'gate.status',
      ok: true,
      issue_id: ISSUE_ID,
    });

    const check = run(__dirname, [
      'gate', 'check', ISSUE_ID, 'gate.merge', '--json', '--path', root,
    ]);
    expect(check.status).toBe(0);
    expect(parseJson(check.stdout)).toMatchObject({
      schema_version: 'forge.gate.v1',
      command: 'gate.check',
      ok: true,
      issue_id: ISSUE_ID,
      gate_id: 'gate.merge',
      approved: true,
    });
  });

  test('denied check keeps exit 1 and emits a structured JSON result on stdout', () => {
    const root = tempRoots[0];
    const denied = run(__dirname, [
      'gate', '--path', root, 'check', ISSUE_ID, 'gate.intent', '--json',
    ]);
    expect(denied.status).toBe(1);
    expect(parseJson(denied.stdout)).toMatchObject({
      schema_version: 'forge.gate.v1',
      command: 'gate.check',
      ok: false,
      issue_id: ISSUE_ID,
      gate_id: 'gate.intent',
      approved: false,
    });
  });

  test('status and check reject unknown flags, extra operands, and duplicate JSON flags', () => {
    const root = tempRoots[0];
    const invalid = [
      [['gate', 'status', ISSUE_ID, '--bogus', '--json', '--path', root], 'gate.status'],
      [['gate', 'status', ISSUE_ID, 'extra', '--json', '--path', root], 'gate.status'],
      [['gate', 'status', ISSUE_ID, '--json', '--json', '--path', root], 'gate.status'],
      [['gate', 'check', ISSUE_ID, 'gate.merge', '--bogus', '--json', '--path', root], 'gate.check'],
      [['gate', 'check', ISSUE_ID, 'gate.merge', 'extra', '--json', '--path', root], 'gate.check'],
      [['gate', 'check', ISSUE_ID, 'gate.merge', '--json', '--json', '--path', root], 'gate.check'],
    ];

    for (const [args, command] of invalid) {
      const result = run(__dirname, args);
      expect(result.status).toBe(1);
      expect(parseJson(result.stdout)).toMatchObject({
        schema_version: 'forge.gate.v1',
        command,
        ok: false,
      });
    }
  });
});
