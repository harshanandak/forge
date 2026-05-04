const { describe, test, expect } = require('bun:test');
const { readFileSync, existsSync } = require('fs');
const { join } = require('path');

/**
 * Test: Dropped-agent references are removed from docs.
 *
 * Scans doc files for references to dropped agents/tools:
 *   antigravity, windsurf, windsurfrules, .agent/, GEMINI.md, /research <slug>
 *
 * Allowed exceptions:
 *   - CHANGELOG.md (historical)
 *   - docs/plans/ (historical design docs)
 */

const ROOT = join(__dirname, '..', '..');

// Patterns to detect dropped-agent references
const PATTERNS = [
  { regex: /antigravity/i, label: 'antigravity' },
  { regex: /windsurf/i, label: 'windsurf' },
  { regex: /windsurfrules/i, label: 'windsurfrules' },
  { regex: /\.agent\//i, label: '.agent/' },
  { regex: /GEMINI\.md/i, label: 'GEMINI.md' },
  // Match /research as a command — followed by space or backtick (but not the word "research" in prose)
  { regex: /\/research[\s`]/i, label: '/research command' },
  // Aider references (dropped agent)
  { regex: /\baider\b/i, label: 'aider' },
  // Continue agent references — match ".continue/" dir or "Continue" as agent name in lists
  // (not the English word "continue" in prose)
  { regex: /\.continue\//i, label: '.continue/' },
];

// Files to scan (relative to ROOT)
const DOC_FILES = [
  'docs/reference/EXAMPLES.md',
  'docs/reference/TOOLCHAIN.md',
  'docs/guides/AGENT_INSTALL_PROMPT.md',
  'docs/reference/agent-permissions.md',
  'docs/reference/dependency-chain.md',
  'docs/reference/test-environment.md',
  'lib/agents/README.md',
];

describe('dropped-agent references in docs', () => {
  for (const relPath of DOC_FILES) {
    const filePath = join(ROOT, relPath);

    test(`${relPath} has no dropped-agent references`, () => {
      expect(existsSync(filePath)).toBe(true);

      const content = readFileSync(filePath, 'utf-8');

      for (const { regex, label } of PATTERNS) {
        const matches = content.match(new RegExp(regex.source, 'gi'));
        if (matches) {
          // Build a helpful error message showing which lines matched
          const lines = content.split('\n');
          const matchingLines = [];
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              matchingLines.push(`  L${i + 1}: ${lines[i].trim()}`);
            }
          }
          throw new Error(
            `Found '${label}' in ${relPath} (${matches.length} match(es)):\n${matchingLines.join('\n')}`
          );
        }
      }
    });
  }
});
