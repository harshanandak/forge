/**
 * Docs-bleed guard for AGENTS.md.
 *
 * AGENTS.md has two audiences in one file:
 *
 *   <!-- FORGE:START --> … <!-- FORGE:END -->   the PRODUCT contract. Rendered by
 *       Forge, shipped to every user, and read by people who have never seen this
 *       repository. It must not name repo-local machinery — our scripts, our hook
 *       config, our generated mirrors, our dated design docs, or anyone's machine.
 *
 *   <!-- USER:START --> … <!-- USER:END -->      OURS. The maintainer contract.
 *       Preserved across `forge setup` by smartMergeAgentsMd (lib/smart-merge.js).
 *
 * Maintainer trivia that leaks into the FORGE block is the exact user-docs /
 * maintainer-docs bleed this gate exists to stop.
 *
 * Two kinds of assertion below:
 *
 *   1. CLEAN_PATTERNS — hard gate. These do not appear in the FORGE block today
 *      and must never appear. Adding one fails this test.
 *   2. KNOWN_BLEED — ratchet. These leaked before this gate existed and cannot be
 *      removed yet: AGENTS.md is protected state (`generated_harness`) and no Forge
 *      command can currently authorize a commit to it, so the cleanup lands in a
 *      follow-up. Counts may only go DOWN. An entry whose count reaches zero must
 *      be deleted from the list — the test fails on a stale entry, so the list
 *      tightens itself instead of rotting into an allowlist.
 */

const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const agentsPath = path.join(repoRoot, 'AGENTS.md');

/** Repo-local machinery that must never be named in the shipped product block. */
const CLEAN_PATTERNS = [
  'C:\\Users',
  'C:/Users',
  '/home/',
  '/Users/',
  'lefthook.yml',
  'scripts/',
  'node_modules',
  '.claude/scripts',
  '.claude/rules',
  '.forge/hooks',
  'bun.lock',
];

/**
 * Pre-existing bleed, with the count observed when this gate was added
 * (2026-08-13). Counts may only shrink; a zeroed entry must be removed.
 */
const KNOWN_BLEED = [
  { pattern: '.agents/skills', max: 1 },
  { pattern: 'test-env/', max: 1 },
  { pattern: 'rules/kernel-tracking.md', max: 2 },
  { pattern: 'docs/work/2026-', max: 11 },
];

function readAgentsMd() {
  return fs.readFileSync(agentsPath, 'utf8').replace(/\r\n?/g, '\n');
}

function extractBlock(content, name) {
  const match = new RegExp(`<!-- ${name}:START.*?-->([\\s\\S]*?)<!-- ${name}:END -->`).exec(content);
  return match ? match[1] : null;
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

describe('AGENTS.md docs bleed', () => {
  test('the FORGE block exists and is delimited', () => {
    const forgeBlock = extractBlock(readAgentsMd(), 'FORGE');
    expect(forgeBlock).not.toBeNull();
    expect(forgeBlock.trim().length).toBeGreaterThan(0);
  });

  test('the FORGE block names no repo-local machinery or machine paths', () => {
    const forgeBlock = extractBlock(readAgentsMd(), 'FORGE');
    const offenders = CLEAN_PATTERNS
      .filter((pattern) => forgeBlock.includes(pattern))
      .map((pattern) => `  "${pattern}" appears in the FORGE block`);

    if (offenders.length > 0) {
      throw new Error(
        'Maintainer-only detail leaked into the shipped product block.\n' +
        `${offenders.join('\n')}\n` +
        'Move it into the AGENTS.md USER block or .forge/contributor-skills/.'
      );
    }
    expect(offenders).toEqual([]);
  });

  test('pre-existing bleed never grows, and a cleaned-up entry is removed from the list', () => {
    const forgeBlock = extractBlock(readAgentsMd(), 'FORGE');
    for (const { pattern, max } of KNOWN_BLEED) {
      const count = countOccurrences(forgeBlock, pattern);
      expect(count).toBeLessThanOrEqual(max);
      // Ratchet: once a pattern is gone, its KNOWN_BLEED entry must go too,
      // otherwise the list silently becomes a permanent allowlist.
      expect(count).toBeGreaterThan(0);
    }
  });

  // Pending: AGENTS.md is protected state (surface `generated_harness`) and the
  // only command that can authorize a protected-state write is
  // `forge release generate-npm-workflow` (NPM_WORKFLOW_SOURCE_COMMAND,
  // lib/protected-state-authority.js). No writer exists for a USER-block edit,
  // so the maintainer contract cannot be committed into AGENTS.md yet. Its text
  // is held at docs/work/2026-08-13-agents-maintainer-contract/agents-user-block.md.
  // Promote this to a real test in the PR that lands the block.
  test.todo('AGENTS.md carries a USER block with the maintainer contract');
});
