'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { expect, test } = require('bun:test');

const ROOT = path.join(__dirname, '..');
const VALIDATE_YAML_SCRIPT = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
).scripts['validate:yaml'];

function runYamlValidation(cwd) {
  return spawnSync('bun', ['run', 'validate:yaml'], {
    cwd,
    encoding: 'utf8',
    shell: false,
  });
}

function expectValidationFailure(result) {
  const output = `${result.stdout}\n${result.stderr}`;
  expect(result.status, output).not.toBeNull();
  expect(result.status, output).not.toBe(0);
}

test('validate:yaml runs under Bun and rejects invalid or unreadable YAML', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-yaml-validation-'));
  const malformedPath = path.join(fixtureRoot, 'malformed.yaml');
  const unreadablePath = path.join(fixtureRoot, 'unreadable.yaml');

  try {
    fs.writeFileSync(path.join(fixtureRoot, 'package.json'), JSON.stringify({
      private: true,
      scripts: { 'validate:yaml': VALIDATE_YAML_SCRIPT },
    }));
    fs.writeFileSync(path.join(fixtureRoot, 'valid.yaml'), 'name: forge\n');
    fs.symlinkSync(
      path.join(ROOT, 'node_modules'),
      path.join(fixtureRoot, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const clean = runYamlValidation(fixtureRoot);
    expect(clean.status, clean.stderr).toBe(0);

    fs.writeFileSync(malformedPath, 'broken: [\n');
    const malformed = runYamlValidation(fixtureRoot);
    expectValidationFailure(malformed);
    fs.rmSync(malformedPath);

    fs.symlinkSync('missing.yaml', unreadablePath, 'file');
    const unreadable = runYamlValidation(fixtureRoot);
    expectValidationFailure(unreadable);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}, 30000);
