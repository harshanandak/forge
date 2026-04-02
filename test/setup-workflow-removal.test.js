/**
 * @fileoverview Tests that docs/WORKFLOW.md has been fully removed and
 * no active source file references it as a live link.
 *
 * Historical files (docs/plans/*, docs/research/*, CHANGELOG.md) are excluded
 * since they may legitimately reference removed files.
 */
const { describe, test, expect } = require('bun:test');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function collectWorkflowReferences(rootDir) {
  const results = [];
  const allowedExts = new Set(['.js', '.sh', '.md', '.json']);
  const excludedPrefixes = [
    '.git/',
    '.worktrees/',
    '.beads/',
    'docs/plans/',
    'docs/research/',
    'node_modules/',
    'test/',
    'test-env/'
  ];

  const trackedFiles = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard'],
    { cwd: rootDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
  )
    .split(/\r?\n/)
    .filter(Boolean);

  for (const relativeFile of trackedFiles) {
    const normalizedFile = relativeFile.replace(/\\/g, '/');
    if (excludedPrefixes.some(prefix => normalizedFile.startsWith(prefix))) {
      continue;
    }

    if (!allowedExts.has(path.extname(normalizedFile))) {
      continue;
    }

    const fullPath = path.join(rootDir, normalizedFile);
    const content = fs.readFileSync(fullPath, 'utf8');
    if (!content.includes('WORKFLOW.md')) {
      continue;
    }

    const lines = content.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (line.includes('WORKFLOW.md')) {
        results.push(`./${normalizedFile}:${index + 1}: ${line.trim()}`);
      }
    });
  }

  return results;
}

describe('docs/WORKFLOW.md removal', () => {
  test('docs/WORKFLOW.md file does not exist', () => {
    const workflowPath = path.join(ROOT, 'docs', 'WORKFLOW.md');
    expect(fs.existsSync(workflowPath)).toBe(false);
  });

  test('bin/forge.js does not reference WORKFLOW.md in file copy list or console output', () => {
    const content = fs.readFileSync(path.join(ROOT, 'bin', 'forge.js'), 'utf8');
    // Should not contain docs/WORKFLOW.md as a live reference
    expect(content).not.toContain("docs/WORKFLOW.md");
    expect(content).not.toContain('hasDocsWorkflow');
  });

  test('lib/agents-config.js does not reference WORKFLOW.md', () => {
    const content = fs.readFileSync(path.join(ROOT, 'lib', 'agents-config.js'), 'utf8');
    expect(content).not.toContain('WORKFLOW.md');
  });

  test('install.sh does not reference WORKFLOW.md', () => {
    const content = fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf8');
    expect(content).not.toContain('WORKFLOW.md');
  });

  test('no active source file contains docs/WORKFLOW.md as a live reference', () => {
    const lines = collectWorkflowReferences(ROOT).filter(line => {
      if (!line.trim()) return false;
      // Allow historical/research/plan files
      if (line.startsWith('./docs/plans/')) return false;
      if (line.startsWith('./docs/research/')) return false;
      if (line.startsWith('./CHANGELOG.md')) return false;
      // Allow node_modules
      if (line.includes('node_modules/')) return false;
      // Allow test files (may reference WORKFLOW.md in comments/assertions)
      if (line.startsWith('./test/')) return false;
      // Allow .beads/ internal data
      if (line.startsWith('./.beads/')) return false;
      // Allow worktrees (isolated copies of repo)
      if (line.startsWith('./.worktrees/')) return false;
      return true;
    });

    expect(lines).toEqual([]);
  });
});
