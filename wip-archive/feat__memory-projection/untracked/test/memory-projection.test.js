const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  MEMORY_START,
  MEMORY_END,
  selectMemoryEntries,
  renderProjectMemorySection,
  projectMemoryIntoContent,
  collectTypedMemoryEntries,
  renderCursorMemoryRule,
  projectMemoryIntoAgentsMd,
  projectMemoryIntoCursorRules,
} = require('../lib/memory-projection');

// Build a stored memory entry in the shape lib/project-memory list() returns
// (mirrors lib/kernel/sqlite-driver.js memoryRowToEntry).
function typedEntry(category, name, data, extra = {}) {
  return {
    key: `${category}:${name}`,
    value: {
      category,
      data,
      provenance: extra.provenance || { actor: 'test', reason: 'test', source: 'test' },
    },
    sourceAgent: extra.sourceAgent || 'test',
    tags: [category],
    timestamp: extra.timestamp || '2026-07-01T00:00:00.000Z',
    ...(extra.confidence !== undefined ? { confidence: extra.confidence } : {}),
  };
}

function fakeMemory(entries) {
  return { list: () => entries };
}

// A minimal AGENTS.md shaped like smartMergeAgentsMd output: USER + FORGE blocks + footer.
function agentsMdFixture() {
  return [
    '# AGENTS.md',
    '',
    '<!-- USER:START -->',
    'My hand-written project note. Keep me.',
    '<!-- USER:END -->',
    '',
    '<!-- FORGE:START v3 -->',
    'Forge workflow content.',
    '<!-- FORGE:END -->',
    '',
    '---',
    '',
    '## Improving This Workflow',
    '',
    'footer text',
    '',
  ].join('\n');
}

describe('memory-projection: selection + bounding', () => {
  test('filters to the 7 typed categories and ignores non-typed keys', () => {
    const selected = selectMemoryEntries([
      typedEntry('decisions', 'routing', 'Use kernel authority'),
      { key: 'random:thing', value: { data: 'not typed' }, timestamp: '2026-07-02T00:00:00Z' },
      typedEntry('preferences', 'editor', 'Use vim keys'),
    ]);
    const keys = selected.map(item => item.key);
    expect(keys).toContain('decisions:routing');
    expect(keys).toContain('preferences:editor');
    expect(keys).not.toContain('random:thing');
  });

  test('ranks highest-confidence first, then most-recent', () => {
    const selected = selectMemoryEntries([
      typedEntry('state', 'low', 'low conf', { confidence: 0.2, timestamp: '2026-07-05T00:00:00Z' }),
      typedEntry('decisions', 'high', 'high conf', { confidence: 0.9, timestamp: '2026-07-01T00:00:00Z' }),
      typedEntry('skills', 'recent', 'no conf recent', { timestamp: '2026-07-06T00:00:00Z' }),
      typedEntry('skills', 'old', 'no conf old', { timestamp: '2026-01-01T00:00:00Z' }),
    ]);
    expect(selected[0].name).toBe('high'); // highest confidence
    expect(selected[1].name).toBe('low');  // next confidence
    // no-confidence entries fall back to recency ordering
    expect(selected[2].name).toBe('recent');
    expect(selected[3].name).toBe('old');
  });

  test('caps by entry count', () => {
    const entries = Array.from({ length: 30 }, (_, i) =>
      typedEntry('skills', `s${i}`, `summary ${i}`, { confidence: i / 100 }));
    const selected = selectMemoryEntries(entries, { maxEntries: 5 });
    expect(selected.length).toBe(5);
  });

  test('caps by character budget', () => {
    const big = 'x'.repeat(300);
    const entries = Array.from({ length: 20 }, (_, i) =>
      typedEntry('skills', `s${i}`, big, { confidence: i / 100 }));
    const selected = selectMemoryEntries(entries, { maxChars: 500, maxEntries: 20 });
    // 300-char summaries: at most 2 fit under a 500-char budget.
    expect(selected.length).toBeLessThanOrEqual(2);
    expect(selected.length).toBeGreaterThanOrEqual(1);
  });
});

describe('memory-projection: rendering', () => {
  test('renders a bounded, marker-delimited Project Memory section', () => {
    const section = renderProjectMemorySection([
      typedEntry('decisions', 'routing', 'Use kernel authority', { confidence: 0.9 }),
      typedEntry('preferences', 'editor', 'Use vim keys'),
    ]);
    expect(section.startsWith(MEMORY_START)).toBe(true);
    expect(section.trimEnd().endsWith(MEMORY_END)).toBe(true);
    expect(section).toContain('## Project Memory');
    expect(section).toContain('Use kernel authority');
    expect(section).toContain('confidence 0.90');
    expect(section).toContain('**Decisions**');
    expect(section).toContain('**Preferences**');
  });

  test('renders empty string when there is nothing typed to project', () => {
    expect(renderProjectMemorySection([])).toBe('');
    expect(renderProjectMemorySection([{ key: 'x:y', value: {} }])).toBe('');
  });
});

describe('memory-projection: projectMemoryIntoContent', () => {
  test('inserts the block outside USER/FORGE blocks and preserves user content', () => {
    const before = agentsMdFixture();
    const after = projectMemoryIntoContent(before, [
      typedEntry('decisions', 'routing', 'Use kernel authority'),
    ]);
    expect(after).toContain('My hand-written project note. Keep me.');
    expect(after).toContain(MEMORY_START);
    expect(after).toContain('## Project Memory');
    // Block sits AFTER FORGE:END and BEFORE the footer, never inside USER markers.
    const userEnd = after.indexOf('<!-- USER:END -->');
    const forgeEnd = after.indexOf('<!-- FORGE:END -->');
    const memStart = after.indexOf(MEMORY_START);
    const footer = after.indexOf('## Improving This Workflow');
    expect(memStart).toBeGreaterThan(forgeEnd);
    expect(memStart).toBeGreaterThan(userEnd);
    expect(memStart).toBeLessThan(footer);
  });

  test('is idempotent — re-running produces identical content and no duplicate block', () => {
    const entries = [
      typedEntry('decisions', 'routing', 'Use kernel authority'),
      typedEntry('state', 'phase', 'shipping v3'),
    ];
    const once = projectMemoryIntoContent(agentsMdFixture(), entries);
    const twice = projectMemoryIntoContent(once, entries);
    expect(twice).toBe(once);
    const occurrences = twice.split(MEMORY_START).length - 1;
    expect(occurrences).toBe(1);
  });

  test('refreshes the block in place when memory changes', () => {
    const first = projectMemoryIntoContent(agentsMdFixture(), [
      typedEntry('decisions', 'routing', 'Use kernel authority'),
    ]);
    const second = projectMemoryIntoContent(first, [
      typedEntry('decisions', 'routing', 'Switched to Beads compat'),
    ]);
    expect(second.split(MEMORY_START).length - 1).toBe(1);
    expect(second).toContain('Switched to Beads compat');
    expect(second).not.toContain('Use kernel authority');
  });

  test('removes the block when there is nothing to project', () => {
    const withBlock = projectMemoryIntoContent(agentsMdFixture(), [
      typedEntry('decisions', 'routing', 'Use kernel authority'),
    ]);
    const cleared = projectMemoryIntoContent(withBlock, []);
    expect(cleared).not.toContain(MEMORY_START);
    expect(cleared).toContain('My hand-written project note. Keep me.');
  });
});

describe('memory-projection: collect via store seam', () => {
  test('reads through the injected memory adapter and returns typed selection', () => {
    const selected = collectTypedMemoryEntries('/proj', {
      memory: fakeMemory([
        typedEntry('issues', 'flaky-test', 'test-env fixture flakes on push'),
        { key: 'notyped', value: 'x' },
      ]),
    });
    expect(selected.map(item => item.key)).toEqual(['issues:flaky-test']);
  });

  test('degrades to empty selection when the store throws', () => {
    const selected = collectTypedMemoryEntries('/proj', {
      memory: { list() { throw new Error('no store'); } },
    });
    expect(selected).toEqual([]);
  });
});

describe('memory-projection: file writers', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memproj-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('projectMemoryIntoAgentsMd writes a marked block and is idempotent', () => {
    const agentsPath = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(agentsPath, agentsMdFixture(), 'utf8');
    const memory = fakeMemory([
      typedEntry('decisions', 'routing', 'Use kernel authority', { confidence: 0.8 }),
    ]);

    const first = projectMemoryIntoAgentsMd(dir, { memory });
    expect(first.changed).toBe(true);
    expect(first.entries).toBe(1);
    const written = fs.readFileSync(agentsPath, 'utf8');
    expect(written).toContain(MEMORY_START);
    expect(written).toContain('My hand-written project note. Keep me.');

    const second = projectMemoryIntoAgentsMd(dir, { memory });
    expect(second.changed).toBe(false);
    expect(fs.readFileSync(agentsPath, 'utf8')).toBe(written);
  });

  test('projectMemoryIntoAgentsMd no-ops when AGENTS.md is absent', () => {
    const result = projectMemoryIntoAgentsMd(dir, { memory: fakeMemory([]) });
    expect(result.changed).toBe(false);
    expect(result.reason).toBe('no-agents-md');
  });

  test('projectMemoryIntoCursorRules writes an always-on .mdc rule and is idempotent', () => {
    const memory = fakeMemory([
      typedEntry('preferences', 'editor', 'Use vim keys'),
    ]);
    const first = projectMemoryIntoCursorRules(dir, { memory });
    expect(first.changed).toBe(true);
    const rulePath = path.join(dir, '.cursor', 'rules', 'forge-memory.mdc');
    const content = fs.readFileSync(rulePath, 'utf8');
    expect(content).toContain('alwaysApply: true');
    expect(content).toContain(MEMORY_START);
    expect(content).toContain('Use vim keys');

    const second = projectMemoryIntoCursorRules(dir, { memory });
    expect(second.changed).toBe(false);
  });

  test('projectMemoryIntoCursorRules skips writing when there is nothing to project', () => {
    const result = projectMemoryIntoCursorRules(dir, { memory: fakeMemory([]) });
    expect(result.changed).toBe(false);
    expect(fs.existsSync(path.join(dir, '.cursor', 'rules', 'forge-memory.mdc'))).toBe(false);
  });
});

describe('memory-projection: renderCursorMemoryRule', () => {
  test('produces frontmatter + marked block', () => {
    const rule = renderCursorMemoryRule([typedEntry('state', 'phase', 'shipping v3')]);
    expect(rule.startsWith('---\n')).toBe(true);
    expect(rule).toContain('alwaysApply: true');
    expect(rule).toContain('## Project Memory');
    expect(rule).toContain('shipping v3');
  });
});

// Proves the whole point of the issue: typed memory is no longer WRITE-ONLY. We write
// through the real typed API (into the actual kernel_memories table) and read it back out
// via the projection using the REAL project-memory store seam.
describe('memory-projection: real kernel store round-trip', () => {
  const typedApi = require('../lib/memory/typed-api');
  let dir;
  let dbPath;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memproj-real-'));
    dbPath = path.join(dir, 'kernel.db');
  });
  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows can hold the sqlite file handle open; leaking a temp dir is harmless.
    }
  });

  test('typed write is read back and projected into AGENTS.md', () => {
    typedApi.writeDecision(dir, 'routing', 'Consolidate issue authority in the kernel', {
      provenance: { actor: 'forge test', reason: 'round-trip', source: 'test' },
      databasePath: dbPath,
    });
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), agentsMdFixture(), 'utf8');

    const result = projectMemoryIntoAgentsMd(dir, { databasePath: dbPath });
    expect(result.changed).toBe(true);
    expect(result.entries).toBeGreaterThanOrEqual(1);

    const written = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    expect(written).toContain(MEMORY_START);
    expect(written).toContain('Consolidate issue authority in the kernel');
  });
});
