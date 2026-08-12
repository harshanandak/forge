#!/usr/bin/env node
'use strict';

/** Command-owned pre-commit sync for the committed `.agents/skills` mirror. */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { populateCodexRepoSkills, resolveCodexRepoSkillsDir } = require('../lib/codex-skills');
const { listCanonicalSkills } = require('../lib/skills-sync');
const {
  completeGeneratedHarnessSkillAuthorization,
  issueGeneratedHarnessSkillAuthorization,
} = require('../lib/protected-state-authority');

function repoRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return path.resolve(__dirname, '..');
  }
}

function actorFromEnv(env) {
  return env.FORGE_ACTOR || env.USER || env.USERNAME || 'unknown';
}

function changedSkillFiles(root) {
  const mirror = resolveCodexRepoSkillsDir(root);
  const changed = [];
  function walk(name, sourceRoot, current = sourceRoot) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const sourcePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(name, sourceRoot, sourcePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = path.relative(sourceRoot, sourcePath).replace(/\\/g, '/');
      const canonical = fs.readFileSync(sourcePath);
      const mirrorPath = path.join(mirror, name, relative);
      try {
        if (canonical.equals(fs.readFileSync(mirrorPath))) continue;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      changed.push({ path: `.agents/skills/${name}/${relative}`, canonical });
    }
  }
  for (const { name, sourcePath } of listCanonicalSkills(root)) walk(name, sourcePath);
  return changed;
}

async function syncAgentSkills(options = {}) {
  const root = options.root || repoRoot();
  const env = options.env || process.env;
  const runGit = options.execFileSync || execFileSync;
  const issueAuthorization = options.issueAuthorization || issueGeneratedHarnessSkillAuthorization;
  const completeAuthorization = options.completeAuthorization || completeGeneratedHarnessSkillAuthorization;
  const actor = actorFromEnv(env);
  const sourceHead = runGit('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (!/^[0-9a-f]{40}$/.test(sourceHead)) throw new Error('source HEAD is not a full lowercase commit SHA');

  const changed = changedSkillFiles(root);
  const authorizations = [];
  for (const file of changed) {
    const authorization = await issueAuthorization(root, { actor, path: file.path, sourceHead });
    if (!authorization.success) throw new Error(`authorization failed for ${file.path}: ${authorization.error}`);
    authorizations.push({ ...file, capabilityId: authorization.capabilityId });
  }

  const { written } = populateCodexRepoSkills({ sourceRoot: root, projectRoot: root, clean: true });
  for (const file of authorizations) {
    if (!file.canonical.equals(fs.readFileSync(path.join(root, file.path)))) {
      throw new Error(`canonical byte equality failed for ${file.path}`);
    }
    const completion = await completeAuthorization(root, {
      actor,
      path: file.path,
      sourceHead,
      capabilityId: file.capabilityId,
    });
    if (!completion.success) throw new Error(`completion failed for ${file.path}: ${completion.error}`);
  }

  const mirror = resolveCodexRepoSkillsDir(root);
  runGit('git', ['add', '--all', '--', mirror], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  console.log(`sync-agent-skills: .agents/skills in sync with skills/ (${written.length} skills)`);
  return { written, changed: changed.map(file => file.path), sourceHead };
}

async function main() {
  try {
    await syncAgentSkills();
  } catch (error) {
    console.error(`sync-agent-skills: failed — ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { actorFromEnv, changedSkillFiles, syncAgentSkills };
