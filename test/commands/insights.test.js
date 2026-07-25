const { afterEach, describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const insightsCommand = require('../../lib/commands/insights');

const tempRoots = [];

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-insights-command-'));
  tempRoots.push(root);
  return root;
}

// Kernel reads are injected through the handler's opts seam, so these tests exercise the
// command surface without opening a kernel database. Imported beads interactions live in
// kernel_events as `beads.interaction.<kind>` with a payload_json of `{ kind, ...extra }`.
function kernelSeams() {
  return {
    listRecentEvents: async () => [1, 2, 3].map(index => ({
      id: `int-${index}`,
      entity_id: `forge-${index}`,
      event_type: 'beads.interaction.field_change',
      created_at: `2026-05-${String(index).padStart(2, '0')}T12:00:00Z`,
      payload_json: JSON.stringify({
        kind: 'field_change',
        field: 'status',
        new_value: 'closed',
        reason: 'Merged and verified on master after review',
      }),
    })),
    runIssueOperation: async (operation) => (operation === 'list'
      ? {
        ok: true,
        data: {
          issues: [
            { id: 'forge-a', title: 'Review evidence persistence', status: 'closed' },
            { id: 'forge-b', title: 'Review evidence recap', status: 'open' },
          ],
        },
      }
      : { ok: false }),
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('forge insights command', () => {
  test('prints ranked candidates and accepts the review-feedback alias', async () => {
    const root = makeRepo();

    const result = await insightsCommand.handler(['--review-feedback', '--min-count', '2'], {}, root, kernelSeams());

    expect(result.success).toBe(true);
    expect(result.output).toContain('Forge insights');
    expect(result.output).toContain('Ranked candidates');
    expect(result.output).toContain('kernel events and issue evidence');
  });

  test('records accept and reject decisions', async () => {
    const root = makeRepo();
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

    const result = await insightsCommand.handler(['--json', '--min-count=2'], {}, root, kernelSeams());
    const parsed = JSON.parse(result.output);

    expect(result.success).toBe(true);
    expect(parsed.candidates.length).toBeGreaterThan(0);
    expect(parsed.sources).toMatchObject({ interactions: 3, issues: 2 });
  });
});
