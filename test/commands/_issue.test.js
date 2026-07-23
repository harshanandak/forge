'use strict';

const { describe, test, expect } = require('bun:test');

const { createIssueSubcommand } = require('../../lib/commands/_issue');

// These tests pin routing/normalization, not the check-after-write loop —
// gate.issue_verify would add a read-back runner call after each kernel
// mutation, so it is stubbed OFF here. Verification behavior has its own
// dedicated suite: test/commands/issue-verify.test.js.
const VERIFY_OFF = {
  resolveRuntimeGraph: () => ({ gates: [{ id: 'gate.issue_verify', enabled: false }] }),
};

// The issue command surface is de-beaded: every subcommand routes through the shared
// runIssueOperation seam with the subcommand name as the operation (dep fans out to
// dep.<action>). The backend abstraction (lib/forge-issues.js + the issue adapters)
// owns all tracker selection and argument translation — those translations are pinned
// in test/forge-issues.test.js, not here.
describe('forge issue helpers', () => {
  test('claim routes through the shared issue operation runner with the claim op', async () => {
    const calls = [];
    const claim = createIssueSubcommand('claim');

    const result = await claim.handler(['forge-abc'], {}, '/repo', {
      runIssueOperation: async (operation, args, projectRoot, deps) => {
        calls.push({ operation, args, projectRoot, deps });
        return { success: true, operation };
      },
    });

    expect(result).toEqual({ success: true, operation: 'claim' });
    expect(calls).toEqual([{
      operation: 'claim',
      args: ['forge-abc'],
      projectRoot: '/repo',
      deps: {
        runIssueOperation: expect.any(Function),
      },
    }]);
  });

  test('read aliases route through the shared issue operation runner for Kernel backends', async () => {
    const calls = [];
    const list = createIssueSubcommand('list');

    const result = await list.handler(['--json'], {}, '/repo', {
      useKernelBroker: true,
      runIssueOperation: async (operation, args, projectRoot, deps) => {
        calls.push({ operation, args, projectRoot, deps });
        return { success: true, operation, output: '[]' };
      },
    });

    expect(result).toEqual({ success: true, operation: 'list', output: '[]' });
    expect(calls).toEqual([{
      operation: 'list',
      args: ['--json'],
      projectRoot: '/repo',
      deps: {
        useKernelBroker: true,
        runIssueOperation: expect.any(Function),
      },
    }]);
  });

  test('KAP-7 derived read aliases (blocked/stale/orphans) route to their kernel operations', async () => {
    const calls = [];
    const opts = {
      useKernelBroker: true,
      runIssueOperation: async (operation, args, projectRoot, deps) => {
        calls.push({ operation, args, projectRoot, deps });
        return { ok: true, command: operation, data: { issues: [] } };
      },
    };

    await createIssueSubcommand('blocked').handler(['--json'], {}, '/repo', opts);
    await createIssueSubcommand('stale').handler(['--days', '7'], {}, '/repo', opts);
    await createIssueSubcommand('orphans').handler([], {}, '/repo', opts);

    expect(calls.map(call => ({ operation: call.operation, args: call.args }))).toEqual([
      { operation: 'blocked', args: ['--json'] },
      { operation: 'stale', args: ['--days', '7'] },
      { operation: 'orphans', args: [] },
    ]);
  });

  test('KAP-12 lint alias routes to the kernel lint operation', async () => {
    const calls = [];
    const opts = {
      useKernelBroker: true,
      runIssueOperation: async (operation, args, projectRoot, deps) => {
        calls.push({ operation, args, projectRoot, deps });
        return { ok: true, command: operation, data: { issues: [] } };
      },
    };

    await createIssueSubcommand('lint').handler(['--json'], {}, '/repo', opts);

    expect(calls.map(call => ({ operation: call.operation, args: call.args }))).toEqual([
      { operation: 'lint', args: ['--json'] },
    ]);
  });

  test('nested dependency commands route through the shared runner with operation names', async () => {
    const calls = [];
    const issue = require('../../lib/commands/issue');

    const result = await issue.handler(['dep', 'add', 'forge-work', 'forge-blocker'], {}, '/repo', {
      runIssueOperation: async (operation, args, projectRoot, deps) => {
        calls.push({ operation, args, projectRoot, deps });
        return { success: true, operation };
      },
    });

    expect(result).toEqual({ success: true, operation: 'dep.add' });
    expect(calls).toEqual([{
      operation: 'dep.add',
      args: ['forge-work', 'forge-blocker'],
      projectRoot: '/repo',
      deps: {
        runIssueOperation: expect.any(Function),
      },
    }]);
  });

  test('dep rejects an unknown action without hitting the runner', async () => {
    let invoked = false;
    const dep = createIssueSubcommand('dep');

    const result = await dep.handler(['cycle', 'forge-work', 'forge-blocker'], {}, '/repo', {
      runIssueOperation: async () => {
        invoked = true;
        return { success: true };
      },
    });

    expect(result).toEqual({
      success: false,
      error: 'Unsupported dependency action: cycle. Usage: forge issue dep <add|remove> <issue-id> <blocks-issue-id>',
    });
    expect(invoked).toBe(false);
  });

  test('claim and release route to their own operations through the shared runner', async () => {
    const calls = [];
    const claim = createIssueSubcommand('claim');
    const release = createIssueSubcommand('release');
    const opts = {
      useKernelBroker: true,
      runIssueOperation: async (operation, args, projectRoot) => {
        calls.push({ operation, args, projectRoot });
        return { success: true, operation };
      },
    };

    await expect(claim.handler(['forge-abc'], {}, '/repo', opts))
      .resolves.toEqual({ success: true, operation: 'claim' });
    await expect(release.handler(['forge-abc'], {}, '/repo', opts))
      .resolves.toEqual({ success: true, operation: 'release' });

    expect(calls).toEqual([
      { operation: 'claim', args: ['forge-abc'], projectRoot: '/repo' },
      { operation: 'release', args: ['forge-abc'], projectRoot: '/repo' },
    ]);
  });
});

describe('issue backend resolution from env/config', () => {
  test('FORGE_ISSUE_BACKEND=kernel injects issueBackend into the runner deps', async () => {
    const calls = [];
    const create = createIssueSubcommand('create');

    const result = await create.handler(['--title', 'Smoke'], {}, '/repo', {
      env: { FORGE_ISSUE_BACKEND: 'kernel' },
      ...VERIFY_OFF,
      runIssueOperation: async (operation, args, projectRoot, deps) => {
        calls.push({ operation, args, projectRoot, deps });
        return { ok: true, command: operation, data: { id: 'k1' } };
      },
    });

    // The kernel contract {ok,data,...} is normalized into the {success,output}
    // shape the CLI result printer understands. output preserves the FULL contract
    // envelope (ok/schema_version/command/data/next_commands) — see KAP-1. A success
    // envelope MUST carry ok:true (response-contract parity).
    expect(result.success).toBe(true);
    expect(result.operation).toBe('create');
    expect(JSON.parse(result.output)).toEqual({
      ok: true,
      command: 'create',
      data: { id: 'k1' },
      next_commands: [],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].operation).toBe('create');
    expect(calls[0].deps.issueBackend).toBe('kernel');
  });

  test('no backend signal leaves opts byte-identical (no injected issueBackend key)', async () => {
    const calls = [];
    const create = createIssueSubcommand('create');

    const result = await create.handler(['--title', 'Smoke'], {}, '/repo', {
      env: {},
      runIssueOperation: async (operation, args, projectRoot, deps) => {
        calls.push({ operation, args, projectRoot, deps });
        return { success: true, operation };
      },
    });

    expect(result).toEqual({ success: true, operation: 'create' });
    expect(calls).toHaveLength(1);
    expect(calls[0].deps).not.toHaveProperty('issueBackend');
  });

  test('an explicit opts.issueBackend is preserved (not overwritten by the resolver)', async () => {
    const calls = [];
    const ready = createIssueSubcommand('ready');

    await ready.handler([], {}, '/repo', {
      issueBackend: 'kernel',
      // A stale env value must not outrank the explicit opts selection.
      env: { FORGE_ISSUE_BACKEND: 'mongo' },
      runIssueOperation: async (operation, args, projectRoot, deps) => {
        calls.push({ deps });
        return { ok: true, command: operation, data: { issues: [] } };
      },
    });

    expect(calls[0].deps.issueBackend).toBe('kernel');
  });

  test('an explicit opts.issueBackend is run through the resolver (case-normalized)', async () => {
    const calls = [];
    const ready = createIssueSubcommand('ready');

    await ready.handler([], {}, '/repo', {
      issueBackend: 'KERNEL',
      env: {},
      runIssueOperation: async (operation, args, projectRoot, deps) => {
        calls.push({ deps });
        return { ok: true, command: operation, data: { issues: [] } };
      },
    });

    // 'KERNEL' is normalized to 'kernel' and routed to the broker. An early bypass
    // of the resolver would leave it raw, and shouldUseKernelBroker's exact
    // `=== 'kernel'` check would then miss the kernel-only code paths.
    expect(calls).toHaveLength(1);
    expect(calls[0].deps.issueBackend).toBe('kernel');
  });

  test('a kernel error contract is normalized into a {success:false,error,exitCode} result', async () => {
    const show = createIssueSubcommand('show');

    // No --json: the human message goes to stderr, but the contract exit_code is
    // still surfaced as result.exitCode so the bin printer exits with the error
    // class's code instead of collapsing every failure to exit 1.
    const result = await show.handler(['nope'], {}, '/repo', {
      issueBackend: 'kernel',
      env: {},
      runIssueOperation: async (operation) => ({
        ok: false,
        command: operation,
        error: { code: 'FORGE_ISSUE_NOT_FOUND', message: 'Issue nope not found', exit_code: 4, retryable: false },
        next_commands: [],
      }),
    });

    expect(result).toEqual({ success: false, error: 'Issue nope not found', exitCode: 4 });
  });

  test('a kernel ok contract preserves the FULL envelope in output (KAP-1)', async () => {
    const create = createIssueSubcommand('create');

    const result = await create.handler(['--title', 'X'], {}, '/repo', {
      issueBackend: 'kernel',
      env: {},
      runIssueOperation: async () => ({
        ok: true,
        schema_version: 'forge.issue.v1',
        command: 'issue.create',
        data: { id: 'k1' },
        next_commands: ['forge issue show k1 --json'],
      }),
    });

    expect(result.success).toBe(true);
    expect(result.operation).toBe('create');
    const envelope = JSON.parse(result.output);
    expect(envelope.ok).toBe(true);
    expect(envelope.schema_version).toBe('forge.issue.v1');
    expect(envelope.command).toBe('issue.create');
    expect(envelope.data).toEqual({ id: 'k1' });
    expect(envelope.next_commands).toEqual(['forge issue show k1 --json']);
  });

  test('a legacy {success,output} result passes through unchanged', async () => {
    // `create` is a write subcommand, so it always routes through the shared
    // runner — letting us assert the normalizer leaves a {success,output} result
    // byte-identical (only the contract {ok,...} shape is transformed).
    const create = createIssueSubcommand('create');

    const result = await create.handler(['--title', 'X'], {}, '/repo', {
      env: {},
      runIssueOperation: async (operation) => ({ success: true, operation, output: 'created', stderr: '' }),
    });

    expect(result).toEqual({ success: true, operation: 'create', output: 'created', stderr: '' });
  });
});

describe('kernel create positional-title parity', () => {
  // `forge create "title"` is the natural CLI shape, but the Kernel create payload
  // reads only --title. When kernel deps are assembled on opts, a single leading bare
  // positional is translated to `--title <value>` so the title isn't dropped.
  function captureKernelCreate(args, extraOpts = {}) {
    const calls = [];
    const create = createIssueSubcommand('create');
    return create
      .handler(args, {}, '/repo', {
        issueBackend: 'kernel',
        runIssueOperation: async (operation, operationArgs, projectRoot, deps) => {
          calls.push({ operation, operationArgs, projectRoot, deps });
          return { ok: true, data: { id: 'k1', revision: 0 } };
        },
        ...extraOpts,
      })
      .then(() => calls);
  }

  test('a leading positional title is mapped to --title for the kernel', async () => {
    const calls = await captureKernelCreate(['my title', '--type', 'task']);

    expect(calls[0].operation).toBe('create');
    expect(calls[0].operationArgs).toEqual(['--title', 'my title', '--type', 'task']);
  });

  test('an explicit --title is never double-injected', async () => {
    const calls = await captureKernelCreate(['--title', 'X', '--type', 'task']);

    expect(calls[0].operationArgs).toEqual(['--title', 'X', '--type', 'task']);
  });

  test('an explicit --title= form is also left untouched', async () => {
    const calls = await captureKernelCreate(['--title=X', '--type', 'task']);

    expect(calls[0].operationArgs).toEqual(['--title=X', '--type', 'task']);
  });

  test('a flag-first invocation never mistakes a flag value for the title', async () => {
    const calls = await captureKernelCreate(['--type', 'task']);

    // No leading positional → no --title injected; `task` stays the --type value.
    expect(calls[0].operationArgs).toEqual(['--type', 'task']);
  });

  test('opts without assembled kernel deps pass the positional through verbatim', async () => {
    // The translation is gated on assembled kernel deps (shouldUseKernelBroker), so a
    // caller that injects only a runner keeps its args untouched — no --title
    // injection behind an injected runner's back.
    const calls = [];
    const create = createIssueSubcommand('create');
    await create.handler(['my title'], {}, '/repo', {
      env: {},
      runIssueOperation: async (operation, operationArgs, projectRoot, deps) => {
        calls.push({ operation, operationArgs, deps });
        return { success: true, operation, output: 'created', stderr: '' };
      },
    });

    expect(calls[0].deps).not.toHaveProperty('issueBackend');
    expect(calls[0].operationArgs).toEqual(['my title']);
  });
});

describe('kernel batch close (KAP-9)', () => {
  // The kernel close op closes a single id (first positional), but `forge close a b c`
  // must keep working, so the CLI fans out one runner call per id (when kernel deps are
  // assembled) and aggregates a single {success,output} result.
  test('closes each id and aggregates success on the kernel path', async () => {
    const calls = [];
    const close = createIssueSubcommand('close');

    const result = await close.handler(['k1', 'k2'], {}, '/repo', {
      issueBackend: 'kernel',
      ...VERIFY_OFF,
      runIssueOperation: async (operation, args) => {
        calls.push({ operation, args });
        return { ok: true, command: operation, data: { id: args[0], revision: 1 } };
      },
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ operation: 'close', args: ['k1'] });
    expect(calls[1]).toEqual({ operation: 'close', args: ['k2'] });
    expect(result.success).toBe(true);
    expect(result.operation).toBe('close');
    // Response-contract parity: a multi-id close aggregates into ONE forge.issue.v1
    // envelope (the contract `mutationBatch` shape), never a bare array.
    const envelope = JSON.parse(result.output);
    expect(Array.isArray(envelope)).toBe(false);
    expect(envelope.ok).toBe(true);
    expect(envelope.schema_version).toBe('forge.issue.v1');
    expect(envelope.command).toBe('issue.close');
    const summary = envelope.data.results;
    expect(summary).toHaveLength(2);
    expect(summary[0].id).toBe('k1');
    expect(summary[0].ok).toBe(true);
    expect(summary[1].id).toBe('k2');
    expect(summary[1].ok).toBe(true);
    expect(envelope.data.closed).toEqual(['k1', 'k2']);
  });

  test('preserves trailing flags on each per-id kernel close call', async () => {
    const calls = [];
    const close = createIssueSubcommand('close');

    await close.handler(['k1', 'k2', '--reason', 'done'], {}, '/repo', {
      issueBackend: 'kernel',
      ...VERIFY_OFF,
      runIssueOperation: async (operation, args) => {
        calls.push({ operation, args });
        return { ok: true, command: operation, data: { id: args[0] } };
      },
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ operation: 'close', args: ['k1', '--reason', 'done'] });
    expect(calls[1]).toEqual({ operation: 'close', args: ['k2', '--reason', 'done'] });
  });

  test('aggregates a failure: success=false and lists the failing id', async () => {
    const close = createIssueSubcommand('close');

    const result = await close.handler(['k1', 'k2'], {}, '/repo', {
      issueBackend: 'kernel',
      ...VERIFY_OFF,
      runIssueOperation: async (operation, args) => {
        if (args[0] === 'k2') {
          return { ok: false, command: operation, error: { message: 'Issue k2 not found' } };
        }
        return { ok: true, command: operation, data: { id: args[0] } };
      },
    });

    expect(result.success).toBe(false);
    expect(result.operation).toBe('close');
    // One envelope (ok:false) carrying per-id outcomes; the failing id keeps the
    // structured contract error object, not a flattened string.
    const envelope = JSON.parse(result.output);
    expect(Array.isArray(envelope)).toBe(false);
    expect(envelope.ok).toBe(false);
    const summary = envelope.data.results;
    expect(summary[0]).toEqual({ id: 'k1', ok: true });
    expect(summary[1]).toEqual({ id: 'k2', ok: false, error: { message: 'Issue k2 not found' } });
    expect(envelope.data.closed).toEqual(['k1']);
  });

  test('a single kernel close id keeps the byte-identical envelope output', async () => {
    const calls = [];
    const close = createIssueSubcommand('close');

    const result = await close.handler(['k1'], {}, '/repo', {
      issueBackend: 'kernel',
      ...VERIFY_OFF,
      runIssueOperation: async (operation, args) => {
        calls.push({ operation, args });
        return {
          ok: true,
          schema_version: 'forge.issue.v1',
          command: 'issue.close',
          data: { id: 'k1', revision: 2 },
          next_commands: [],
        };
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ operation: 'close', args: ['k1'] });
    expect(result.success).toBe(true);
    expect(result.operation).toBe('close');
    const envelope = JSON.parse(result.output);
    expect(envelope.schema_version).toBe('forge.issue.v1');
    expect(envelope.data).toEqual({ id: 'k1', revision: 2 });
  });

  test('without assembled kernel deps, multiple ids stay a single runner call', async () => {
    const calls = [];
    const close = createIssueSubcommand('close');

    const result = await close.handler(['k1', 'k2'], {}, '/repo', {
      env: {},
      runIssueOperation: async (operation, args) => {
        calls.push({ operation, args });
        return { success: true, operation, output: 'closed' };
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ operation: 'close', args: ['k1', 'k2'] });
    expect(result).toEqual({ success: true, operation: 'close', output: 'closed' });
  });
});

describe('id-required subcommands reject a missing id with a clean usage error (842a8be7)', () => {
  test('claim with no positional id fails with exit 6 (not a fabricated-UUID quarantine)', async () => {
    const claim = createIssueSubcommand('claim');
    // The guard returns before the backend is resolved, so no runner is needed.
    const result = await claim.handler([], {}, '/repo', { issueBackend: 'kernel', env: {} });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Missing required argument');
    expect(result.exitCode).toBe(6);
  });

  test('show with only flags (no id) is likewise rejected', async () => {
    const show = createIssueSubcommand('show');
    const result = await show.handler(['--json'], {}, '/repo', { issueBackend: 'kernel', env: {} });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Missing required argument');
  });
});
