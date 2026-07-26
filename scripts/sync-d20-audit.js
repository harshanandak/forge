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

function stageArtifact(projectRoot, relativePath) {
  execFileSync('git', ['-C', projectRoot, 'add', '--', relativePath], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

function run(deps) {
  const { projectRoot, staged, isCensusPath, writeArtifact, stage, log } = deps;

  const triggers = staged().filter(filePath => isCensusPath(projectRoot, filePath));
  if (triggers.length === 0) {
    return { regenerated: false, triggers: [] };
  }

  writeArtifact(projectRoot);
  stage(projectRoot, AUDIT_ARTIFACT);
  log(`sync-d20-audit: regenerated ${AUDIT_ARTIFACT} (census paths staged: ${triggers.join(', ')})`);
  return { regenerated: true, triggers };
}

function main() {
  const projectRoot = repoRoot();
  try {
    run({
      projectRoot,
      staged: () => stagedPaths(projectRoot),
      isCensusPath: isBdCensusPath,
      writeArtifact: root => writeAuditArtifact(root),
      stage: stageArtifact,
      log: message => console.log(message),
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

module.exports = { run, parseStagedNameStatus, stagedPaths, repoRoot };
