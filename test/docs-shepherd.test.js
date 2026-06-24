'use strict';

const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('shepherd documentation', () => {
  test('AGENTS.md documents shepherd as a utility, not a numbered stage', () => {
    const agents = read('AGENTS.md');
    expect(/shepherd/i.test(agents)).toBe(true);
    // Must describe it as a utility / not-a-stage.
    expect(/shepherd[\s\S]{0,200}not\b[\s\S]{0,40}stage/i.test(agents)
      || /utility[\s\S]{0,120}shepherd/i.test(agents)).toBe(true);
  });

  test('AGENTS.md shepherd text makes no auto-merge promise', () => {
    const agents = read('AGENTS.md');
    expect(/gh pr merge/.test(agents)).toBe(false);
    expect(/--auto-merge/.test(agents)).toBe(false);
    expect(/never merges/i.test(agents)).toBe(true);
  });

  test('docs/reference/shepherd.md exists and is token-clean', () => {
    const doc = read('docs/reference/shepherd.md');
    expect(doc.length).toBeGreaterThan(0);
    expect(/\bbd\b/i.test(doc)).toBe(false);
    expect(/\bdolt\b/i.test(doc)).toBe(false);
    expect(/\.beads\b/i.test(doc)).toBe(false);
  });

  test('docs/reference/shepherd.md states the never-merge / never-resolve invariants', () => {
    const doc = read('docs/reference/shepherd.md');
    expect(/never merges/i.test(doc)).toBe(true);
    expect(/never resolves/i.test(doc)).toBe(true);
    expect(/gh pr merge/.test(doc)).toBe(false);
  });
});
