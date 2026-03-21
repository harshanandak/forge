import { describe, test, expect } from 'bun:test';

import {
  buildCreateArgs,
  buildCloseArgs,
  buildShowArgs,
  buildSearchArgs,
  parseCreateOutput,
  parseShowOutput,
} from '../../../scripts/github-beads-sync/run-bd.mjs';

// --- buildCreateArgs ---

describe('buildCreateArgs', () => {
  test('builds full args with all options', () => {
    const result = buildCreateArgs({
      title: 'Fix bug',
      type: 'bug',
      priority: 1,
      assignee: 'bob',
      description: 'https://example.com',
      externalRef: 'gh-42',
    });
    expect(result).toEqual([
      'create',
      '--title', 'Fix bug',
      '--type', 'bug',
      '--priority', '1',
      '--assignee', 'bob',
      '--description', 'https://example.com',
      '--external-ref', 'gh-42',
    ]);
  });

  test('omits flags for undefined values', () => {
    const result = buildCreateArgs({ title: 'Minimal issue' });
    expect(result).toEqual(['create', '--title', 'Minimal issue']);
  });

  test('omits flags for null values', () => {
    const result = buildCreateArgs({
      title: 'Null test',
      type: null,
      priority: null,
      assignee: null,
    });
    expect(result).toEqual(['create', '--title', 'Null test']);
  });

  test('converts priority number to string', () => {
    const result = buildCreateArgs({ title: 'Priority test', priority: 3 });
    expect(result).toEqual(['create', '--title', 'Priority test', '--priority', '3']);
  });

  test('keeps priority string as-is', () => {
    const result = buildCreateArgs({ title: 'P test', priority: '2' });
    expect(result).toEqual(['create', '--title', 'P test', '--priority', '2']);
  });
});

// --- buildCloseArgs ---

describe('buildCloseArgs', () => {
  test('builds close args with reason', () => {
    const result = buildCloseArgs('forge-abc', 'Closed via GitHub');
    expect(result).toEqual(['close', 'forge-abc', '--reason', 'Closed via GitHub']);
  });

  test('builds close args without reason', () => {
    const result = buildCloseArgs('forge-xyz');
    expect(result).toEqual(['close', 'forge-xyz']);
  });
});

// --- buildShowArgs ---

describe('buildShowArgs', () => {
  test('builds show args', () => {
    const result = buildShowArgs('forge-abc');
    expect(result).toEqual(['show', 'forge-abc', '--json']);
  });
});

// --- buildSearchArgs ---

describe('buildSearchArgs', () => {
  test('builds search args', () => {
    const result = buildSearchArgs('memory leak');
    expect(result).toEqual(['search', 'memory leak']);
  });
});

// --- parseCreateOutput ---

describe('parseCreateOutput', () => {
  test('extracts beads ID from standard output', () => {
    const stdout = 'Created issue: forge-abc\n  Title: Fix bug\n  Type: bug';
    expect(parseCreateOutput(stdout)).toBe('forge-abc');
  });

  test('extracts beads ID with numeric suffix', () => {
    const stdout = 'Created issue: forge-1234\nDone.';
    expect(parseCreateOutput(stdout)).toBe('forge-1234');
  });

  test('returns null for unexpected output', () => {
    expect(parseCreateOutput('unexpected output')).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(parseCreateOutput('')).toBeNull();
  });
});

// --- parseShowOutput ---

describe('parseShowOutput', () => {
  test('extracts open status from JSON array', () => {
    const stdout = JSON.stringify([{ id: 'forge-abc', status: 'open', title: 'Fix bug' }]);
    expect(parseShowOutput(stdout)).toBe('open');
  });

  test('extracts closed status from JSON array', () => {
    const stdout = JSON.stringify([{ id: 'forge-abc', status: 'closed', title: 'Fix bug' }]);
    expect(parseShowOutput(stdout)).toBe('closed');
  });

  test('extracts in_progress status from JSON array', () => {
    const stdout = JSON.stringify([{ id: 'forge-abc', status: 'in_progress', title: 'Fix bug' }]);
    expect(parseShowOutput(stdout)).toBe('in_progress');
  });

  test('handles single object (non-array) JSON', () => {
    const stdout = JSON.stringify({ id: 'forge-abc', status: 'open' });
    expect(parseShowOutput(stdout)).toBe('open');
  });

  test('returns null for invalid JSON', () => {
    expect(parseShowOutput('not json')).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(parseShowOutput('')).toBeNull();
  });

  test('returns null for JSON without status field', () => {
    const stdout = JSON.stringify([{ id: 'forge-abc', title: 'No status' }]);
    expect(parseShowOutput(stdout)).toBeNull();
  });
});
