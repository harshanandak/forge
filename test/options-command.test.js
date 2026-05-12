const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { describe, expect, test } = require('bun:test');

const optionsCommand = require('../lib/commands/options');
const explainCommand = require('../lib/commands/explain');

function makeProject(configBody) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-options-'));
  fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
  if (configBody !== null) {
    fs.writeFileSync(path.join(root, '.forge', 'config.yaml'), configBody);
  }
  return root;
}

async function run(args, projectRoot = makeProject(null)) {
  return optionsCommand.handler(args, {}, projectRoot);
}

describe('forge options command', () => {
  test('CLI --json output is parseable without non-interactive banner', () => {
    const output = execFileSync(process.execPath, ['bin/forge.js', 'options', 'stages', '--json'], {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
    });

    expect(JSON.parse(output).kind).toBe('stages');
  });

  test('CLI lint --json failure output remains parseable JSON', () => {
    const projectRoot = makeProject(`
protectedPaths:
  - "**/*"
`);
    const result = spawnSync(process.execPath, ['bin/forge.js', 'options', 'lint', '--json', '--path', projectRoot], {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
    });
    const output = `${result.stdout}${result.stderr}`.trim();

    expect(result.status).toBe(1);
    expect(JSON.parse(output).errors[0].code).toBe('PROTECTED_PATH_TOO_BROAD');
  });

  test('CLI explain --json output is parseable without non-interactive banner', () => {
    const output = execFileSync(process.execPath, ['bin/forge.js', 'explain', 'gate.ship-entry', '--json'], {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
    });

    expect(JSON.parse(output).item.id).toBe('gate.ship-entry');
  });

  test('prints stages, gates, and adapters as JSON over graph primitives', async () => {
    const stages = await run(['stages', '--json']);
    const gates = await run(['gates', '--json']);
    const adapters = await run(['adapters', '--json']);

    expect(JSON.parse(stages.output).items.map(item => item.id)).toContain('plan');
    expect(JSON.parse(gates.output).items.map(item => item.id)).toContain('gate.ship-entry');
    expect(JSON.parse(adapters.output).items.map(item => item.id)).toContain('adapter.issue');
  });

  test('prints human stages output', async () => {
    const result = await run(['stages']);

    expect(result.success).toBe(true);
    expect(result.output).toContain('Stages');
    expect(result.output).toContain('plan');
  });

  test('explains why a primitive exists', async () => {
    const result = await run(['why', 'gate.ship-entry', '--json']);
    const parsed = JSON.parse(result.output);

    expect(parsed.item.id).toBe('gate.ship-entry');
    expect(parsed.item.configSource).toBe('package-defaults');
    expect(parsed.item.requires).toContain('artifact.validation-output');
  });

  test('forge explain is a thin alias over options why', async () => {
    const result = await explainCommand.handler(['gate.ship-entry', '--json'], {}, makeProject(null));
    const parsed = JSON.parse(result.output);

    expect(parsed.item.id).toBe('gate.ship-entry');
  });

  test('diff reports project config changes', async () => {
    const projectRoot = makeProject(`
workflow:
  gates:
    gate.ship-entry:
      enabled: false
`);

    const result = await run(['diff', '--json'], projectRoot);
    const parsed = JSON.parse(result.output);

    expect(parsed.changes).toContainEqual(expect.objectContaining({
      id: 'gate.ship-entry',
      field: 'enabled',
      before: true,
      after: false,
    }));
  });

  test('lint reports invalid config as JSON and human output', async () => {
    const projectRoot = makeProject(`
protectedPaths:
  - "**/*"
`);

    const json = await run(['lint', '--json'], projectRoot);
    const human = await run(['lint'], projectRoot);

    expect(json.success).toBe(false);
    expect(JSON.parse(json.output).errors[0].code).toBe('PROTECTED_PATH_TOO_BROAD');
    expect(human.output).toContain('PROTECTED_PATH_TOO_BROAD');
  });
});
