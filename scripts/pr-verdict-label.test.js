'use strict';

const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildLabelReport, main } = require('./pr-verdict-label');
const { VERDICT_LABELS } = require('../lib/pr-verdict');

function bundle(overrides = {}) {
  return {
    pr: '42',
    unresolvedComments: [],
    unresolvedCommentsAvailable: true,
    ciAvailable: true,
    mergeState: { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', state: 'OPEN' },
    ci: { checks: [], failing: [], pending: [] },
    branch: { ahead: 0, behind: 0 },
    ...overrides,
  };
}

describe('buildLabelReport', () => {
  test('clean bundle → mergeable label + full reconcile set', () => {
    const r = buildLabelReport(bundle());
    expect(r.verdict).toBe('mergeable');
    expect(r.label).toBe('pr-verdict:mergeable');
    expect(r.allLabels).toEqual(VERDICT_LABELS);
  });

  test('failing check → check-failed label', () => {
    const r = buildLabelReport(bundle({ ci: { checks: [], failing: [{ name: 'Tests' }], pending: [] } }));
    expect(r.label).toBe('pr-verdict:check-failed');
  });
});

describe('main (CLI)', () => {
  test('emits verdict/label/all_labels to GITHUB_OUTPUT', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-verdict-label-'));
    const bundlePath = path.join(dir, 'bundle.json');
    const outPath = path.join(dir, 'gh-output');
    fs.writeFileSync(bundlePath, JSON.stringify(bundle({ unresolvedComments: [{ threadId: 'T1' }] })));
    fs.writeFileSync(outPath, '');

    const prev = process.env.GITHUB_OUTPUT;
    process.env.GITHUB_OUTPUT = outPath;
    try {
      expect(main(['node', 'pr-verdict-label.js', bundlePath])).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.GITHUB_OUTPUT;
      else process.env.GITHUB_OUTPUT = prev;
    }

    const emitted = fs.readFileSync(outPath, 'utf8');
    expect(emitted).toContain('verdict=threads-open');
    expect(emitted).toContain('label=pr-verdict:threads-open');
    expect(emitted).toContain('all_labels=');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('returns non-zero on a missing bundle path (no throw)', () => {
    expect(main(['node', 'pr-verdict-label.js'])).toBe(1);
  });
});
