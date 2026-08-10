'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const zlib = require('node:zlib');

function writeLooseObject(gitDir, type, body) {
  const content = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const object = Buffer.concat([Buffer.from(`${type} ${content.length}\0`), content]);
  const objectId = createHash('sha1').update(object).digest('hex');
  const objectDir = path.join(gitDir, 'objects', objectId.slice(0, 2));
  fs.mkdirSync(objectDir, { recursive: true });
  fs.writeFileSync(path.join(objectDir, objectId.slice(2)), zlib.deflateSync(object));
  return objectId;
}

function createConventionalGitDir(root) {
  const gitDir = path.join(root, '.git');
  fs.mkdirSync(path.join(gitDir, 'refs', 'heads'), { recursive: true });
  const tree = writeLooseObject(gitDir, 'tree', Buffer.alloc(0));
  const identity = 'Eval Test <eval@example.test> 946684800 +0000';
  const commit = writeLooseObject(gitDir, 'commit', [
    `tree ${tree}`,
    `author ${identity}`,
    `committer ${identity}`,
    '',
    'fixture',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/skill-eval-fixture\n');
  fs.writeFileSync(path.join(gitDir, 'refs', 'heads', 'skill-eval-fixture'), `${commit}\n`);
  return gitDir;
}

function formatPhaseDiagnostics(phases) {
  return Object.values(phases)
    .filter(Boolean)
    .map(({ phase, elapsedMs, ...details }) => {
      const suffix = Object.entries(details)
        .map(([key, value]) => `${key}=${value}`)
        .join(' ');
      return `${phase}=${elapsedMs}ms${suffix ? ` ${suffix}` : ''}`;
    })
    .join(', ');
}

function createSkillEvalFixture() {
  const started = performance.now();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-skill-eval-cli-'));
  try {
    const gitCommonDir = createConventionalGitDir(root);
    const skillName = 'demo';
    fs.mkdirSync(path.join(root, 'skills', skillName), { recursive: true });
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# test\n');
    fs.writeFileSync(path.join(root, 'skills', skillName, 'SKILL.md'), [
      '---',
      `name: ${skillName}`,
      'description: behavioral demo',
      '---',
      'body',
      '',
    ].join('\n'));
    const setupMs = Math.round(performance.now() - started);
    return {
      root,
      skillName,
      gitCommonDir,
      kernelDatabasePath: path.join(gitCommonDir, 'forge', 'kernel.sqlite'),
      phases: { fixtureSetup: { phase: 'fixture-setup', elapsedMs: setupMs } },
      setupMs,
      cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { createSkillEvalFixture, formatPhaseDiagnostics };
