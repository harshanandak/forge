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
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

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
    // Hardcoded grep command - no user input, safe from injection
    const result = execSync(
      'grep -rn "WORKFLOW\\.md" --include="*.js" --include="*.sh" --include="*.md" --include="*.json" --exclude-dir=node_modules --exclude-dir=.worktrees --exclude-dir=.git . || true',
      { cwd: ROOT, encoding: 'utf8', timeout: 10000 }
    );

    // Filter out allowed historical files
    const lines = result.split('\n').filter(line => {
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
