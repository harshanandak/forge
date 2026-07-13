'use strict';

const { describe, test, expect } = require('bun:test');

const hooks = require('../lib/commands/hooks');
const { INSTRUCTION_TAG } = require('../lib/inbox');

const IDENTITY = { actor: 'agent-a', sessionId: null, worktreeId: 'wt-a' };

function pendingOpts(extra = {}) {
  return {
    identity: IDENTITY,
    fetchClaims: () => [{ actor: 'agent-a', session_id: null, worktree_id: 'wt-a', issue_id: 'i1' }],
    resolveDashboardInboxId: () => null,
    fetchComments: () => [{ id: 'c1', body: `${INSTRUCTION_TAG} act on this now`, actor: 'human' }],
    ...extra,
  };
}

function run(args, opts) {
  return hooks.handler(args, {}, '/root', opts);
}

describe('forge hooks inbox-pickup (UserPromptSubmit — compliant comment-back)', () => {
  test('claude emits UserPromptSubmit JSON with the fenced inbox digest', async () => {
    const res = await run(['inbox-pickup', '--harness', 'claude'], pendingOpts());
    expect(res.success).toBe(true);
    const parsed = JSON.parse(res.output);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('act on this now');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('UNTRUSTED dashboard-comment');
  });

  test('honest skip: cursor / codex / hermes render nothing (no faked parity)', async () => {
    for (const harness of ['cursor', 'codex', 'hermes']) {
      const res = await run(['inbox-pickup', '--harness', harness], pendingOpts());
      expect(res.success).toBe(true);
      expect(res.output).toBe('');
    }
  });

  test('empty inbox → empty output (harness injects nothing)', async () => {
    const res = await run(['inbox-pickup', '--harness', 'claude'], pendingOpts({ fetchComments: () => [] }));
    expect(res.success).toBe(true);
    expect(res.output).toBe('');
  });

  test('fail-open: a throwing fetcher never errors the hook', async () => {
    const res = await run(['inbox-pickup', '--harness', 'claude'], {
      identity: IDENTITY,
      fetchClaims: () => { throw new Error('kernel down'); },
    });
    expect(res.success).toBe(true);
    expect(res.output).toBe('');
  });

  test('default harness is claude when --harness omitted', async () => {
    const res = await run(['inbox-pickup'], pendingOpts());
    const parsed = JSON.parse(res.output);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
  });
});
