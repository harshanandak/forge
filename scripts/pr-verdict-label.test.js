'use strict';

const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { main } = require('./pr-verdict-label');
const { VERDICT_LABELS, MERGE_VERDICTS } = require('../lib/pr-pull');

function runMain(argv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-verdict-label-'));
  const outPath = path.join(dir, 'gh-output');
  fs.writeFileSync(outPath, '');
  const prev = process.env.GITHUB_OUTPUT;
  process.env.GITHUB_OUTPUT = outPath;
  let code;
  try {
    code = main(argv);
  } finally {
    if (prev === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = prev;
  }
  const emitted = fs.readFileSync(outPath, 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  return { code, emitted };
}

describe('pr-verdict-label main', () => {
  test('maps a canonical verdict to the lowercased pr-verdict:* label + full set', () => {
    const { code, emitted } = runMain(['node', 'pr-verdict-label.js', 'BLOCKED-CHECKS']);
    expect(code).toBe(0);
    expect(emitted).toContain('label=pr-verdict:blocked-checks');
    expect(emitted).toContain(`all_labels=${VERDICT_LABELS.join(',')}`);
  });

  test('every canonical verdict yields a label in the reconcile set', () => {
    for (const v of MERGE_VERDICTS) {
      const { emitted } = runMain(['node', 'pr-verdict-label.js', v]);
      const label = emitted.split('\n').find((l) => l.startsWith('label=')).slice('label='.length);
      expect(VERDICT_LABELS).toContain(label);
    }
  });

  test('a missing verdict arg fails closed to pr-verdict:unknown', () => {
    const { code, emitted } = runMain(['node', 'pr-verdict-label.js']);
    expect(code).toBe(0);
    expect(emitted).toContain('label=pr-verdict:unknown');
  });
});
