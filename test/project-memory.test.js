const { describe, test, expect } = require('bun:test');

const projectMemory = require('../lib/project-memory');

function runner(responses = {}) {
  const calls = [];
  return {
    calls,
    run(command, args) {
      calls.push({ command, args });
      const key = `${command} ${args.join(' ')}`;
      if (responses[key] instanceof Error) {
        throw responses[key];
      }
      return responses[key] ?? '{}';
    },
  };
}

describe('project memory Beads adapter', () => {
  test('writes entries with bd remember and a stable key', () => {
    const beads = runner({
      'bd remember {"value":"Use Beads for durable memory.","sourceAgent":"Codex","tags":["memory"],"timestamp":"2026-05-16T10:00:00.000Z","scope":"project"} --key policy.memory': '{"key":"policy.memory","value":"stored"}',
    });

    const entry = projectMemory.write(process.cwd(), {
      key: 'policy.memory',
      value: 'Use Beads for durable memory.',
      sourceAgent: 'Codex',
      tags: ['memory'],
      timestamp: '2026-05-16T10:00:00.000Z',
      scope: 'project',
    }, { runner: beads.run });

    expect(beads.calls).toEqual([{
      command: 'bd',
      args: [
        'remember',
        JSON.stringify({
          value: 'Use Beads for durable memory.',
          sourceAgent: 'Codex',
          tags: ['memory'],
          timestamp: '2026-05-16T10:00:00.000Z',
          scope: 'project',
        }),
        '--key',
        'policy.memory',
      ],
    }]);
    expect(entry.key).toBe('policy.memory');
    expect(entry.value).toBe('Use Beads for durable memory.');
  });

  test('reads entries with bd recall and returns null when missing', () => {
    const beads = runner({
      'bd recall policy.memory --json': JSON.stringify({
        key: 'policy.memory',
        content: '{"value":"stored","sourceAgent":"Codex","tags":["memory"]}',
      }),
      'bd recall missing.key --json': '',
    });

    expect(projectMemory.read(process.cwd(), ' policy.memory ', { runner: beads.run })).toMatchObject({
      key: 'policy.memory',
      value: 'stored',
      sourceAgent: 'Codex',
      tags: ['memory'],
    });
    expect(projectMemory.read(process.cwd(), 'missing.key', { runner: beads.run })).toBe(null);
  });

  test('searches and lists entries through bd memories', () => {
    const memoryRows = JSON.stringify({
      'decision.one': '{"value":"one","sourceAgent":"Codex","tags":["decision"]}',
      'decision.two': '{"value":"two","sourceAgent":"Claude","tags":["decision"]}',
      schema_version: 1,
    });
    const beads = runner({
      'bd memories decision --json': memoryRows,
      'bd memories --json': memoryRows,
    });

    expect(projectMemory.search(process.cwd(), 'decision', { runner: beads.run }).map(entry => entry.key)).toEqual([
      'decision.one',
      'decision.two',
    ]);
    expect(projectMemory.list(process.cwd(), { runner: beads.run })).toHaveLength(2);
  });

  test('falls back to plain text recall output and surfaces Beads command failures', () => {
    const failed = runner({
      'bd recall policy.memory --json': new Error('bd failed'),
    });
    const plainText = runner({
      'bd recall policy.memory --json': 'Use Beads for durable memory.',
    });

    expect(() => projectMemory.read(process.cwd(), 'policy.memory', { runner: failed.run })).toThrow('bd failed');
    expect(projectMemory.read(process.cwd(), 'policy.memory', { runner: plainText.run })).toMatchObject({
      key: 'policy.memory',
      value: 'Use Beads for durable memory.',
      sourceAgent: 'bd',
    });
  });

  test('keeps brace-prefixed plain text memory content readable', () => {
    const beads = runner({
      'bd recall draft.memory --json': JSON.stringify({
        key: 'draft.memory',
        content: '{draft notes',
      }),
    });

    expect(projectMemory.read(process.cwd(), 'draft.memory', { runner: beads.run })).toMatchObject({
      key: 'draft.memory',
      value: '{draft notes',
      sourceAgent: 'bd',
    });
  });

  test('adds a timestamp to compatibility memory writes when omitted', () => {
    const beads = runner();

    projectMemory.write(process.cwd(), {
      key: 'decision.timestamped',
      value: 'timestamp should be generated',
      sourceAgent: 'Codex',
    }, { runner: beads.run });

    const payload = JSON.parse(beads.calls[0].args[1]);
    expect(Number.isNaN(Date.parse(payload.timestamp))).toBe(false);
  });

  test('validates beads-refs alias before writing', () => {
    expect(() => projectMemory.write(process.cwd(), {
      key: 'decision.bad-ref',
      value: 'invalid alias refs must fail',
      sourceAgent: 'Codex',
      'beads-refs': ['forge-besw.19', 42],
    }, { runner: runner().run })).toThrow('beads-refs');
  });

  test('validates compatibility metadata before writing', () => {
    const beads = runner();

    expect(() => projectMemory.write(process.cwd(), {
      key: 'decision.bad-confidence',
      value: 'bad confidence must fail',
      sourceAgent: 'Codex',
      confidence: Number.POSITIVE_INFINITY,
    }, { runner: beads.run })).toThrow('confidence');

    expect(() => projectMemory.write(process.cwd(), {
      key: 'decision.bad-scope',
      value: 'bad scope must fail',
      sourceAgent: 'Codex',
      scope: '',
    }, { runner: beads.run })).toThrow('scope');

    expect(() => projectMemory.write(process.cwd(), {
      key: 'decision.bad-timestamp',
      value: 'bad timestamp must fail',
      sourceAgent: 'Codex',
      timestamp: 'not-a-date',
    }, { runner: beads.run })).toThrow('timestamp');
  });
});
