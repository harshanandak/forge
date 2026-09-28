'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ship = require('./ship');
const preflight = require('./preflight');
const shepherd = require('./shepherd');
const merge = require('./merge');
const { stripGlobalFlags } = require('../global-flags');
const { resolveOwnedKernel, closeIfOwned } = require('../kernel/owned-kernel');
const { resolveIssueId } = require('../kernel/issue-id-resolver');

const ISSUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_LINKAGE_ROWS = 10_000;
const EXTERNAL_COMMAND_TIMEOUT_MS = 120_000;

function normalizeRepository(value) {
  const candidate = typeof value === 'string' ? value.trim() : '';
  return REPOSITORY.test(candidate) ? candidate.toLowerCase() : null;
}

function normalizePath(value) {
  if (typeof value !== 'string' || !value) return null;
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function parseLinkArgs(argv) {
  const input = stripGlobalFlags(Array.isArray(argv) ? argv : []);
  const parsed = { pr: null, issueId: null, expectedHead: null, error: null };
  const seen = new Set();

  for (let index = 0; index < input.length; index += 1) {
    const raw = String(input[index]);
    const option = raw === '--issue' || raw.startsWith('--issue=')
      ? '--issue'
      : (raw === '--expect-head' || raw.startsWith('--expect-head=') ? '--expect-head' : null);
    if (option) {
      if (seen.has(option)) return { ...parsed, error: `Duplicate ${option} is not allowed.` };
      seen.add(option);
      let value = raw.includes('=') ? raw.slice(raw.indexOf('=') + 1) : null;
      if (value === null) {
        value = input[index + 1];
        if (!value || String(value).startsWith('--')) {
          return { ...parsed, error: `${option} requires a value.` };
        }
        index += 1;
      }
      if (option === '--issue') parsed.issueId = ISSUE_ID.test(value) ? value.toLowerCase() : null;
      else parsed.expectedHead = merge.normalizeFullHeadSha(value);
      if (option === '--issue' && !parsed.issueId) return { ...parsed, error: '--issue requires a full UUID.' };
      if (option === '--expect-head' && !parsed.expectedHead) {
        return { ...parsed, error: '--expect-head requires an exact 40-character SHA.' };
      }
      continue;
    }
    if (raw.startsWith('--')) return { ...parsed, error: `Unknown pr link option: ${raw}` };
    if (parsed.pr !== null) return { ...parsed, error: 'Exactly one PR number is required.' };
    parsed.pr = merge.normalizePrNumber(raw);
    if (!parsed.pr) return { ...parsed, error: 'PR selector must be one positive decimal PR number.' };
  }

  if (!parsed.pr || !parsed.issueId || !parsed.expectedHead) {
    parsed.error = 'Usage: forge pr link <pr> --issue <full-uuid> --expect-head <40-char-sha>';
  }
  return parsed;
}

function commandText(exec, bin, args, cwd) {
  return String(exec(bin, args, {
    cwd,
    encoding: 'utf8',
    timeout: EXTERNAL_COMMAND_TIMEOUT_MS,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })).trim();
}

function commandJson(exec, bin, args, cwd) {
  return JSON.parse(commandText(exec, bin, args, cwd));
}

// Every GitHub probe runs under the command's bound GitHub account when one is
// selected (lib/github-context.js runGh), exactly like ship/merge/shepherd; the
// raw CLI is only the unbound fallback. The bounded timeout applies either way.
function githubJson(opts, exec, args, cwd) {
  const context = opts.githubContext;
  if (context?.bound) {
    return JSON.parse(String(context.runGh(args, {
      cwd, timeout: EXTERNAL_COMMAND_TIMEOUT_MS,
    })).trim());
  }
  return commandJson(exec, 'gh', args, cwd);
}

function exactOwnership(ownership, env) {
  const actor = (typeof env.FORGE_ACTOR === 'string' && env.FORGE_ACTOR.trim())
    || (typeof env.FORGE_SESSION_ID === 'string' && env.FORGE_SESSION_ID.trim())
    || null;
  const sessionId = typeof env.FORGE_SESSION_ID === 'string' && env.FORGE_SESSION_ID.trim()
    ? env.FORGE_SESSION_ID.trim()
    : null;
  return actor && ownership?.owned === true && ownership.expired === false
    && ownership.actor === actor && ownership.claimedBy === actor
    && ownership.sessionId === sessionId
    ? { actor, sessionId }
    : null;
}

// A stored issue id may be a short prefix (forge worktree create accepts one), so
// it is resolved against the Kernel issue store before any comparison. Unknown,
// ambiguous or unresolvable ids return null and the caller fails closed.
async function canonicalIssueId(driver, storedId) {
  if (typeof storedId !== 'string' || !storedId) return null;
  if (ISSUE_ID.test(storedId)) return storedId.toLowerCase();
  if (typeof driver?.findIssueIdsByPrefix !== 'function') return null;
  const lookup = (prefix, limit) => driver.findIssueIdsByPrefix(prefix, limit, {}, {});
  const resolved = await resolveIssueId(storedId, lookup);
  return !resolved.error && ISSUE_ID.test(resolved.id) ? resolved.id.toLowerCase() : null;
}

const NUL = String.fromCharCode(0);
const liveKey = (worktreePath, branch) => JSON.stringify([normalizePath(worktreePath), branch]);

// The live git worktree inventory is the authority for which Kernel worktree rows
// still exist: `forge worktree remove`/`clean` can leave an active row behind.
// Returns a Set of live path+branch keys, or null when unreadable. Prunable
// entries (directory already gone) are not live.
function readLiveWorktrees(exec, root) {
  const raw = String(exec('git', ['worktree', 'list', '--porcelain', '-z'], {
    cwd: root,
    encoding: 'utf8',
    timeout: EXTERNAL_COMMAND_TIMEOUT_MS,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  }));
  const live = new Set();
  let entry = null;
  const flush = () => {
    if (entry?.path && entry.branch && !entry.prunable) live.add(liveKey(entry.path, entry.branch));
    entry = null;
  };
  for (const field of raw.split(NUL)) {
    if (field === '') {
      flush();
    } else if (field.startsWith('worktree ')) {
      flush();
      entry = { path: field.slice('worktree '.length) };
    } else if (entry && field.startsWith('branch refs/heads/')) {
      entry.branch = field.slice('branch refs/heads/'.length);
    } else if (entry && (field === 'prunable' || field.startsWith('prunable '))) {
      entry.prunable = true;
    }
  }
  flush();
  return live.size > 0 ? live : null;
}

function selectWorktree(rows, { root, branch, commonDir, live }) {
  if (!Array.isArray(rows)) return { error: 'Kernel worktree linkage is unreadable.' };
  if (rows.length > MAX_LINKAGE_ROWS) return { error: 'Kernel worktree linkage is oversized.' };
  if (!live) return { error: 'The live git worktree inventory is unreadable.' };
  if (!live.has(liveKey(root, branch))) {
    return { error: 'The current path and branch are not a live git worktree.' };
  }
  const active = rows.filter(row => row?.state === 'active'
    && normalizePath(row.git_common_dir) === normalizePath(commonDir)
    && live.has(liveKey(row.path, row.branch)));
  const pathMatches = active.filter(row => normalizePath(row.path) === normalizePath(root));
  const branchMatches = active.filter(row => row.branch === branch);
  const exact = active.filter(row => normalizePath(row.path) === normalizePath(root)
    && row.branch === branch);
  if (exact.length !== 1 || pathMatches.length !== 1 || branchMatches.length !== 1) {
    return { error: exact.length === 0
      ? 'No exact active Kernel worktree matches the current path and branch.'
      : 'Kernel worktree linkage is ambiguous for the current path or branch.' };
  }
  if (typeof exact[0].id !== 'string' || !exact[0].id) {
    return { error: 'The current worktree linkage has no authoritative id.' };
  }
  return { row: exact[0] };
}

function selectOpenPr(rows, repository, number) {
  if (!Array.isArray(rows)) return { error: 'Kernel PR linkage is unreadable.' };
  if (rows.length > MAX_LINKAGE_ROWS) return { error: 'Kernel open PR linkage is oversized.' };
  const matches = rows.filter(row => normalizeRepository(row?.repo) === repository
    && Number(row?.number) === Number(number));
  if (matches.length > 1) return { error: 'Kernel PR linkage is ambiguous.' };
  return { row: matches[0] || null };
}

function existingLinkConflict(row, { issueId, rowIssueId, worktreeId, branch }) {
  if (!row) return null;
  if (row.state !== 'open') return 'Kernel PR linkage is not open.';
  if (row.issue_id && rowIssueId !== issueId) return 'Kernel PR row is linked to a different issue.';
  if (row.worktree_id && row.worktree_id !== worktreeId) return 'Kernel PR row is linked to a different worktree.';
  if (row.branch && row.branch !== branch) return 'Kernel PR row is linked to a different branch.';
  return null;
}

function exactReadBack(row, expected) {
  return row?.state === 'open'
    && normalizePath(row.git_common_dir) === normalizePath(expected.gitCommonDir)
    && normalizeRepository(row.repo) === expected.repository
    && Number(row.number) === Number(expected.number)
    && row.issue_id === expected.issueId
    && row.worktree_id === expected.worktreeId
    && row.branch === expected.branch
    && merge.normalizeFullHeadSha(row.head_sha) === expected.headSha;
}

async function linkExistingPr(args, _flags, projectRoot, opts = {}) {
  const parsed = parseLinkArgs(args);
  if (parsed.error) return { success: false, error: parsed.error };

  const root = path.resolve(projectRoot || process.cwd());
  const exec = opts._execFileSync || execFileSync;
  const env = opts.env || process.env;
  const verifyOwnership = opts._verifyIssueOwnership || merge.defaultVerifyIssueOwnership;
  let kernel = null;
  try {
    const topLevel = commandText(exec, 'git', ['rev-parse', '--show-toplevel'], root);
    const branch = commandText(exec, 'git', ['branch', '--show-current'], root);
    const localHead = merge.normalizeFullHeadSha(commandText(exec, 'git', ['rev-parse', 'HEAD'], root));
    const rawGitCommonDir = commandText(
      exec, 'git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], root,
    );
    const gitCommonDir = rawGitCommonDir ? path.resolve(rawGitCommonDir) : null;
    if (normalizePath(topLevel) !== normalizePath(root) || !branch || !localHead || !gitCommonDir) {
      return { success: false, error: 'Run forge pr link from the PR branch worktree root.' };
    }
    if (localHead !== parsed.expectedHead) {
      return { success: false, error: 'The current worktree HEAD does not match --expect-head.' };
    }

    const repoIdentity = githubJson(
      opts, exec, ['repo', 'view', '--json', 'nameWithOwner,isFork,parent'], root,
    );
    const repository = repoIdentity?.isFork === true
      ? normalizeRepository(repoIdentity?.parent?.nameWithOwner)
      : (repoIdentity?.isFork === false ? normalizeRepository(repoIdentity?.nameWithOwner) : null);
    if (!repository) return { success: false, error: 'GitHub repository identity is unreadable.' };

    kernel = await resolveOwnedKernel(root, opts);
    if (!kernel.driver || typeof kernel.driver.listWorktrees !== 'function'
      || !kernel.broker || typeof kernel.broker.listOpenPrs !== 'function'
      || typeof kernel.broker.upsertPr !== 'function') {
      return { success: false, error: 'Kernel PR linkage broker is unavailable.' };
    }
    const worktree = selectWorktree(await kernel.driver.listWorktrees({ state: 'active' }), {
      root, branch, commonDir: gitCommonDir, live: readLiveWorktrees(exec, root),
    });
    if (!worktree.row) return { success: false, error: worktree.error };
    const worktreeIssueId = await canonicalIssueId(kernel.driver, worktree.row.issue_id);
    if (!worktreeIssueId) {
      return { success: false, error: 'The current worktree issue linkage does not resolve to one Kernel issue.' };
    }
    if (worktreeIssueId !== parsed.issueId) {
      return { success: false, error: 'The current worktree is linked to a different issue.' };
    }

    const before = selectOpenPr(await kernel.broker.listOpenPrs(gitCommonDir), repository, parsed.pr);
    if (before.error) return { success: false, error: before.error };
    const conflict = existingLinkConflict(before.row, {
      issueId: parsed.issueId,
      rowIssueId: await canonicalIssueId(kernel.driver, before.row?.issue_id),
      worktreeId: worktree.row.id,
      branch,
    });
    if (conflict) return { success: false, error: conflict };

    const prContext = githubJson(opts, exec, [
      'pr', 'view', String(parsed.pr), '--repo', repository, '--json',
      'number,state,headRefName,headRefOid,headRepository,isCrossRepository',
    ], root);
    if (prContext?.number !== Number(parsed.pr) || prContext?.state !== 'OPEN') {
      return { success: false, error: 'The requested GitHub PR is missing or not open.' };
    }
    if (merge.normalizeFullHeadSha(prContext.headRefOid) !== parsed.expectedHead
      || prContext.headRefName !== branch) {
      return { success: false, error: 'The GitHub PR branch or head does not match the current worktree.' };
    }
    const reportedHeadRepository = prContext?.headRepository?.nameWithOwner;
    if (prContext.isCrossRepository !== false
      || (reportedHeadRepository
        && normalizeRepository(reportedHeadRepository) !== repository)) {
      return { success: false, error: 'Cross-repository or mismatched GitHub PR linkage is not allowed.' };
    }

    const ownership = await verifyOwnership({
      issueId: parsed.issueId, projectRoot: root, env, readLiveSession: true,
    });
    const identity = exactOwnership(ownership, env);
    if (!identity) {
      return {
        success: false,
        error: `Active Kernel ownership claim with the exact actor/session is required for issue ${parsed.issueId}.`,
      };
    }

    await kernel.broker.upsertPr({
      git_common_dir: gitCommonDir,
      repo: repository,
      number: Number(parsed.pr),
      issue_id: parsed.issueId,
      worktree_id: worktree.row.id,
      branch,
      head_sha: parsed.expectedHead,
      state: 'open',
      registered_at: (opts._now || (() => new Date()))().toISOString(),
    }, identity);

    const after = selectOpenPr(await kernel.broker.listOpenPrs(gitCommonDir), repository, parsed.pr);
    if (!after.row || !exactReadBack(after.row, {
      gitCommonDir,
      repository,
      number: parsed.pr,
      issueId: parsed.issueId,
      worktreeId: worktree.row.id,
      branch,
      headSha: parsed.expectedHead,
    })) {
      return { success: false, error: `Failed to verify the exact open PR binding after write${after.error ? `: ${after.error}` : '.'}` };
    }

    return {
      success: true,
      linked: true,
      repository,
      pr: Number(parsed.pr),
      issueId: parsed.issueId,
      worktreeId: worktree.row.id,
      branch,
      headSha: parsed.expectedHead,
      output: `Linked ${repository}#${parsed.pr} to issue ${parsed.issueId}.`,
    };
  } catch (error) {
    return { success: false, error: `Could not link the existing PR: ${error.message}` };
  } finally {
    closeIfOwned(kernel);
  }
}

const link = { handler: linkExistingPr };

// One memorable surface over the EXISTING pull-request commands (kernel issue
// 6ab3f30c): every subcommand delegates to the standalone ship/preflight/shepherd/
// merge handlers — the same code, not a reimplementation. The standalone
// `forge ship`/`preflight`/`shepherd`/`merge` commands remain registered as
// back-compat aliases (see lib/commands/_aliases.js), so nothing that already
// calls them breaks. `pr ship` is the canonical PR-creation form; bare `ship`
// stays a visible shortcut.
//
// Delegates are referenced by MODULE (not a pre-bound `.handler`) so the routed
// handler is resolved at dispatch time — dispatch always reaches whatever the
// command module currently exports, keeping the standalone command the single
// source of truth for its own behaviour.
const SUBCOMMANDS = {
  link: {
    module: link,
    summary: 'Bind an existing open GitHub PR to its exact active Kernel issue/worktree',
  },
  ship: {
    module: ship,
    summary: 'Create a pull request from validated feature work (= forge ship)',
  },
  preflight: {
    module: preflight,
    summary: 'Fast deterministic-gate parity with CI (= forge preflight; supports --all)',
  },
  shepherd: {
    module: shepherd,
    summary: 'Run one bounded monitor pass over a PR (= forge shepherd; --bundle/--pull/--json, events, watch)',
  },
  merge: {
    module: merge,
    summary: 'Opt-in guarded merge, OFF by default (= forge merge --auto <pr> --expect-head <sha> --issue <id>)',
  },
};

const usage = 'Usage: forge pr <link|ship|preflight|shepherd|merge> [args]';

function renderHelp() {
  const width = Math.max(...Object.keys(SUBCOMMANDS).map(name => name.length));
  const lines = [
    usage,
    '',
    'Subcommands:',
    ...Object.entries(SUBCOMMANDS).map(
      ([name, { summary }]) => `  ${name.padEnd(width)}  ${summary}`
    ),
    '',
    'Back-compat: forge ship / forge preflight / forge shepherd / forge merge remain available as aliases.',
  ];
  return lines.join('\n');
}

async function handler(args, flags, projectRoot, opts) {
  // The subcommand is the first positional token; global flags (e.g. `-p <dir>`) are stripped
  // first so they never masquerade as the subcommand.
  const positional = stripGlobalFlags(args).find(arg => !arg.startsWith('-'));

  if (!positional || positional === 'help' || args.includes('--help') || args.includes('-h')) {
    return { success: true, output: renderHelp() };
  }

  const sub = SUBCOMMANDS[positional];
  if (!sub) {
    return {
      success: false,
      error: `Unknown pr subcommand: ${positional}\n\n${renderHelp()}`,
    };
  }

  // Forward everything EXCEPT the consumed subcommand token to the delegate, preserving
  // every remaining token (including flags like `--pull`/`--json`/`--bundle`, and the
  // `events`/`watch` shepherd sub-shapes) so passthrough stays byte-identical.
  const idx = args.indexOf(positional);
  const childArgs = idx >= 0 ? [...args.slice(0, idx), ...args.slice(idx + 1)] : args;
  return sub.module.handler(childArgs, flags, projectRoot, opts);
}

module.exports = {
  name: 'pr',
  githubAuth: (args = []) => ['link', 'ship', 'merge', 'shepherd']
    .includes(stripGlobalFlags(args).find(arg => !arg.startsWith('-'))),
  description:
    'Unified pull-request surface: forge pr link|ship|preflight|shepherd|merge',
  usage,
  handler,
  // Test/reuse seams for the guarded existing-PR binding.
  linkExistingPr,
  parseLinkArgs,
};
