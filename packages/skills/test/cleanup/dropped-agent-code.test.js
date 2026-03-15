/**
 * TDD test: Verify dropped agents (aider, antigravity, continue, windsurf)
 * have been removed from the skills package source and test files.
 *
 * "continue" as a JavaScript keyword (loop control) is allowed — only
 * references to Continue as an AI agent name should be absent.
 */

const { describe, test, expect } = require('bun:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const PKG = join(__dirname, '..', '..');

/**
 * Helper: find all non-comment lines in a file that match a pattern.
 * Ignores lines that are purely comments (// or * or #).
 */
function findAgentReferences(filePath, pattern) {
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const hits = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip comment-only lines
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) {
      continue;
    }

    if (pattern.test(line)) {
      hits.push({ lineNumber: i + 1, text: trimmed });
    }
  }
  return hits;
}

describe('Dropped-agent code removal', () => {
  const filesToCheck = [
    'src/lib/agents.js',
    'src/commands/sync.js',
    'test/agents.test.js',
    'test/sync.test.js',
  ];

  // Patterns that match dropped agent names as agent identifiers, not JS keywords.
  // For "continue": match it as a string literal ('continue' or "continue"), or as an
  // object key (name: 'continue'), or in a description referencing the Continue agent,
  // but NOT the bare `continue;` JS keyword.
  const droppedPatterns = [
    { name: 'aider', pattern: /\baider\b/i },
    { name: 'antigravity', pattern: /\bantigravity\b/i },
    { name: 'windsurf', pattern: /\bwindsurf\b/i },
    // Match "continue" only when it appears as a string value or agent reference,
    // not as the JS keyword `continue;`
    { name: 'continue (agent)', pattern: /['"]continue['"]|Continue\s+(VSCode|Extension|agent)/i },
  ];

  for (const relPath of filesToCheck) {
    const absPath = join(PKG, relPath);

    for (const { name, pattern } of droppedPatterns) {
      test(`${relPath} has no references to dropped agent: ${name}`, () => {
        const hits = findAgentReferences(absPath, pattern);
        if (hits.length > 0) {
          const details = hits.map(h => `  line ${h.lineNumber}: ${h.text}`).join('\n');
          throw new Error(
            `Found ${hits.length} reference(s) to dropped agent "${name}" in ${relPath}:\n${details}`
          );
        }
        expect(hits.length).toBe(0);
      });
    }
  }
});
