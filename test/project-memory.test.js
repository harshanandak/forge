const { describe, test, expect, afterEach } = require('bun:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectMemory = require('../lib/project-memory');

const tempRoots = [];
const workerModulePath = path.resolve(__dirname, '..', 'lib', 'project-memory');

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

  test('normalizes read keys before lookup', () => {
    const root = tempRoot();

    projectMemory.write(root, {
      key: ' preference.trimmed-read ',
      value: 'read callers may pass padded keys',
      sourceAgent: 'Codex',
      timestamp: '2026-04-26T00:00:00.000Z',
      tags: ['preference'],
    });

    expect(projectMemory.read(root, ' preference.trimmed-read ')).toMatchObject({
      key: 'preference.trimmed-read',
      value: 'read callers may pass padded keys',
    });
  });

  test('deduplicates all existing records for a key during upsert', () => {
    const root = tempRoot();
    const memoryFile = path.join(root, '.forge', 'memory', 'entries.jsonl');
    fs.mkdirSync(path.dirname(memoryFile), { recursive: true });
    fs.writeFileSync(memoryFile, [
      JSON.stringify({
        key: 'decision.duplicate',
        value: 'stale manual merge copy',
        'source-agent': 'Claude',
        timestamp: '2026-04-26T00:00:00.000Z',
        tags: ['stale'],
      }),
      JSON.stringify({
        key: 'decision.keep',
        value: 'unrelated entry',
        'source-agent': 'Cursor',
        timestamp: '2026-04-26T00:01:00.000Z',
        tags: ['keep'],
      }),
      JSON.stringify({
        key: 'decision.duplicate',
        value: 'second stale manual merge copy',
        'source-agent': 'Codex',
        timestamp: '2026-04-26T00:02:00.000Z',
        tags: ['stale'],
      }),
    ].join('\n') + '\n', 'utf8');

    projectMemory.write(root, {
      key: 'decision.duplicate',
      value: 'current value',
      sourceAgent: 'OpenCode',
      timestamp: '2026-04-26T00:03:00.000Z',
      tags: ['current'],
    });

    expect(projectMemory.list(root).map((entry) => entry.key)).toEqual([
      'decision.duplicate',
      'decision.keep',
    ]);
    expect(projectMemory.search(root, 'stale')).toEqual([]);
    expect(projectMemory.read(root, 'decision.duplicate')).toMatchObject({
      value: 'current value',
      sourceAgent: 'OpenCode',
      tags: ['current'],
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

  test('rejects filePath overrides outside the project root', () => {
    const root = tempRoot();

    expect(() => projectMemory.write(root, {
      key: 'policy.escape',
      value: 'must stay in repo',
      sourceAgent: 'Codex',
      tags: [],
    }, {
      filePath: path.join('..', 'outside.jsonl'),
    })).toThrow('projectRoot');

    expect(() => projectMemory.write(root, {
      key: 'policy.absolute-escape',
      value: 'must stay in repo',
      sourceAgent: 'Codex',
      tags: [],
    }, {
      filePath: path.join(os.tmpdir(), `outside-${path.basename(root)}.jsonl`),
    })).toThrow('projectRoot');
  });

  test('rejects memory paths that traverse symlinks outside the project root', () => {
    if (process.platform === 'win32') {
      return;
    }

    const root = tempRoot();
    const outside = tempRoot();
    fs.symlinkSync(outside, path.join(root, '.forge'), 'dir');

    expect(() => projectMemory.write(root, {
      key: 'policy.symlink-escape',
      value: 'must stay in repo',
      sourceAgent: 'Codex',
      tags: [],
    })).toThrow('projectRoot');
  });

  test('rejects symlinked memory files outside the project root', () => {
    if (process.platform === 'win32') {
      return;
    }

    const root = tempRoot();
    const outside = tempRoot();
    const memoryDir = path.join(root, '.forge', 'memory');
    const outsideFile = path.join(outside, 'entries.jsonl');
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(outsideFile, JSON.stringify({
      key: 'policy.external',
      value: 'external data',
      'source-agent': 'Codex',
      timestamp: '2026-04-26T00:00:00.000Z',
      tags: [],
    }) + '\n', 'utf8');
    fs.symlinkSync(outsideFile, path.join(memoryDir, 'entries.jsonl'), 'file');

    expect(() => projectMemory.list(root)).toThrow('projectRoot');
  });

  test('recovers stale lockfiles owned by dead processes', () => {
    const root = tempRoot();
    const memoryFile = path.join(root, '.forge', 'memory', 'entries.jsonl');
    fs.mkdirSync(path.dirname(memoryFile), { recursive: true });
    fs.writeFileSync(`${memoryFile}.lock`, JSON.stringify({
      pid: 99999999,
      createdAt: '2026-04-26T00:00:00.000Z',
    }), 'utf8');

    projectMemory.write(root, {
      key: 'policy.stale-lock',
      value: 'recovered',
      sourceAgent: 'Codex',
      tags: [],
    }, {
      lockTimeoutMs: 250,
      lockRetryMs: 5,
    });

    expect(projectMemory.read(root, 'policy.stale-lock')).toMatchObject({
      value: 'recovered',
    });
    expect(fs.existsSync(`${memoryFile}.lock`)).toBe(false);
  });

  test('removes lockfiles when lock metadata initialization fails', () => {
    const root = tempRoot();
    const memoryFile = path.join(root, '.forge', 'memory', 'entries.jsonl');
    const originalWriteFileSync = fs.writeFileSync;
    let injected = false;

    fs.writeFileSync = function writeFileSyncWithInjectedFailure(target, ...args) {
      if (!injected && Number.isInteger(target)) {
        injected = true;
        throw new Error('injected lock metadata failure');
      }
      return originalWriteFileSync.call(this, target, ...args);
    };

    try {
      expect(() => projectMemory.write(root, {
        key: 'policy.lock-init-failure',
        value: 'not written',
        sourceAgent: 'Codex',
        tags: [],
      }, {
        lockTimeoutMs: 50,
        lockRetryMs: 5,
      })).toThrow('injected lock metadata failure');
    } finally {
      fs.writeFileSync = originalWriteFileSync;
    }

    expect(injected).toBe(true);
    expect(fs.existsSync(`${memoryFile}.lock`)).toBe(false);
  });

  test('recovers metadata-less lock directories within the lock timeout', () => {
    const root = tempRoot();
    const memoryFile = path.join(root, '.forge', 'memory', 'entries.jsonl');
    fs.mkdirSync(`${memoryFile}.lock`, { recursive: true });

    projectMemory.write(root, {
      key: 'policy.metadata-less-lock-dir',
      value: 'recovered',
      sourceAgent: 'Codex',
      tags: [],
    }, {
      lockTimeoutMs: 250,
      lockRetryMs: 5,
    });

    expect(projectMemory.read(root, 'policy.metadata-less-lock-dir')).toMatchObject({
      value: 'recovered',
    });
    expect(fs.existsSync(`${memoryFile}.lock`)).toBe(false);
  });

  test('recovers malformed lockfiles within the lock timeout', () => {
    const root = tempRoot();
    const memoryFile = path.join(root, '.forge', 'memory', 'entries.jsonl');
    fs.mkdirSync(path.dirname(memoryFile), { recursive: true });
    fs.writeFileSync(`${memoryFile}.lock`, '', 'utf8');
    const staleTime = new Date(Date.now() - 1_000);
    fs.utimesSync(`${memoryFile}.lock`, staleTime, staleTime);

    projectMemory.write(root, {
      key: 'policy.malformed-lock-file',
      value: 'recovered',
      sourceAgent: 'Codex',
      tags: [],
    }, {
      lockTimeoutMs: 250,
      lockRetryMs: 5,
    });

    expect(projectMemory.read(root, 'policy.malformed-lock-file')).toMatchObject({
      value: 'recovered',
    });
    expect(fs.existsSync(`${memoryFile}.lock`)).toBe(false);
  });

  test('does not reclaim a freshly initializing malformed lockfile before waiter timeout', () => {
    const root = tempRoot();
    const memoryFile = path.join(root, '.forge', 'memory', 'entries.jsonl');
    fs.mkdirSync(path.dirname(memoryFile), { recursive: true });
    fs.writeFileSync(`${memoryFile}.lock`, '', 'utf8');

    expect(() => projectMemory.write(root, {
      key: 'policy.fresh-invalid-lock',
      value: 'blocked',
      sourceAgent: 'Codex',
      tags: [],
    }, {
      lockTimeoutMs: 250,
      lockRetryMs: 100,
    })).toThrow();

    expect(fs.existsSync(`${memoryFile}.lock`)).toBe(true);
    expect(projectMemory.search(root, 'fresh-invalid-lock')).toEqual([]);
  });

  test('recovers fresh lockfiles owned by dead processes', () => {
    const root = tempRoot();
    const memoryFile = path.join(root, '.forge', 'memory', 'entries.jsonl');
    fs.mkdirSync(path.dirname(memoryFile), { recursive: true });
    fs.writeFileSync(`${memoryFile}.lock`, JSON.stringify({
      pid: 99999999,
      createdAt: new Date().toISOString(),
    }), 'utf8');

    projectMemory.write(root, {
      key: 'policy.fresh-dead-lock',
      value: 'recovered',
      sourceAgent: 'Codex',
      tags: [],
    }, {
      lockTimeoutMs: 250,
      lockRetryMs: 5,
    });

    expect(projectMemory.read(root, 'policy.fresh-dead-lock')).toMatchObject({
      value: 'recovered',
    });
    expect(fs.existsSync(`${memoryFile}.lock`)).toBe(false);
  });

  test('recovers fresh dead locks immediately when lock timeout is shorter than grace', () => {
    const root = tempRoot();
    const memoryFile = path.join(root, '.forge', 'memory', 'entries.jsonl');
    fs.mkdirSync(path.dirname(memoryFile), { recursive: true });
    fs.writeFileSync(`${memoryFile}.lock`, JSON.stringify({
      pid: 99999999,
      createdAt: new Date().toISOString(),
    }), 'utf8');

    projectMemory.write(root, {
      key: 'policy.short-timeout-dead-lock',
      value: 'recovered',
      sourceAgent: 'Codex',
      tags: [],
    }, {
      lockTimeoutMs: 50,
      lockRetryMs: 5,
    });

    expect(projectMemory.read(root, 'policy.short-timeout-dead-lock')).toMatchObject({
      value: 'recovered',
    });
    expect(fs.existsSync(`${memoryFile}.lock`)).toBe(false);
  });

  test('recovers dead locks when lock timeout equals grace boundary', () => {
    const root = tempRoot();
    const memoryFile = path.join(root, '.forge', 'memory', 'entries.jsonl');
    fs.mkdirSync(path.dirname(memoryFile), { recursive: true });
    fs.writeFileSync(`${memoryFile}.lock`, JSON.stringify({
      pid: 99999999,
      createdAt: new Date().toISOString(),
    }), 'utf8');

    projectMemory.write(root, {
      key: 'policy.equal-timeout-dead-lock',
      value: 'recovered',
      sourceAgent: 'Codex',
      tags: [],
    }, {
      lockTimeoutMs: 100,
      lockRetryMs: 5,
    });

    expect(projectMemory.read(root, 'policy.equal-timeout-dead-lock')).toMatchObject({
      value: 'recovered',
    });
    expect(fs.existsSync(`${memoryFile}.lock`)).toBe(false);
  });

  test('recovers fresh tokenized dead locks within the lock timeout', () => {
    const root = tempRoot();
    const memoryFile = path.join(root, '.forge', 'memory', 'entries.jsonl');
    fs.mkdirSync(path.dirname(memoryFile), { recursive: true });
    fs.writeFileSync(`${memoryFile}.lock`, JSON.stringify({
      pid: 99999999,
      createdAt: new Date().toISOString(),
      token: 'dead-owner-token',
    }), 'utf8');

    projectMemory.write(root, {
      key: 'policy.tokenized-dead-lock',
      value: 'recovered',
      sourceAgent: 'Codex',
      tags: [],
    }, {
      lockTimeoutMs: 250,
      lockRetryMs: 5,
    });

    expect(projectMemory.read(root, 'policy.tokenized-dead-lock')).toMatchObject({
      value: 'recovered',
    });
    expect(fs.existsSync(`${memoryFile}.lock`)).toBe(false);
  });

  test('recovers future-dated lockfiles owned by dead processes', () => {
    const root = tempRoot();
    const memoryFile = path.join(root, '.forge', 'memory', 'entries.jsonl');
    const future = new Date(Date.now() + 60_000).toISOString();
    fs.mkdirSync(path.dirname(memoryFile), { recursive: true });
    fs.writeFileSync(`${memoryFile}.lock`, JSON.stringify({
      pid: 99999999,
      createdAt: future,
    }), 'utf8');

    projectMemory.write(root, {
      key: 'policy.future-dead-lock',
      value: 'recovered',
      sourceAgent: 'Codex',
      tags: [],
    }, {
      lockTimeoutMs: 250,
      lockRetryMs: 5,
    });

    expect(projectMemory.read(root, 'policy.future-dead-lock')).toMatchObject({
      value: 'recovered',
    });
    expect(fs.existsSync(`${memoryFile}.lock`)).toBe(false);
  });

  test('serializes concurrent writers without losing entries', async () => {
    const root = tempRoot();
    const worker = `
const projectMemory = require(${JSON.stringify(workerModulePath)});
const root = process.argv[1];
const index = Number(process.argv[2]);
projectMemory.write(root, {
  key: \`decision.concurrent.\${index}\`,
  value: \`writer-\${index}\`,
  sourceAgent: 'Codex',
  timestamp: '2026-04-26T00:00:00.000Z',
  tags: ['concurrent'],
});
`;

    await Promise.all(Array.from({ length: 8 }, (_unused, index) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', worker, root, String(index)], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', (err) => {
        reject(new Error(`worker ${index} failed to spawn: ${err.message}`));
      });
      child.on('close', (status) => {
        if (status === 0) {
          resolve();
          return;
        }
        reject(new Error(`worker ${index} exited with ${status}: ${stderr || stdout}`));
      });
    })));

    expect(projectMemory.search(root, 'concurrent')).toHaveLength(8);
  });

  test('rejects schema-invalid stored JSONL entries when reading', () => {
    const root = tempRoot();
    const memoryFile = path.join(root, '.forge', 'memory', 'entries.jsonl');
    fs.mkdirSync(path.dirname(memoryFile), { recursive: true });
    fs.writeFileSync(memoryFile, [
      JSON.stringify({
        key: 'policy.valid',
        value: 'valid',
        'source-agent': 'Codex',
        timestamp: '2026-04-26T00:00:00.000Z',
        tags: [],
      }),
      JSON.stringify({
        key: 'policy.invalid',
        value: 'missing disk source-agent',
        sourceAgent: 'Codex',
        tags: [],
      }),
    ].join('\n') + '\n', 'utf8');

    expect(() => projectMemory.list(root)).toThrow('invalid project memory entry at line 2');
  });

  test('ignores a torn trailing JSONL append when reading', () => {
    const root = tempRoot();
    const memoryFile = path.join(root, '.forge', 'memory', 'entries.jsonl');
    fs.mkdirSync(path.dirname(memoryFile), { recursive: true });
    fs.writeFileSync(memoryFile, [
      JSON.stringify({
        key: 'policy.valid-before-torn-tail',
        value: 'valid',
        'source-agent': 'Codex',
        timestamp: '2026-04-26T00:00:00.000Z',
        tags: ['valid'],
      }),
      '{"key":"policy.torn-tail"',
    ].join('\n'), 'utf8');

    expect(projectMemory.list(root)).toEqual([{
      key: 'policy.valid-before-torn-tail',
      value: 'valid',
      sourceAgent: 'Codex',
      timestamp: '2026-04-26T00:00:00.000Z',
      tags: ['valid'],
    }]);
  });

  test('ignores a valid but unterminated trailing JSONL record when reading', () => {
    const root = tempRoot();
    const memoryFile = path.join(root, '.forge', 'memory', 'entries.jsonl');
    fs.mkdirSync(path.dirname(memoryFile), { recursive: true });
    fs.writeFileSync(memoryFile, JSON.stringify({
      key: 'policy.unterminated',
      value: 'valid json without commit newline',
      'source-agent': 'Codex',
      timestamp: '2026-04-26T00:00:00.000Z',
      tags: ['unterminated'],
    }), 'utf8');

    expect(projectMemory.list(root)).toEqual([]);
  });

  test('repairs a torn trailing JSONL append before the next write', () => {
    const root = tempRoot();
    const memoryFile = path.join(root, '.forge', 'memory', 'entries.jsonl');
    fs.mkdirSync(path.dirname(memoryFile), { recursive: true });
    const validEntry = {
      key: 'policy.valid-before-repair',
      value: 'valid',
      'source-agent': 'Codex',
      timestamp: '2026-04-26T00:00:00.000Z',
      tags: ['valid'],
    };
    fs.writeFileSync(memoryFile, [
      JSON.stringify(validEntry),
      '{"key":"policy.torn-tail"',
    ].join('\n'), 'utf8');

    projectMemory.write(root, {
      key: 'policy.after-repair',
      value: 'written',
      sourceAgent: 'Codex',
      timestamp: '2026-04-26T00:01:00.000Z',
      tags: ['repair'],
    });

    const rawLines = fs.readFileSync(memoryFile, 'utf8').trim().split(/\r?\n/);
    expect(rawLines).toHaveLength(2);
    expect(rawLines.map((line) => JSON.parse(line).key)).toEqual([
      'policy.valid-before-repair',
      'policy.after-repair',
    ]);
  });

  test('rolls back an appended record when fsync fails', () => {
    const root = tempRoot();
    const memoryFile = path.join(root, '.forge', 'memory', 'entries.jsonl');
    fs.mkdirSync(path.dirname(memoryFile), { recursive: true });
    fs.writeFileSync(memoryFile, JSON.stringify({
      key: 'policy.before-fsync-failure',
      value: 'valid',
      'source-agent': 'Codex',
      timestamp: '2026-04-26T00:00:00.000Z',
      tags: ['valid'],
    }) + '\n', 'utf8');

    const originalOpenSync = fs.openSync;
    const originalFsyncSync = fs.fsyncSync;
    const entryFileDescriptors = new Set();
    let injected = false;

    fs.openSync = function openSyncWithTrackedEntryFile(target, ...args) {
      const fd = originalOpenSync.call(this, target, ...args);
      if (path.resolve(String(target)) === memoryFile) {
        entryFileDescriptors.add(fd);
      }
      return fd;
    };
    fs.fsyncSync = function fsyncSyncWithInjectedFailure(fd) {
      if (!injected && entryFileDescriptors.has(fd)) {
        injected = true;
        throw new Error('injected entry fsync failure');
      }
      return originalFsyncSync.call(this, fd);
    };

    try {
      expect(() => projectMemory.write(root, {
        key: 'policy.fsync-failure',
        value: 'must not persist',
        sourceAgent: 'Codex',
        timestamp: '2026-04-26T00:01:00.000Z',
        tags: ['failure'],
      })).toThrow('injected entry fsync failure');
    } finally {
      fs.fsyncSync = originalFsyncSync;
      fs.openSync = originalOpenSync;
    }

    expect(injected).toBe(true);
    expect(projectMemory.list(root).map((entry) => entry.key)).toEqual([
      'policy.before-fsync-failure',
    ]);
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
