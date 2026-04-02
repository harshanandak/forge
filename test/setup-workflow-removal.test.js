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

const ROOT = path.resolve(__dirname, '..');

function collectWorkflowReferences(rootDir) {
  const results = [];
  const allowedDirs = new Set(['node_modules', '.worktrees', '.git']);
  const allowedExts = new Set(['.js', '.sh', '.md', '.json']);

  function walk(currentDir) {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      const relPath = `.${path.sep}${path.relative(rootDir, fullPath)}`.replace(/\\/g, '/');

      if (entry.isDirectory()) {
        if (!allowedDirs.has(entry.name)) {
          walk(fullPath);
        }
        continue;
      }

      if (!allowedExts.has(path.extname(entry.name))) {
        continue;
      }

      const content = fs.readFileSync(fullPath, 'utf8');
      if (!content.includes('WORKFLOW.md')) {
        continue;
      }

      const lines = content.split(/\r?\n/);
      lines.forEach((line, index) => {
        if (line.includes('WORKFLOW.md')) {
          results.push(`${relPath}:${index + 1}: ${line.trim()}`);
        }
      });
    }
  }

  walk(rootDir);
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
