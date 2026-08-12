#!/usr/bin/env node
'use strict';

/** Command-owned pre-commit sync for the committed `.agents/skills` mirror. */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { populateCodexRepoSkills, resolveCodexRepoSkillsDir } = require('../lib/codex-skills');
const { isValidSkillName, listCanonicalSkills } = require('../lib/skills-sync');
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

function parseGitPaths(output) {
  return output.split('\0').filter(Boolean);
}

function toRepoPath(value) {
  return path.sep === '\\' ? value.replace(/\\/g, '/') : value;
}

function generatedDriftPaths(root, runGit) {
  const commands = [
    ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMRDT', '--', '.agents/skills'],
    ['diff', '--name-only', '-z', '--diff-filter=ACMRDT', '--', '.agents/skills'],
    ['ls-files', '-z', '--others', '--exclude-standard', '--', '.agents/skills'],
  ];
  return new Set(commands.flatMap(args => parseGitPaths(runGit('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }))));
}

function ambiguousCanonicalPaths(root, runGit) {
  const indexedEntries = parseGitPaths(runGit('git', ['ls-files', '-t', '-z', '--', 'skills'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  const canonicalPrefixes = new Set(listCanonicalSkills(root).map(({ name }) => `skills/${name}/`));
  for (const entry of indexedEntries) {
    const match = /^skills\/([^/]+)\/SKILL\.md$/.exec(entry.slice(2));
    if (match && isValidSkillName(match[1])) canonicalPrefixes.add(`skills/${match[1]}/`);
  }
  const participatesInMirror = repoPath => [...canonicalPrefixes].some(prefix => repoPath.startsWith(prefix));
  const indexed = new Set(indexedEntries.map(entry => entry.slice(2)).filter(participatesInMirror));
  const skipWorktree = new Set(indexedEntries
    .filter(entry => entry.startsWith('S '))
    .map(entry => entry.slice(2))
    .filter(participatesInMirror));
  const worktree = new Set();
  for (const prefix of canonicalPrefixes) {
    walkRegularFiles(path.join(root, prefix), (_file, relative) => worktree.add(`${prefix}${relative}`));
  }
  for (const repoPath of skipWorktree) {
    const mirrorPath = `.agents/${repoPath}`;
    if (!fs.existsSync(path.join(root, repoPath)) && fs.existsSync(path.join(root, mirrorPath))) {
      throw new Error(`asymmetric sparse checkout exposes mirror without canonical: ${repoPath}`);
    }
  }
  const paths = new Set([...indexed, ...worktree]);
  return new Set([...paths].filter(repoPath => {
    const indexedContent = indexedFile(root, repoPath, runGit);
    let worktreeContent = null;
    try {
      worktreeContent = fs.readFileSync(path.join(root, repoPath));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return indexedContent === null
      ? worktreeContent !== null
      : (worktreeContent === null && !skipWorktree.has(repoPath))
        || (worktreeContent !== null && !indexedContent.equals(worktreeContent));
  }));
}

function indexedFile(root, repoPath, runGit) {
  const tracked = parseGitPaths(runGit('git', ['ls-files', '-z', '--', repoPath], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  if (!tracked.includes(repoPath)) return null;
  return runGit('git', ['show', `:${repoPath}`], {
    cwd: root,
    encoding: null,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function walkRegularFiles(root, visit, current = root) {
  if (!fs.existsSync(current)) return;
  const currentStat = fs.lstatSync(current);
  if (!currentStat.isDirectory() || currentStat.isSymbolicLink()) throw new Error(`skill sync path is not a real directory: ${current}`);
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const entryPath = path.join(current, entry.name);
    const stat = fs.lstatSync(entryPath);
    if (stat.isSymbolicLink()) throw new Error(`skill sync refuses symlink: ${entryPath}`);
    if (stat.isDirectory()) walkRegularFiles(root, visit, entryPath);
    else if (stat.isFile()) visit(entryPath, toRepoPath(path.relative(root, entryPath)));
  }
}

function changedSkillFiles(root, runGit = execFileSync) {
  const mirror = resolveCodexRepoSkillsDir(root);
  const drift = generatedDriftPaths(root, runGit);
  const changed = [];
  for (const { name, sourcePath: sourceRoot } of listCanonicalSkills(root)) {
    walkRegularFiles(sourceRoot, (sourcePath, relative) => {
      const canonical = fs.readFileSync(sourcePath);
      const mirrorPath = path.join(mirror, name, relative);
      const repoPath = `.agents/skills/${name}/${relative}`;
      try {
        if (canonical.equals(fs.readFileSync(mirrorPath)) && !drift.has(repoPath)) return;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      changed.push({ path: repoPath, canonical, writeIntent: 'update' });
    });
  }
  walkRegularFiles(mirror, (mirrorPath, relative) => {
    const canonicalPath = path.join(root, 'skills', relative);
    if (!fs.existsSync(canonicalPath)) {
      changed.push({
        path: `.agents/skills/${relative}`,
        canonical: fs.readFileSync(mirrorPath),
        writeIntent: 'delete',
      });
    }
  });
  const seen = new Set(changed.map(file => file.path));
  for (const repoPath of drift) {
    if (!repoPath.startsWith('.agents/skills/') || seen.has(repoPath)) continue;
    const relative = repoPath.slice('.agents/skills/'.length);
    const canonicalPath = path.join(root, 'skills', relative);
    const mirrorPath = path.join(root, repoPath);
    if (fs.existsSync(canonicalPath) || fs.existsSync(mirrorPath)) continue;
    let priorContent;
    try {
      priorContent = runGit('git', ['show', `HEAD:${repoPath}`], {
        cwd: root,
        encoding: null,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      continue;
    }
    changed.push({ path: repoPath, canonical: priorContent, writeIntent: 'delete' });
  }
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

  const ambiguousCanonical = ambiguousCanonicalPaths(root, runGit);
  for (const canonicalPath of ambiguousCanonical) {
    const indexedCanonical = indexedFile(root, canonicalPath, runGit);
    const indexedMirror = indexedFile(root, `.agents/${canonicalPath}`, runGit);
    if (indexedCanonical === null ? indexedMirror !== null : indexedMirror === null || !indexedCanonical.equals(indexedMirror)) {
      throw new Error(`canonical index differs from generated mirror index: ${canonicalPath}`);
    }
  }
  if (ambiguousCanonical.size > 0) {
    throw new Error(`unstaged canonical skill changes must be reconciled before mirror sync: ${[...ambiguousCanonical].join(', ')}`);
  }

  const changed = changedSkillFiles(root, runGit);
  const authorizations = [];
  for (const file of changed) {
    const authorization = await issueAuthorization(root, {
      actor,
      path: file.path,
      sourceHead,
      writeIntent: file.writeIntent,
      ...(file.writeIntent === 'delete' ? { priorContent: file.canonical } : {}),
    });
    if (!authorization.success) throw new Error(`authorization failed for ${file.path}: ${authorization.error}`);
    authorizations.push({ ...file, capabilityId: authorization.capabilityId });
  }

  const { written } = populateCodexRepoSkills({ sourceRoot: root, projectRoot: root, clean: true });
  for (const file of authorizations) {
    const mirrorExists = fs.existsSync(path.join(root, file.path));
    if (file.writeIntent === 'delete' ? mirrorExists : !file.canonical.equals(fs.readFileSync(path.join(root, file.path)))) {
      throw new Error(`canonical mirror intent failed for ${file.path}`);
    }
    const completion = await completeAuthorization(root, {
      actor,
      path: file.path,
      sourceHead,
      capabilityId: file.capabilityId,
      writeIntent: file.writeIntent,
      ...(file.writeIntent === 'delete' ? { priorContent: file.canonical } : {}),
    });
    if (!completion.success) throw new Error(`completion failed for ${file.path}: ${completion.error}`);
  }

  const mirror = resolveCodexRepoSkillsDir(root);
  runGit('git', ['add', '--all', '--', mirror], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  console.log(`sync-agent-skills: .agents/skills in sync with skills/ (${written.length} skills)`);
  return { written, changed: changed.map(file => file.path), deferred: [], sourceHead };
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

module.exports = { actorFromEnv, changedSkillFiles, parseGitPaths, syncAgentSkills };
