const { afterEach, describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const insightsCommand = require('../../lib/commands/insights');

const tempRoots = [];

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-insights-command-'));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, '.beads'), { recursive: true });
  return root;
}

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

function seedRepo(root) {
  writeJsonl(path.join(root, '.beads', 'interactions.jsonl'), [1, 2, 3].map(index => ({
    id: `int-${index}`,
    kind: 'field_change',
    created_at: `2026-05-${String(index).padStart(2, '0')}T12:00:00Z`,
    issue_id: `forge-${index}`,
    extra: {
      field: 'status',
      new_value: 'closed',
      reason: 'Merged and verified on master after review',
    },
  })));
  writeJsonl(path.join(root, '.beads', 'issues.jsonl'), [
    { _type: 'issue', id: 'forge-a', title: 'Review evidence persistence', status: 'closed' },
    { _type: 'issue', id: 'forge-b', title: 'Review evidence recap', status: 'open' },
  ]);
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('forge insights command', () => {
  test('prints ranked candidates and accepts the review-feedback alias', async () => {
    const root = makeRepo();
    seedRepo(root);

    const result = await insightsCommand.handler(['--review-feedback', '--min-count', '2'], {}, root);

    expect(result.success).toBe(true);
    expect(result.output).toContain('Forge insights');
    expect(result.output).toContain('Ranked candidates');
    expect(result.output).toContain('Beads interactions and issue evidence');
  });

  test('records accept and reject decisions', async () => {
    const root = makeRepo();
    seedRepo(root);
    const writes = [];
    const memory = {
      write(_projectRoot, entry) {
        writes.push(entry);
        return entry;
      },
    };

    const accepted = await insightsCommand.handler(['accept', 'insight-review', '--note', 'useful'], { memory }, root);
    const rejected = await insightsCommand.handler(['reject', 'insight-noise'], { memory }, root);

    expect(accepted.success).toBe(true);
    expect(rejected.success).toBe(true);
    expect(writes.map(entry => entry.value.data.status)).toEqual(['accepted', 'rejected']);
  });

  test('skips global path flag values when parsing accept and reject subcommands', async () => {
    const root = makeRepo();
    const writes = [];
    const memory = {
      write(_projectRoot, entry) {
        writes.push(entry);
        return entry;
      },
    };

    const result = await insightsCommand.handler(['--path', root, 'accept', 'insight-global-path'], { memory }, root);

    expect(result.success).toBe(true);
    expect(writes[0].key).toBe('skills:insight-global-path');
  });

  test('returns JSON output when requested', async () => {
    const root = makeRepo();
    seedRepo(root);

    const result = await insightsCommand.handler(['--json', '--min-count=2'], {}, root);
    const parsed = JSON.parse(result.output);

    expect(result.success).toBe(true);
    expect(parsed.candidates.length).toBeGreaterThan(0);
  });
});
