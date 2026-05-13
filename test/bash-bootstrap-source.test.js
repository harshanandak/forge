'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { describe, test, expect } = require('bun:test');

const repoRoot = path.resolve(__dirname, '..');
const helperPath = path.join(repoRoot, 'scripts', 'bootstrap-windows-tools.sh');

const entrypointPaths = [
  'install.sh',
  'scripts/beads-context.sh',
  'scripts/beads-upgrade-smoke.sh',
  'scripts/behavioral-judge.sh',
  'scripts/conflict-detect.sh',
  'scripts/dep-guard.sh',
  'scripts/file-index.sh',
  'scripts/forge-team/index.sh',
  'scripts/pr-coordinator.sh',
  'scripts/preflight.sh',
  'scripts/smart-status.sh',
  'scripts/sync-utils.sh',
  'scripts/validate.sh',
  '.claude/scripts/greptile-resolve.sh',
];

function readsTool(content) {
  return stripCommentLines(content)
    .some((line) => /(^|[^A-Za-z0-9_])(bd|jq|gh)([^A-Za-z0-9_]|$)/.test(line));
}

function stripCommentLines(content) {
  return content
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'));
}

function sourcesBootstrapHelper(content) {
  return stripCommentLines(content)
    .some((line) => /\b(?:source|\.)\s+["']?[^#\n]*bootstrap-windows-tools\.sh["']?/.test(line));
}

describe('Windows/WSL bash bootstrap sourcing', () => {
  test('provides the shared Windows tool bootstrap helper', () => {
    expect(fs.existsSync(helperPath)).toBe(true);
  });

  test('bash entrypoints using bd, jq, or gh source the shared helper', () => {
    const offenders = entrypointPaths.filter((relativePath) => {
      const absolutePath = path.join(repoRoot, relativePath);
      const content = fs.readFileSync(absolutePath, 'utf8');
      return readsTool(content) && !sourcesBootstrapHelper(content);
    });

    expect(offenders).toEqual([]);
  });
});
