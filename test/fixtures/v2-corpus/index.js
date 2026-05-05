const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CORPUS_ROOT = __dirname;
const REPOS_ROOT = path.join(CORPUS_ROOT, 'repos');
const WORKFLOW_STAGE_MATRIX = {
  critical: ['plan', 'dev', 'validate', 'ship', 'review', 'premerge', 'verify'],
  standard: ['plan', 'dev', 'validate', 'ship', 'review', 'premerge'],
  refactor: ['plan', 'dev', 'validate', 'ship', 'premerge'],
  simple: ['dev', 'validate', 'ship'],
  hotfix: ['dev', 'validate', 'ship'],
  docs: ['verify', 'ship'],
};

const COMMON_V2_FILES = [
  {
    path: 'AGENTS.md',
    lines: [
      '# AGENTS.md',
      '',
      '<!-- BEGIN FORGE V2 GENERATED WORKFLOW -->',
      '## Critical Behavior Rule - Scope Discipline',
      '',
      'Do only what was explicitly asked, verify claims before stating facts, and keep work scoped to the current request.',
      '',
      '## WORKFLOW_STAGE_MATRIX',
      '',
      '| Classification | Stages |',
      '| --- | --- |',
      '| critical | plan -> dev -> validate -> ship -> review -> premerge -> verify |',
      '| standard | plan -> dev -> validate -> ship -> review -> premerge |',
      '| refactor | plan -> dev -> validate -> ship -> premerge |',
      '| simple | dev -> validate -> ship |',
      '| hotfix | dev -> validate -> ship |',
      '| docs | verify -> ship |',
      '<!-- END FORGE V2 GENERATED WORKFLOW -->',
    ],
  },
  {
    path: '.claude/commands/plan.md',
    lines: [
      '# /plan',
      '',
      'Use WORKFLOW_STAGE_MATRIX to classify work, then create design.md and tasks.md before implementation.',
    ],
  },
  {
    path: '.claude/commands/dev.md',
    lines: [
      '# /dev',
      '',
      'Implement tasks with TDD and update Beads context after each completed task.',
    ],
  },
  {
    path: '.codex/skills/plan/SKILL.md',
    lines: [
      '---',
      'description: v2 plan skill fixture',
      '---',
      '',
      'Read AGENTS.md, follow WORKFLOW_STAGE_MATRIX, and keep generated files in sync.',
    ],
  },
  {
    path: '.forge/v2/workflow-stage-matrix.json',
    json: WORKFLOW_STAGE_MATRIX,
  },
  {
    path: '.forge/l1/rails.json',
    json: {
      version: 1,
      rails: [
        'scope-discipline',
        'verified-claims',
        'tdd-first',
        'protected-generated-artifacts',
        'beads-source-of-truth',
      ],
    },
  },
];

function listFixtureNames() {
  return fs.readdirSync(REPOS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(REPOS_ROOT, name, 'manifest.json')))
    .sort();
}

function readManifest(name) {
  const manifestPath = path.join(REPOS_ROOT, name, 'manifest.json');
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

function ensureInside(root, target) {
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Fixture path escapes target root: ${target}`);
  }
}

function writeFixtureFile(repoRoot, file) {
  const target = path.join(repoRoot, file.path);
  ensureInside(repoRoot, target);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  let content;
  if (Object.prototype.hasOwnProperty.call(file, 'json')) {
    content = `${JSON.stringify(file.json, null, 2)}\n`;
  } else if (Object.prototype.hasOwnProperty.call(file, 'jsonl')) {
    content = file.jsonl.map((line) => (
      typeof line === 'string' ? line : JSON.stringify(line)
    )).join('\n');
    content = `${content}\n`;
  } else if (Object.prototype.hasOwnProperty.call(file, 'lines')) {
    content = `${file.lines.join('\n')}\n`;
  } else {
    content = file.content || '';
  }

  fs.writeFileSync(target, content, 'utf8');
  if (file.executable) {
    fs.chmodSync(target, 0o755);
  }
}

function git(repoRoot, args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function initGitRepo(repoRoot, manifest) {
  fs.mkdirSync(repoRoot, { recursive: true });

  try {
    git(repoRoot, ['init', '--initial-branch', manifest.defaultBranch]);
  } catch (_error) {
    git(repoRoot, ['init']);
    git(repoRoot, ['checkout', '-B', manifest.defaultBranch]);
  }

  git(repoRoot, ['config', 'user.email', 'fixtures@example.test']);
  git(repoRoot, ['config', 'user.name', 'Forge Fixture']);
}

function writeCommonV2InstallFiles(repoRoot) {
  for (const file of COMMON_V2_FILES) {
    writeFixtureFile(repoRoot, file);
  }
}

function commitFixture(repoRoot, manifest) {
  git(repoRoot, ['add', '-A']);
  git(repoRoot, ['commit', '-m', manifest.initialCommit || 'seed v2 fixture']);

  for (const branch of manifest.git.branches || []) {
    if (branch !== manifest.defaultBranch) {
      git(repoRoot, ['branch', branch]);
    }
  }
  git(repoRoot, ['checkout', manifest.defaultBranch]);
}

function installHookShims(repoRoot, hooks) {
  const hooksDir = path.join(repoRoot, '.lefthook', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });

  for (const hook of hooks || []) {
    const hookPath = path.join(hooksDir, hook.name);
    ensureInside(path.join(repoRoot, '.lefthook'), hookPath);
    fs.writeFileSync(hookPath, `${hook.lines.join('\n')}\n`, 'utf8');
    fs.chmodSync(hookPath, 0o755);
  }
}

function seedStaleWorktrees(repoRoot, worktrees) {
  const gitDir = path.join(repoRoot, '.git');
  for (const worktree of worktrees || []) {
    const staleDir = path.join(gitDir, 'worktrees', worktree.name);
    ensureInside(gitDir, staleDir);
    fs.mkdirSync(staleDir, { recursive: true });
    fs.writeFileSync(
      path.join(staleDir, 'gitdir'),
      `${path.join(os.tmpdir(), worktree.missingPath || `missing-${worktree.name}`, '.git')}\n`,
      'utf8',
    );
    fs.writeFileSync(path.join(staleDir, 'HEAD'), `${worktree.head || 'ref: refs/heads/stale'}\n`, 'utf8');
    fs.writeFileSync(path.join(staleDir, 'commondir'), '../..\n', 'utf8');
    if (worktree.locked) {
      fs.writeFileSync(path.join(staleDir, 'locked'), `${worktree.locked}\n`, 'utf8');
    }
  }
}

function materializeFixture(name, options = {}) {
  const manifest = readManifest(name);
  const parent = options.targetRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'forge-v2-corpus-'));
  const repoRoot = path.join(parent, manifest.name);

  initGitRepo(repoRoot, manifest);
  writeCommonV2InstallFiles(repoRoot);
  for (const file of manifest.files) {
    writeFixtureFile(repoRoot, file);
  }
  commitFixture(repoRoot, manifest);
  installHookShims(repoRoot, manifest.git.hooks);
  seedStaleWorktrees(repoRoot, manifest.git.staleWorktrees);

  return { manifest, repoRoot };
}

function materializeAllFixtures(options = {}) {
  return listFixtureNames().map((name) => materializeFixture(name, options));
}

function validateMaterializedFixture(repoRoot, manifest) {
  const failures = [];
  const currentBranch = git(repoRoot, ['branch', '--show-current']);

  if (currentBranch !== manifest.defaultBranch) {
    failures.push(`expected default branch ${manifest.defaultBranch}, got ${currentBranch}`);
  }

  for (const filePath of manifest.expectations.requiredFiles || []) {
    if (!fs.existsSync(path.join(repoRoot, filePath))) {
      failures.push(`missing required file ${filePath}`);
    }
  }

  if (manifest.expectations.beadsBackend) {
    const configPath = path.join(repoRoot, '.beads', 'config.yaml');
    const config = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
    if (!config.includes(`backend: ${manifest.expectations.beadsBackend}`)) {
      failures.push(`expected Beads backend ${manifest.expectations.beadsBackend}`);
    }
  }

  const matrixPath = path.join(repoRoot, '.forge', 'v2', 'workflow-stage-matrix.json');
  if (!fs.existsSync(matrixPath)) {
    failures.push('missing v2 WORKFLOW_STAGE_MATRIX fixture');
  }

  const lefthookConfig = fs.existsSync(path.join(repoRoot, 'lefthook.yml'));
  const preCommitHook = fs.existsSync(path.join(repoRoot, '.lefthook', 'hooks', 'pre-commit'));
  const prePushHook = fs.existsSync(path.join(repoRoot, '.lefthook', 'hooks', 'pre-push'));
  if (manifest.expectations.lefthookInstalled && (!lefthookConfig || !preCommitHook || !prePushHook)) {
    failures.push('expected Lefthook config and installed pre-commit/pre-push shims');
  }
  if (manifest.expectations.lefthookInstalled === false && (lefthookConfig || preCommitHook || prePushHook)) {
    failures.push('expected no Lefthook config or installed hook shims');
  }

  const worktreeRoot = path.join(repoRoot, '.git', 'worktrees');
  const staleCount = fs.existsSync(worktreeRoot) ? fs.readdirSync(worktreeRoot).length : 0;
  if ((manifest.expectations.staleWorktrees || 0) !== staleCount) {
    failures.push(`expected ${manifest.expectations.staleWorktrees || 0} stale worktrees, got ${staleCount}`);
  }

  return {
    ok: failures.length === 0,
    failures,
  };
}

function validateCorpus() {
  const results = materializeAllFixtures().map(({ manifest, repoRoot }) => ({
    name: manifest.name,
    repoRoot,
    ...validateMaterializedFixture(repoRoot, manifest),
  }));

  const failed = results.filter((result) => !result.ok);
  if (failed.length > 0) {
    const details = failed.map((result) => `${result.name}: ${result.failures.join('; ')}`).join('\n');
    throw new Error(details);
  }
  return results;
}

if (require.main === module) {
  const results = validateCorpus();
  for (const result of results) {
    console.log(`ok ${result.name} ${result.repoRoot}`);
  }
  console.log(`validated ${results.length} v2 fixtures`);
}

module.exports = {
  CORPUS_ROOT,
  listFixtureNames,
  readManifest,
  materializeFixture,
  materializeAllFixtures,
  validateMaterializedFixture,
  validateCorpus,
};
