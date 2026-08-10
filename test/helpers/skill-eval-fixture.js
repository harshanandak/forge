'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const GIT_TIMEOUT_MS = 5000;

function formatResult(result) {
  return [
    `status=${result.status === null ? 'null' : result.status}`,
    `signal=${result.signal || 'none'}`,
    result.error ? `error=${result.error.message}` : null,
  ].filter(Boolean).join(' ');
}

function runGit(root, args, phase) {
  const started = performance.now();
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
  });
  const elapsedMs = Math.round(performance.now() - started);
  if (result.status !== 0) {
    throw new Error(`skill-eval fixture phase=${phase} elapsedMs=${elapsedMs} ${formatResult(result)}`);
  }
  return { elapsedMs, phase };
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-skill-eval-cli-'));
  try {
    fs.mkdirSync(path.join(root, 'skills', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# test\n');
    fs.writeFileSync(
      path.join(root, 'skills', 'demo', 'SKILL.md'),
      '---\nname: demo\ndescription: behavioral demo\n---\nbody\n',
    );

    const phases = {
      gitInit: runGit(root, ['-c', 'init.defaultBranch=skill-eval-fixture', 'init', '-q'], 'git-init'),
      gitCommit: runGit(root, [
        '-c', 'user.email=eval@example.test',
        '-c', 'user.name=Eval Test',
        '-c', 'commit.gpgsign=false',
        '-c', 'core.hooksPath=',
        'commit', '--allow-empty', '-qm', 'fixture',
      ], 'git-commit'),
    };
    return {
      root,
      phases,
      setupMs: phases.gitInit.elapsedMs + phases.gitCommit.elapsedMs,
      cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { createSkillEvalFixture, formatPhaseDiagnostics };
