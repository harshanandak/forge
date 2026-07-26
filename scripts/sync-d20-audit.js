#!/usr/bin/env node
'use strict';

/**
 * Pre-commit auto-heal for the D20 bd call-site kill-list artifact.
 *
 * The `d20-audit-artifact-current` release gate compares the checked-in kill-list
 * against a live re-scan, so any commit that shifts the bd call-site census leaves the
 * artifact stale until someone runs `forge release regen-audit`. Five builders in a row
 * forgot, and each found out a full CI round later (kernel issue 4cf2c43d).
 *
 * This removes the regen from the human's list, the same way scripts/sync-agent-skills.js
 * removed the `.agents/skills` mirror regen: gate on a cheap changed-path predicate,
 * regenerate, re-stage, succeed quietly. The release gate stays as the backstop for
 * anything committed without this hook.
 *
 * The predicate is `isBdCensusPath`, exported by the gate's own module, so the hook and
 * the gate always agree on which files count. The artifact itself is not a census path,
 * so re-staging it cannot re-trigger the hook.
 *
 * The guarantee, stated honestly: the auto-heal applies when the counted staged paths
 * match the working tree. It decides from the index but regenerates from the working tree
 * (`auditBdCallSites` walks the filesystem), so those two agree only when the counted paths
 * are staged whole. When any of them is partially staged the hook regenerates nothing, says
 * so on stderr, and defers to a manual `forge release regen-audit` plus the
 * `d20-audit-artifact-current` release gate — which still fails a genuinely stale artifact.
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { AUDIT_ARTIFACT, isBdCensusPath, writeAuditArtifact } = require('../lib/release-readiness');

function repoRoot(exec = execFileSync) {
  try {
    return exec('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return path.resolve(__dirname, '..');
  }
}

/**
 * Parses `git diff --cached --name-status -z`: a flat NUL-delimited token stream of a
 * status followed by its path — `A\0path\0`, and `R100\0old\0new\0` for a rename or copy,
 * which is read from both sides because both shift the census (the old path leaves it and
 * the new one may not enter it).
 *
 * NUL delimiting is what makes this safe. Git's default output quotes and backslash-
 * escapes pathnames with non-ASCII or special characters, and no line/tab split can
 * represent a pathname that itself contains a tab or a newline. Under -z the pathnames are
 * verbatim, so nothing here may trim them — a mis-read path silently drops a
 * census-impacting change and skips the regen this hook exists to perform.
 */
function parseStagedNameStatus(output) {
  const tokens = output.split('\0');
  const files = [];

  for (let index = 0; index < tokens.length; index++) {
    const status = tokens[index];
    if (status.length === 0) {
      continue;
    }
    const pathCount = /^[RC]/.test(status) ? 2 : 1;
    files.push(...tokens.slice(index + 1, index + 1 + pathCount).filter(Boolean));
    index += pathCount;
  }

  return [...new Set(files)];
}

function stagedPaths(projectRoot, exec = execFileSync) {
  return parseStagedNameStatus(
    exec('git', ['-C', projectRoot, 'diff', '--cached', '--name-status', '-z', '--diff-filter=ACMRDT'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }),
  );
}

/**
 * Parses a bare NUL-delimited path list (`git diff --name-only -z`). Same rule as
 * parseStagedNameStatus: under -z the pathnames are verbatim, so nothing here may trim them.
 */
function parseNulPaths(output) {
  return output.split('\0').filter(Boolean);
}

/**
 * Of the given paths, the ones whose working-tree content differs from their staged content.
 * `git diff` without `--cached` is index-vs-worktree, which is exactly the question the
 * auto-heal must answer before regenerating an artifact it builds from the working tree.
 */
function worktreeModifiedPaths(projectRoot, paths, exec = execFileSync) {
  if (paths.length === 0) {
    return [];
  }

  return parseNulPaths(
    exec('git', ['-C', projectRoot, 'diff', '--name-only', '-z', '--', ...paths], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }),
  );
}

function stageArtifact(projectRoot, relativePath) {
  execFileSync('git', ['-C', projectRoot, 'add', '--', relativePath], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

function run(deps) {
  const { projectRoot, staged, worktreeModified, isCensusPath, writeArtifact, stage, log, warn } = deps;

  const triggers = staged().filter(filePath => isCensusPath(projectRoot, filePath));
  if (triggers.length === 0) {
    return { regenerated: false, triggers: [], partiallyStaged: [] };
  }

  const partiallyStaged = worktreeModified(projectRoot, triggers);
  if (partiallyStaged.length > 0) {
    warn(
      `sync-d20-audit: SKIPPED — the index is partially staged, so ${AUDIT_ARTIFACT} was NOT regenerated.\n` +
      `  Staged and separately modified in the working tree: ${partiallyStaged.join(', ')}\n` +
      '  The artifact is built from the working tree, so regenerating it now would commit a\n' +
      '  census of content this commit does not contain.\n' +
      `  Run \`forge release regen-audit\` and stage ${AUDIT_ARTIFACT} yourself if this commit\n` +
      '  shifts the bd call-site census; the d20-audit-artifact-current gate checks it either way.',
    );
    return { regenerated: false, triggers, partiallyStaged };
  }

  writeArtifact(projectRoot);
  stage(projectRoot, AUDIT_ARTIFACT);
  log(`sync-d20-audit: regenerated ${AUDIT_ARTIFACT} (census paths staged: ${triggers.join(', ')})`);
  return { regenerated: true, triggers, partiallyStaged: [] };
}

function main() {
  const projectRoot = repoRoot();
  try {
    run({
      projectRoot,
      staged: () => stagedPaths(projectRoot),
      worktreeModified: (root, paths) => worktreeModifiedPaths(root, paths),
      isCensusPath: isBdCensusPath,
      writeArtifact: root => writeAuditArtifact(root),
      stage: stageArtifact,
      log: message => console.log(message),
      warn: message => console.error(message),
    });
  } catch (error) {
    console.error(`sync-d20-audit: failed to regenerate ${AUDIT_ARTIFACT} — ${error.message}`);
    console.error('Run `forge release regen-audit` and stage the result, or fix the error above.');
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  run,
  parseStagedNameStatus,
  parseNulPaths,
  stagedPaths,
  worktreeModifiedPaths,
  repoRoot,
};
