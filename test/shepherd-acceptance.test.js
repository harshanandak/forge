'use strict';

/**
 * PR shepherd acceptance suite (plan §5).
 *
 * Drives lib/pr-shepherd.js + lib/commands/shepherd.js with a scripted fake
 * adapter and asserts the end-to-end invariants in one place. This suite is
 * decoupled from `forge release check` (§5.9): it never asserts the release gate
 * is green (it is RED for unrelated D22 reasons).
 */

const { describe, test, expect } = require('bun:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { runShepherdPass } = require('../lib/pr-shepherd');
const shepherdCmd = require('../lib/commands/shepherd');

const ROOT = path.resolve(__dirname, '..');
const BASE_CTX = { pr: '123', owner: 'o', repo: 'r', base: 'master', baseRef: 'origin/master' };

/** A scripted adapter whose state can change per-pass to model a real PR. */
function scriptedAdapter(steps) {
  let pass = 0;
  const actions = [];
  const cur = () => steps[Math.min(pass, steps.length - 1)];
  return {
    actions,
    nextPass() { pass += 1; },
    adapter: {
      id: 'scripted',
      kind: 'pr-state',
      async readState() {
        const s = cur();
        return {
          headSha: typeof s.headSha === 'function' ? s.headSha() : (s.headSha || 'sha-1'),
          state: s.state || 'OPEN',
          mergeStateStatus: s.mergeStateStatus || 'CLEAN',
          checks: s.checks || [],
          threads: s.threads || [],
        };
      },
      async readRequiredChecks() {
        const s = cur();
        if (s.requiredError) throw s.requiredError;
        return s.required === undefined ? [] : s.required;
      },
      async readDivergence() {
        const s = cur();
        return { behind: s.behind || 0, ahead: s.ahead || 0 };
      },
      async rerunFailedChecks(a) { actions.push({ type: 'rerun', ...a }); },
      async replyToThread(a) { actions.push({ type: 'reply', ...a }); },
      async rebaseOntoBase(a) {
        if (cur().leaseReject) {
          const err = new Error('lease'); err.leaseRejected = true; throw err;
        }
        actions.push({ type: 'rebase', ...a });
      },
    },
  };
}

const noMerge = (actions) => actions.every((a) => a.type !== 'merge');
const noResolve = (actions) => actions.every((a) => a.type !== 'resolve');

describe('shepherd acceptance §5', () => {
  // §5.1 — Happy path to READY, zero manual steps, never merges, never resolves.
  test('§5.1 flaky required + behind → rerun → escalate (human rebase) → MERGE_READY', async () => {
    const s = scriptedAdapter([
      { required: ['unit'], checks: [{ name: 'unit', conclusion: 'FAILURE', databaseId: '1' }], behind: 2,
        threads: [{ id: 't1', commentId: 'c1', resolved: false }] },
      { required: ['unit'], checks: [{ name: 'unit', conclusion: 'SUCCESS' }], behind: 2 },
      { required: ['unit'], checks: [{ name: 'unit', conclusion: 'SUCCESS' }], behind: 0 },
    ]);

    const p1 = await runShepherdPass({ ...BASE_CTX, adapter: s.adapter, rerunBudget: 3, rerunsUsed: 0 });
    expect(p1.state).toBe('PENDING');
    expect(s.actions.filter((a) => a.type === 'rerun')).toHaveLength(1);

    s.nextPass();
    const p2 = await runShepherdPass({ ...BASE_CTX, adapter: s.adapter, autoRebase: false });
    expect(p2.state).toBe('ESCALATE'); // behind=2, human rebases

    s.nextPass();
    const p3 = await runShepherdPass({ ...BASE_CTX, adapter: s.adapter });
    expect(p3.state).toBe('MERGE_READY');

    expect(noMerge(s.actions)).toBe(true);
    expect(noResolve(s.actions)).toBe(true);
  });

  // §5.2 — autoRebase path; lease reject → escalate, no retry.
  test('§5.2 autoRebase rebases; lease reject → ESCALATE with no retry', async () => {
    const ok = scriptedAdapter([
      { required: ['unit'], checks: [{ name: 'unit', conclusion: 'SUCCESS' }], behind: 2 },
    ]);
    const okRes = await runShepherdPass({ ...BASE_CTX, adapter: ok.adapter, autoRebase: true, cleanTree: true });
    expect(okRes.state).toBe('PENDING');
    expect(ok.actions.filter((a) => a.type === 'rebase')).toHaveLength(1);

    const lease = scriptedAdapter([
      { required: ['unit'], checks: [{ name: 'unit', conclusion: 'SUCCESS' }], behind: 2, leaseReject: true },
    ]);
    const leaseRes = await runShepherdPass({ ...BASE_CTX, adapter: lease.adapter, autoRebase: true, cleanTree: true });
    expect(leaseRes.state).toBe('ESCALATE');
    expect(lease.actions.filter((a) => a.type === 'rebase')).toHaveLength(0);
  });

  // §5.3 — caps honored.
  test('§5.3 rerun budget exhausted → ESCALATE, no extra rerun', async () => {
    const s = scriptedAdapter([
      { required: ['unit'], checks: [{ name: 'unit', conclusion: 'FAILURE', databaseId: '1' }], behind: 0 },
    ]);
    const res = await runShepherdPass({ ...BASE_CTX, adapter: s.adapter, rerunBudget: 2, rerunsUsed: 2 });
    expect(res.state).toBe('ESCALATE');
    expect(s.actions.filter((a) => a.type === 'rerun')).toHaveLength(0);
  });

  // §5.4 — never auto-merge in any branch.
  test('§5.4 gh pr merge / --auto never appear in any side-effect log', async () => {
    const specs = [
      { required: ['u'], checks: [{ name: 'u', conclusion: 'SUCCESS' }], behind: 0 },
      { required: ['u'], checks: [{ name: 'u', conclusion: 'FAILURE', databaseId: '1' }], behind: 0 },
      { required: ['u'], checks: [{ name: 'u', conclusion: 'SUCCESS' }], behind: 3 },
      { required: null, checks: [], behind: 0 },
      { mergeStateStatus: 'DIRTY', required: ['u'], checks: [], behind: 0 },
    ];
    for (const spec of specs) {
      const s = scriptedAdapter([spec]);
      const res = await runShepherdPass({ ...BASE_CTX, adapter: s.adapter, rerunBudget: 5, autoRebase: true, cleanTree: true });
      expect(s.actions.some((a) => a.type === 'merge' || /--auto/.test(JSON.stringify(a)))).toBe(false);
      expect(res.state).not.toBe('MERGED');
    }
  });

  // §5.5 — unknown / unreadable required set → wait/escalate, not merge-ready.
  test('§5.5 protection 403 → ESCALATE; UNKNOWN merge state ≠ conflict → not merge-ready', async () => {
    const protErr = new Error('forbidden'); protErr.httpStatus = 403;
    protErr.stderr = 'HTTP 403: Resource not accessible by integration';
    const prot = scriptedAdapter([{ requiredError: protErr }]);
    const protRes = await runShepherdPass({ ...BASE_CTX, adapter: prot.adapter });
    expect(protRes.state).toBe('HARD_STOP'); // insufficient scope on protection read

    const unreadable = scriptedAdapter([{ required: null, checks: [{ name: 'u', conclusion: 'SUCCESS' }], behind: 0 }]);
    const unreadableRes = await runShepherdPass({ ...BASE_CTX, adapter: unreadable.adapter });
    expect(unreadableRes.state).toBe('ESCALATE');

    const unknown = scriptedAdapter([{ required: ['u'], checks: [{ name: 'u', conclusion: null, status: 'IN_PROGRESS' }], behind: 0, mergeStateStatus: 'UNKNOWN' }]);
    const unknownRes = await runShepherdPass({ ...BASE_CTX, adapter: unknown.adapter });
    expect(unknownRes.state).toBe('PENDING'); // UNKNOWN is not a conflict
    expect(unknownRes.state).not.toBe('MERGE_READY');
  });

  // §5.6 — auth taxonomy.
  test('§5.6 403 scope → HARD_STOP; 403+Retry-After → resume; 401 → pause', async () => {
    const scopeErr = new Error('x'); scopeErr.httpStatus = 403;
    scopeErr.stderr = 'HTTP 403: Resource not accessible by integration';
    const scope = await runShepherdPass({ ...BASE_CTX, adapter: scriptedAdapter([{ requiredError: scopeErr }]).adapter });
    expect(scope.state).toBe('HARD_STOP');
    expect(scope.actions).toHaveLength(0); // no retries logged

    const rateErr = new Error('x'); rateErr.httpStatus = 403; rateErr.retryAfter = 30;
    const rate = await runShepherdPass({ ...BASE_CTX, adapter: scriptedAdapter([{ requiredError: rateErr }]).adapter });
    expect(rate.authClass).toBe('rate-limit');
    expect(rate.retryAfter).toBe(30);

    const expErr = new Error('x'); expErr.httpStatus = 401;
    const exp = await runShepherdPass({ ...BASE_CTX, adapter: scriptedAdapter([{ requiredError: expErr }]).adapter });
    expect(exp.authClass).toBe('expired');
    expect(exp.state).toBe('PENDING');
  });

  // §5.7 — zero-beads static scan of the four source files (strongest guard).
  test('§5.7 source files contain zero bd/.beads/dolt tokens', () => {
    const files = [
      'lib/pr-shepherd.js',
      'lib/adapters/pr-state-adapter.js',
      'lib/pr-state-validator.js',
      'lib/commands/shepherd.js',
    ];
    for (const rel of files) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      expect(/\bbd\b/i.test(src)).toBe(false);
      expect(/\.beads\b/i.test(src)).toBe(false);
      expect(/\bdolt\b/i.test(src)).toBe(false);
    }
  });

  // §5.8 — sync integrity.
  test('§5.8 node scripts/sync-commands.js --check exits 0', () => {
    const out = execFileSync('node', ['scripts/sync-commands.js', '--check'], { cwd: ROOT, encoding: 'utf8' });
    expect(typeof out).toBe('string');
  });

  // §5.9 — Shepherd is decoupled from the release gate. Observable assertion:
  // the shepherd source references no release-gate machinery, so a RED release
  // gate (unrelated D22 reasons) can never block or alter a shepherd pass.
  test('§5.9 shepherd source is decoupled from the release gate', () => {
    const sources = [
      fs.readFileSync(path.join(ROOT, 'lib', 'pr-shepherd.js'), 'utf8'),
      fs.readFileSync(path.join(ROOT, 'lib', 'commands', 'shepherd.js'), 'utf8'),
    ];
    for (const src of sources) {
      expect(/release\s+check/i.test(src)).toBe(false);
      expect(/premergeEmbeddedGate/.test(src)).toBe(false);
      expect(/freshClone/.test(src)).toBe(false);
    }
  });

  // §5.10 — HEAD-changed abort.
  test('§5.10 HEAD moving mid-pass aborts the mutating action', async () => {
    let reads = 0;
    const adapter = {
      id: 'head-move', kind: 'pr-state',
      async readState() {
        reads += 1;
        return { headSha: reads === 1 ? 'sha-1' : 'sha-2', mergeStateStatus: 'CLEAN',
          checks: [{ name: 'unit', conclusion: 'FAILURE', databaseId: '1' }], threads: [] };
      },
      async readRequiredChecks() { return ['unit']; },
      async readDivergence() { return { behind: 0, ahead: 1 }; },
      async rerunFailedChecks() { throw new Error('should not be called after HEAD moved'); },
      async replyToThread() {},
    };
    const res = await runShepherdPass({ ...BASE_CTX, adapter, rerunBudget: 3, rerunsUsed: 0 });
    expect(res.aborted).toBe(true);
  });

  // Command-level happy/handoff: one invocation = one pass, no merge in actions.
  test('command handler runs one pass and never carries a merge action', async () => {
    const s = scriptedAdapter([{ required: ['unit'], checks: [{ name: 'unit', conclusion: 'SUCCESS' }], behind: 0 }]);
    const out = await shepherdCmd.handler(['123'], {}, ROOT, {
      adapter: s.adapter,
      buildContext: async () => BASE_CTX,
    });
    expect(out.state).toBe('MERGE_READY');
    expect((out.actions || []).some((a) => a.type === 'merge')).toBe(false);
  });

  // Lifecycle — a merged/closed PR is terminal so the external scheduler stops
  // re-invoking it (previously the pass would keep returning MERGE_READY).
  test('lifecycle: merged PR → MERGED terminal, no merge action', async () => {
    const s = scriptedAdapter([{ state: 'MERGED', required: ['unit'], checks: [{ name: 'unit', conclusion: 'SUCCESS' }] }]);
    const res = await runShepherdPass({ ...BASE_CTX, adapter: s.adapter });
    expect(res.state).toBe('MERGED');
    expect(noMerge(res.actions)).toBe(true);
  });

  test('lifecycle: closed PR → CLOSED terminal', async () => {
    const s = scriptedAdapter([{ state: 'CLOSED' }]);
    const res = await runShepherdPass({ ...BASE_CTX, adapter: s.adapter });
    expect(res.state).toBe('CLOSED');
  });
});
