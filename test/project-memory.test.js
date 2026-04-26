const { describe, test, expect, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectMemory = require('../lib/project-memory');

const tempRoots = [];

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-project-memory-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('project memory', () => {
  test('writes entries to the default .forge/memory JSONL file and reads them back', () => {
    const root = tempRoot();

    const entry = projectMemory.write(root, {
      key: 'policy.stage-order',
      value: 'Run /plan before /dev for standard feature work.',
      sourceAgent: 'Codex',
      timestamp: '2026-04-26T00:00:00.000Z',
      tags: ['policy', 'workflow'],
      scope: 'project',
      confidence: 0.95,
      beadsRefs: ['forge-xdh7', 'forge-f3lx'],
    });

    expect(entry).toEqual({
      key: 'policy.stage-order',
      value: 'Run /plan before /dev for standard feature work.',
      sourceAgent: 'Codex',
      timestamp: '2026-04-26T00:00:00.000Z',
      tags: ['policy', 'workflow'],
      scope: 'project',
      confidence: 0.95,
      beadsRefs: ['forge-xdh7', 'forge-f3lx'],
    });

    const memoryFile = path.join(root, '.forge', 'memory', 'entries.jsonl');
    expect(fs.existsSync(memoryFile)).toBe(true);
    const lines = fs.readFileSync(memoryFile, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      key: 'policy.stage-order',
      'source-agent': 'Codex',
      'beads-refs': ['forge-xdh7', 'forge-f3lx'],
    });
    expect(projectMemory.read(root, 'policy.stage-order')).toEqual(entry);
    expect(projectMemory.list(root)).toEqual([entry]);
  });

  test('upserts entries by key without duplicating previous decisions', () => {
    const root = tempRoot();

    projectMemory.write(root, {
      key: 'preference.agent-surface',
      value: 'Support Claude and Codex first.',
      sourceAgent: 'Claude',
      timestamp: '2026-04-26T00:00:00.000Z',
      tags: ['preference'],
    });
    projectMemory.write(root, {
      key: 'preference.agent-surface',
      value: 'Support Claude, Cursor, Codex, Cline, and OpenCode.',
      sourceAgent: 'Codex',
      timestamp: '2026-04-26T00:01:00.000Z',
      tags: ['preference', 'agents'],
    });

    expect(projectMemory.list(root)).toHaveLength(1);
    expect(projectMemory.read(root, 'preference.agent-surface')).toMatchObject({
      value: 'Support Claude, Cursor, Codex, Cline, and OpenCode.',
      sourceAgent: 'Codex',
      tags: ['preference', 'agents'],
    });
  });

  test('searches keys, string values, source agents, and tags case-insensitively', () => {
    const root = tempRoot();

    projectMemory.write(root, {
      key: 'decision.memory-format',
      value: { format: 'json', directory: '.forge/memory' },
      sourceAgent: 'Cursor',
      timestamp: '2026-04-26T00:00:00.000Z',
      tags: ['decision', 'memory'],
    });
    projectMemory.write(root, {
      key: 'policy.issue-tracking',
      value: 'Memory complements Beads and does not replace issue lifecycle state.',
      sourceAgent: 'Codex',
      timestamp: '2026-04-26T00:01:00.000Z',
      tags: ['policy', 'beads'],
    });

    expect(projectMemory.search(root, 'json')).toHaveLength(1);
    expect(projectMemory.search(root, 'BEADS')[0].key).toBe('policy.issue-tracking');
    expect(projectMemory.search(root, 'cursor')[0].key).toBe('decision.memory-format');
    expect(projectMemory.search(root, 'memory')).toHaveLength(2);
  });

  test('searches optional shared-memory metadata fields', () => {
    const root = tempRoot();

    projectMemory.write(root, {
      key: 'decision.canonical-store',
      value: 'Forge memory is canonical; agent-native stores are caches or adapters.',
      sourceAgent: 'Codex',
      timestamp: '2026-04-26T00:00:00.000Z',
      tags: ['decision'],
      scope: 'repo',
      confidence: 1,
      supersedes: ['decision.agent-private-memory'],
      beadsRefs: ['forge-xdh7'],
    });

    expect(projectMemory.search(root, 'repo')[0].key).toBe('decision.canonical-store');
    expect(projectMemory.search(root, 'forge-xdh7')[0].key).toBe('decision.canonical-store');
    expect(projectMemory.search(root, 'agent-private')[0].key).toBe('decision.canonical-store');
  });

  test('resolves relative filePath overrides from the project root', () => {
    const root = tempRoot();
    const originalCwd = process.cwd();
    const overridePath = path.join('.forge', 'memory', `${path.basename(root)}-custom.jsonl`);

    try {
      process.chdir(os.tmpdir());
      projectMemory.write(root, {
        key: 'decision.relative-override',
        value: 'Relative override paths stay project-scoped.',
        sourceAgent: 'Codex',
        timestamp: '2026-04-26T00:00:00.000Z',
        tags: ['paths'],
      }, {
        filePath: overridePath,
      });
    } finally {
      process.chdir(originalCwd);
    }

    expect(fs.existsSync(path.join(root, overridePath))).toBe(true);
    expect(fs.existsSync(path.join(os.tmpdir(), overridePath))).toBe(false);
    expect(projectMemory.read(root, 'decision.relative-override', {
      filePath: overridePath,
    })).toMatchObject({
      key: 'decision.relative-override',
      sourceAgent: 'Codex',
    });
  });

  test('validates required schema fields before writing', () => {
    const root = tempRoot();

    expect(() => projectMemory.write(root, {
      key: '',
      value: 'missing key',
      sourceAgent: 'Codex',
      tags: [],
    })).toThrow('key');

    expect(() => projectMemory.write(root, {
      key: 'policy.invalid-tags',
      value: 'tags must be an array',
      sourceAgent: 'Codex',
      tags: 'policy',
    })).toThrow('tags');

    expect(() => projectMemory.write(root, {
      key: 'policy.invalid-agent',
      value: 'source agent is required',
      sourceAgent: '',
      tags: [],
    })).toThrow('sourceAgent');

    expect(() => projectMemory.write(root, {
      key: 'policy.invalid-confidence',
      value: 'confidence is bounded',
      sourceAgent: 'Codex',
      confidence: 2,
      tags: [],
    })).toThrow('confidence');
  });
});
