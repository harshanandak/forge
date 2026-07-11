#!/usr/bin/env node
'use strict';

/**
 * Pre-commit auto-sync for the committed `.agents/skills` mirror.
 *
 * `.agents/skills` is Codex's repo-local discovery path and the ONE skill mirror
 * committed to the repo (so a teammate who clones WITHOUT running `forge setup`
 * still gets Forge skills/stages auto-discovered). It must stay byte-identical to
 * the canonical `skills/` source, which the structural drift gate enforces.
 *
 * This hook removes the regen friction: whenever `skills/**` is staged, it
 * regenerates `.agents/skills` from `skills/` (reusing the same
 * `populateCodexRepoSkills` / `populateAgentSkills` sync the drift gate checks
 * against) and re-stages it, so the committed mirror never drifts from canonical.
 *
 * It is intentionally scoped to `skills/**` via lefthook's `glob`, so it only runs
 * when the canonical source actually changes.
 */

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { populateCodexRepoSkills, resolveCodexRepoSkillsDir } = require('../lib/codex-skills');

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

function main() {
  const root = repoRoot();
  let written = [];
  try {
    // clean: true so skills removed from canonical are dropped from the mirror too.
    ({ written } = populateCodexRepoSkills({ sourceRoot: root, projectRoot: root, clean: true }));
  } catch (error) {
    console.error(`sync-agent-skills: failed to regenerate .agents/skills — ${error.message}`);
    process.exit(1);
  }

  const mirror = resolveCodexRepoSkillsDir(root);
  try {
    // Stage the regenerated mirror (and any deletions within it).
    execFileSync('git', ['add', '--all', '--', mirror], {
      cwd: root,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
  } catch (error) {
    console.error(`sync-agent-skills: failed to stage .agents/skills — ${error.message}`);
    process.exit(1);
  }

  console.log(`sync-agent-skills: .agents/skills in sync with skills/ (${written.length} skills)`);
}

main();
