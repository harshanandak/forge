'use strict';

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const { maybeWarnUnmigratedBeads, kernelReadLooksEmpty } = require('../lib/beads-nudge');

// Unit tests for the neutral nudge helper (kernel issue a5399f3d). The message
// text + `.beads`/legacy tokens live here, OUT of the D20 hot-path _issue.js, so
// the release-readiness bd-call-site + kernel-backed scanners stay clean. The
// integration wiring (runIssueSubcommand -> maybeWarnUnmigratedBeads) is covered
// separately in test/commands/issue-path-beads-nudge.test.js.

function makeRoot({ withBeads } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'forge-beads-nudge-unit-'));
  if (withBeads) {
    mkdirSync(path.join(root, '.beads'), { recursive: true });
    writeFileSync(path.join(root, '.beads', 'issues.jsonl'), '{"id":"bd-1"}\n');
  }
  return root;
}

const emptyKernel = { ok: true, data: { issues: [], count: 0 } };

let errors;
const originalError = console.error;
beforeEach(() => {
  errors = [];
  console.error = (...args) => { errors.push(args.join(' ')); };
});
afterEach(() => {
  console.error = originalError;
});

describe('kernelReadLooksEmpty', () => {
  test('true for {issues:[],count:0}, false for a populated read', () => {
    expect(kernelReadLooksEmpty(emptyKernel)).toBe(true);
    expect(kernelReadLooksEmpty({ ok: true, data: { issues: [{ id: 'k' }], count: 1 } })).toBe(false);
  });

  test('conservative: a non-ok or unrecognized shape is NOT empty', () => {
    expect(kernelReadLooksEmpty({ ok: false })).toBe(false);
    expect(kernelReadLooksEmpty({ ok: true, data: { summary: 'x' } })).toBe(false);
  });
});

describe('maybeWarnUnmigratedBeads', () => {
  test('kernel default + empty read + legacy store -> guided hint on stderr', () => {
    const root = makeRoot({ withBeads: true });
    maybeWarnUnmigratedBeads('list', emptyKernel, root, { env: {} });
    expect(errors.join('\n')).toContain('forge migrate --from beads');
  });

  test('no legacy store -> no hint', () => {
    const root = makeRoot({ withBeads: false });
    maybeWarnUnmigratedBeads('list', emptyKernel, root, { env: {} });
    expect(errors.join('\n')).not.toContain('forge migrate');
  });

  test('explicit env opt-in to the legacy backend suppresses the hint', () => {
    const root = makeRoot({ withBeads: true });
    maybeWarnUnmigratedBeads('list', emptyKernel, root, { env: { FORGE_ISSUE_BACKEND: 'beads' } });
    expect(errors.join('\n')).not.toContain('forge migrate');
  });

  test('fires at most once per project root', () => {
    const root = makeRoot({ withBeads: true });
    maybeWarnUnmigratedBeads('list', emptyKernel, root, { env: {} });
    maybeWarnUnmigratedBeads('ready', emptyKernel, root, { env: {} });
    const hits = errors.filter(line => line.includes('forge migrate --from beads')).length;
    expect(hits).toBe(1);
  });
});
