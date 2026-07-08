'use strict';

const { runIssueOperation: defaultRunIssueOperation } = require('../forge-issues');
const { resolveIssueBackend, hasExplicitBackendSignal, shouldUseKernelBroker } = require('../issue-backend');
const {
  ISSUE_COMMAND_SCHEMA_VERSION,
  ISSUE_COMMAND_ERROR_SCHEMA_VERSION,
  ISSUE_COMMAND_EXIT_CODES,
  resolveNextCommands,
  normalizePriority,
} = require('../kernel/issue-command-contract');
const { getResolvedRuntimeGraph } = require('../core/runtime-graph');
const { renderIssueEnvelope } = require('../issue-render');

// The Forge issue command surface. Each subcommand routes through the shared
// runIssueOperation, which selects the active backend (Kernel by --kernel /
// --issue-backend kernel / FORGE_ISSUE_BACKEND=kernel; Beads otherwise) and performs
// any backend-specific argument translation. This module therefore carries NO direct
// issue-tracker invocation or argv translation — those live in the backend
// abstraction (lib/forge-issues.js + the issue adapters).
const SUBCOMMANDS = {
  create: {
    description: 'Create an issue via Forge',
    usage: 'forge create [title] [flags]',
  },
  update: {
    description: 'Update an issue via Forge',
    usage: 'forge update <id...> [flags]',
  },
  claim: {
    description: 'Claim an issue via Forge',
    usage: 'forge claim <id> [flags]',
  },
  release: {
    description: 'Release a Kernel issue claim via Forge',
    usage: 'forge release <id>',
  },
  comment: {
    description: 'Add an issue comment via Forge',
    usage: 'forge comment <id> <body...>',
  },
  close: {
    description: 'Close an issue via Forge',
    usage: 'forge close <id...> [flags]',
  },
  show: {
    description: 'Show an issue via Forge',
    usage: 'forge show <id> [flags]',
  },
  list: {
    description: 'List issues via Forge',
    usage: 'forge list [flags]',
  },
  ready: {
    description: 'Show ready issues via Forge',
    usage: 'forge ready [flags]',
  },
  search: {
    description: 'Search issues via Forge',
    usage: 'forge issue search <query> [flags]',
  },
  stats: {
    description: 'Show issue statistics via Forge',
    usage: 'forge issue stats [flags]',
  },
  // KAP-7: derived read queries. The backend abstraction maps each to its tracker
  // equivalent (the Kernel passes the operation name through unchanged; the Beads
  // backend maps each to its passthrough subcommand). They are READS, so they are
  // intentionally NOT in WRITE_SUBCOMMANDS.
  blocked: {
    description: 'Show blocked issues via Forge',
    usage: 'forge issue blocked [flags]',
  },
  stale: {
    description: 'Show stale issues via Forge',
    usage: 'forge issue stale [--days <n>]',
  },
  orphans: {
    description: 'Show issues with dangling dependency edges via Forge',
    usage: 'forge issue orphans',
  },
  // KAP-12: read-only content lint — issues missing required content
  // (task/bug with no acceptance_criteria). A READ, so NOT in WRITE_SUBCOMMANDS.
  lint: {
    description: 'Show issues missing required content via Forge',
    usage: 'forge issue lint',
  },
  // Epic support: an epic's DIRECT children + kernel-computed rollup
  // (done-only percentage, per-status counts, blocked list). A READ, so
  // intentionally NOT in WRITE_SUBCOMMANDS.
  children: {
    description: 'Show an epic\'s child issues + rollup via Forge',
    usage: 'forge issue children <epic-id> [--json]',
  },
  // Lease-ownership verification (kernel d71a824b). A READ whose EXIT CODE encodes the
  // verdict: exit 0 iff the resolving actor holds the live lease, non-zero otherwise.
  // A claim returning ok:true does not prove ownership (a duplicate replay also returns
  // ok:true), so a worker calls `owns` to CONFIRM before mutating a claimed issue. A
  // READ, so intentionally NOT in WRITE_SUBCOMMANDS.
  owns: {
    description: 'Verify the current actor holds the live lease on an issue via Forge',
    usage: 'forge issue owns <id> [--json]',
  },
  dep: {
    description: 'Manage issue dependencies via Forge',
    usage: 'forge issue dep <add|remove> <issue-id> <blocks-issue-id>',
    // The dep subcommand fans out to two actions. Declaring them here keeps the
    // supported action set discoverable from the command spec (and lets the
    // release-readiness gate confirm dep add/remove are present).
    actions: {
      add: { description: 'Add a dependency edge (issue-id blocked by blocks-issue-id)' },
      remove: { description: 'Remove a dependency edge' },
    },
  },
};

const WRITE_SUBCOMMANDS = new Set(['create', 'update', 'claim', 'release', 'comment', 'close', 'dep']);

// Human-first reads (kernel issue a9bbd065, 0.1.0 critical path): these
// subcommands default to a compact text rendering (lib/issue-render.js) instead
// of the raw forge.issue.v1 envelope. --json (or FORGE_JSON=1) restores the
// byte-identical contract output for scripts. DELIBERATE breaking change to the
// DEFAULT output only, approved before the 0.1.0 API freeze — the kernel
// contract itself is untouched.
const HUMAN_RENDERED_SUBCOMMANDS = new Set(['ready', 'list', 'show']);
// Writes render a human confirmation ONLY at an interactive TTY; piped/CI callers keep
// the machine-parseable JSON envelope by default so scripts work without --json (842a8be7).
const HUMAN_RENDERED_WRITE_SUBCOMMANDS = new Set(['create', 'update', 'claim', 'release', 'comment', 'close']);
const DEP_ACTIONS = Object.keys(SUBCOMMANDS.dep.actions);

// ---------------------------------------------------------------------------
// Check-after-write verification (gate.issue_verify, kernel issue 5f928cd0).
//
// The kernel has two PROVEN cases where a mutation's ok:true lied about the
// stored outcome: 145d9ad1 (close --reason/closed_at dropped by the
// kernel_issues projection) and d71a824b (idempotent claim replay telling a
// losing agent it won). So after a successful kernel mutation, this boundary
// re-reads the issue THROUGH THE SAME runner/broker and asserts the intended
// delta actually landed, emitting `verified: true|false` + `mismatches: []` in
// the envelope. WARN MODE ONLY: a mismatch prints a warning and the write's
// success/exit code are never touched; a verification READ error yields
// `verified: null` (unknown) rather than failing the write. Governed by the
// default-ON, unlocked `gate.issue_verify` (runtime-graph) — disable via
// `forge gate disable gate.issue_verify`, which skips the read-back entirely.
const ISSUE_VERIFY_GATE_ID = 'gate.issue_verify';
const VERIFIED_SUBCOMMANDS = new Set(['create', 'update', 'close', 'claim', 'comment']);

// Resolve whether gate.issue_verify is enabled for this project. An injected
// opts.resolveRuntimeGraph wins (tests); an unresolvable config (lint errors)
// SKIPS verification rather than breaking the write path.
function isIssueVerifyEnabled(projectRoot, opts = {}) {
  const resolveGraph = opts.resolveRuntimeGraph || getResolvedRuntimeGraph;
  try {
    const graph = resolveGraph({ projectRoot });
    const gate = (graph.gates || []).find(candidate => candidate.id === ISSUE_VERIFY_GATE_ID);
    return gate ? gate.enabled !== false : true;
  } catch {
    return false;
  }
}

// Minimal --flag parser mirroring the broker's parseFlagPairs semantics
// (--key value and --key=value; last value wins) so the expected delta is
// derived from the SAME tokens the broker consumed.
function parseVerifyFlags(args = []) {
  const flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (typeof token !== 'string' || !token.startsWith('--')) continue;
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = args[index + 1];
    if (typeof next === 'string' && !next.startsWith('--')) {
      flags[body] = next;
      index += 1;
    } else {
      flags[body] = true;
    }
  }
  return flags;
}

// The exact-match fields a mutation promised, derived from its flags. Only the
// REQUESTED fields are asserted (no coupling to backend defaults). Close always
// asserts the terminal status the broker resolves (explicit --status wins, else
// 'done' — mirrors the driver's resolveMutationStatus).
function expectedIssueFields(subcommand, flags) {
  const expected = {};
  if (subcommand === 'create' || subcommand === 'update') {
    if (typeof flags.title === 'string') expected.title = flags.title;
  }
  if (subcommand === 'create' && typeof flags.type === 'string') expected.type = flags.type;
  if (subcommand === 'update') {
    if (typeof flags.status === 'string') expected.status = flags.status;
    if (typeof flags.assignee === 'string') expected.assignee = flags.assignee;
    if (typeof flags.priority === 'string') expected.priority = normalizePriority(flags.priority);
  }
  if (subcommand === 'close') {
    expected.status = typeof flags.status === 'string' ? flags.status : 'done';
  }
  return expected;
}

function collectFieldMismatches(expected, data) {
  const mismatches = [];
  for (const [field, value] of Object.entries(expected)) {
    const stored = data ? data[field] : undefined;
    if (stored !== value) {
      mismatches.push(`${field}: expected ${JSON.stringify(value)}, read back ${JSON.stringify(stored ?? null)}`);
    }
  }
  return mismatches;
}

// Close-specific presence checks — the regression trap for 145d9ad1, where the
// projection silently dropped closed_at and the --reason text.
function collectCloseMismatches(flags, data, mismatches) {
  if (data.closed_at === null || data.closed_at === undefined) {
    mismatches.push('closed_at: expected a close timestamp, read back null (145d9ad1-class projection drop)');
  }
  const reasonRequested = typeof flags.reason === 'string' || typeof flags['close-reason'] === 'string';
  if (reasonRequested && (data.close_reason === null || data.close_reason === undefined)) {
    mismatches.push('close_reason: expected the requested reason to persist, read back null (145d9ad1-class projection drop)');
  }
}

// Claim verification uses the claim-safety primitive directly: `owns` encodes
// "does the RESOLVING ACTOR hold the live lease" — exactly the check that
// catches a d71a824b phantom-claim replay (ok:true for a lease someone else holds).
async function verifyClaimDelta(runner, issueId, projectRoot, opts) {
  const readBack = await runner('owns', [issueId, '--json'], projectRoot, opts);
  if (!readBack || readBack.ok !== true || !readBack.data || typeof readBack.data !== 'object') {
    return { verified: null };
  }
  if (readBack.data.owned === true) {
    return { verified: true, mismatches: [] };
  }
  const heldBy = JSON.stringify(readBack.data.claimed_by ?? null);
  return {
    verified: false,
    mismatches: [
      `claimed_by: expected the resolved actor to hold the live lease, but owns reports held by ${heldBy} `
      + '(d71a824b-class phantom-claim replay)',
    ],
  };
}

// Comment verification matches the MINTED comment_id in the re-read comments
// array (show returns comments with ids), sidestepping the count-increment
// approach that would need a pre-write read.
function verifyCommentDelta(result, data) {
  const commentId = result.data && typeof result.data.comment_id === 'string' ? result.data.comment_id : null;
  if (!commentId) return { verified: null };
  const comments = Array.isArray(data.comments) ? data.comments : [];
  if (comments.some(comment => comment && comment.id === commentId)) {
    return { verified: true, mismatches: [] };
  }
  return {
    verified: false,
    mismatches: [`comment: expected comment ${commentId} on the issue, not found in the read-back`],
  };
}

// Re-read the mutated issue through the SAME runner and assert the intended
// delta. Returns { verified: true|false|null, mismatches? }. NEVER throws — a
// verification failure must never make a successful write report failure.
async function verifyIssueMutation(subcommand, operationArgs, result, runner, projectRoot, opts) {
  try {
    const flags = parseVerifyFlags(operationArgs);
    const issueId = (result.data && typeof result.data.id === 'string' && result.data.id)
      ? result.data.id
      : operationArgs.find(arg => typeof arg === 'string' && !arg.startsWith('-'));
    if (!issueId) return { verified: null };
    if (subcommand === 'claim') {
      return await verifyClaimDelta(runner, issueId, projectRoot, opts);
    }
    const readBack = await runner('show', [issueId, '--json'], projectRoot, opts);
    if (!readBack || readBack.ok !== true || !readBack.data || typeof readBack.data !== 'object') {
      return { verified: null };
    }
    if (subcommand === 'comment') {
      return verifyCommentDelta(result, readBack.data);
    }
    const mismatches = collectFieldMismatches(expectedIssueFields(subcommand, flags), readBack.data);
    if (subcommand === 'close') {
      collectCloseMismatches(flags, readBack.data, mismatches);
    }
    return { verified: mismatches.length === 0, mismatches };
  } catch {
    return { verified: null };
  }
}

// Warn-mode reporting: verified:false lists the mismatches; verified:null says
// the read-back could not confirm. Either way the write stays successful.
function warnVerifyOutcome(subcommand, issueRef, verification) {
  if (verification.verified === true) return;
  const lines = verification.verified === false
    ? [
      `[forge verify] WARNING: '${subcommand}' reported ok but the read-back of ${issueRef} does not match the requested change:`,
      ...verification.mismatches.map(entry => `  - ${entry}`),
    ]
    : [`[forge verify] WARNING: '${subcommand}' succeeded but the read-back of ${issueRef} could not confirm the change (verification read failed).`];
  lines.push('The write itself succeeded (exit 0). Check-after-write is governed by gate.issue_verify (warn mode) — disable via: forge gate disable gate.issue_verify');
  console.warn(lines.join('\n'));
}

// Run verification for one successful mutation result and attach the outcome
// (verified / mismatches) to it, warning on anything but verified:true.
async function applyIssueVerification(subcommand, operationArgs, result, runner, projectRoot, opts) {
  const verification = await verifyIssueMutation(subcommand, operationArgs, result, runner, projectRoot, opts);
  result.verified = verification.verified;
  if (Array.isArray(verification.mismatches)) {
    result.mismatches = verification.mismatches;
  }
  const issueRef = (result.data && result.data.id) || operationArgs.find(arg => typeof arg === 'string' && !arg.startsWith('-')) || '<issue>';
  warnVerifyOutcome(subcommand, issueRef, verification);
}

function normalizeArgs(args = []) {
  return args.filter(arg => arg !== '--');
}

function formatIssueHelp() {
  const lines = [
    'Usage: forge issue <subcommand> [...]',
    '',
    'Supported subcommands:',
  ];

  for (const [name, spec] of Object.entries(SUBCOMMANDS)) {
    lines.push(`  ${name.padEnd(6)} ${spec.description}`);
  }

  lines.push('');
  lines.push('Examples:');
  lines.push('  forge create --title "Add feature" --type feature');
  lines.push('  forge claim forge-abc');
  lines.push('  forge update forge-abc --priority 1');
  lines.push('  forge close forge-abc --reason "Done"');
  lines.push('  forge comment forge-abc "Handoff note"');
  lines.push('  forge issue show forge-abc --json');
  lines.push('  forge issue search "kernel contract" --json');
  lines.push('  forge issue stats --json');
  lines.push('  forge issue dep add forge-work forge-blocker');

  return lines.join('\n');
}

// Map a CLI subcommand to the backend operation name. `dep` fans out to
// `dep.<action>`; every other subcommand uses its own name (the backend performs
// any tracker-specific translation, e.g. Beads claim -> `update <id> --claim`).
function resolveIssueOperation(subcommand, args) {
  if (subcommand === 'dep') {
    return `dep.${normalizeArgs(args)[0]}`;
  }
  return subcommand;
}

// The Kernel create payload (buildCreatePayload) reads only the --title flag, so a
// bare leading positional (`forge create "title"`) would be ignored and the title
// would default to the minted UUID. For parity on the KERNEL PATH ONLY, translate a
// single leading bare positional into `--title <value>` when no explicit
// --title/--title= is present. The Beads backend keeps its native positional
// handling (this never runs for the Beads path).
function withKernelCreateTitle(args) {
  const hasTitle = args.some(
    arg => arg === '--title' || (typeof arg === 'string' && arg.startsWith('--title=')),
  );
  if (hasTitle || args.length === 0) {
    return args;
  }
  const leading = args[0];
  if (typeof leading === 'string' && !leading.startsWith('-')) {
    return ['--title', leading, ...args.slice(1)];
  }
  return args;
}

// Resolve the operation args passed to the backend. `dep` drops its leading action
// token (it is carried in the operation name); `create` on the Kernel path gains the
// positional-title parity translation. Everything else passes its normalized args
// through verbatim.
function resolveOperationArgs(subcommand, args, opts = {}) {
  const normalizedArgs = normalizeArgs(args);

  if (subcommand === 'dep') {
    return normalizedArgs.slice(1);
  }

  if (subcommand === 'create' && shouldUseKernelBroker(opts)) {
    return withKernelCreateTitle(normalizedArgs);
  }

  return normalizedArgs;
}

// Validate the dep action up front so a bad `forge issue dep <action>` fails with a
// usage message instead of routing to a `dep.undefined` operation.
function validateDepArgs(args) {
  const normalized = normalizeArgs(args);
  const [action, ...rest] = normalized;
  if (!DEP_ACTIONS.includes(action)) {
    return {
      error: `Unsupported dependency action: ${action || '(missing)'}. Usage: forge issue dep <add|remove> <issue-id> <blocks-issue-id>`,
    };
  }
  if (rest.length < 2) {
    return {
      error: `Missing dependency ids. Usage: forge issue dep ${action} <issue-id> <blocks-issue-id>`,
    };
  }
  return null;
}

// Resolve the active issue backend (kernel|beads) and thread it into opts so the
// shared runIssueOperation deps see it. OPT-IN ONLY: opts is left byte-identical
// when no explicit signal is present (env/config/explicit), preserving the Beads
// default path. A copy is returned — the caller's opts object is never mutated.
function withResolvedIssueBackend(projectRoot, opts = {}) {
  const env = opts.env || process.env;
  const signalContext = { deps: opts, env, projectRoot };
  if (!hasExplicitBackendSignal(signalContext)) {
    return opts;
  }

  // Run EVERY explicit value through the resolver — including an explicit
  // opts.issueBackend — so case is normalized and unknown values warn + fall back.
  // opts.issueBackend still wins precedence over env/config inside the resolver.
  // Identity is preserved when the resolved value already matches, keeping the
  // no-op path byte-identical.
  const issueBackend = resolveIssueBackend(signalContext);
  if (opts.issueBackend === issueBackend) {
    return opts;
  }
  return { ...opts, issueBackend };
}

// The Kernel broker returns the issue-command contract shape
// ({ ok, schema_version, command, data, next_commands } or { ok:false, error })
// rather than the Beads-style { success, output }. The bin/forge.js result printer
// keys on `success`/`output`, so a raw kernel contract would render as
// "Command failed". Normalize ONLY the contract shape (ok defined, success
// undefined) into { success, output } here, at the command boundary — the kernel
// contract itself stays untouched. Every other result passes through byte-identical.
//
// Response-contract parity (the Beads behavior the Kernel replaced):
//   * SUCCESS  → the printed envelope carries `ok:true` (consumers gate on it).
//   * FAILURE  → the contract `exit_code` is surfaced as `result.exitCode` so the bin
//                printer exits with the error class's code (not always 1); and on
//                `--json` the full forge.issue.error.v1 envelope is emitted on stdout
//                (without --json the human message alone goes to stderr, as before).
function normalizeIssueResult(result, operation, { json = false, humanRender = null } = {}) {
  if (!result || typeof result !== 'object') {
    return result;
  }
  if (result.ok === undefined || result.success !== undefined) {
    return result;
  }

  if (result.ok === true) {
    const envelope = {
      ok: true,
      schema_version: result.schema_version,
      command: result.command,
      data: result.data ?? null,
      next_commands: result.next_commands ?? [],
    };
    // Check-after-write outcome (gate.issue_verify): additive keys, present only
    // when verification ran (verified may be null when the read-back failed).
    if (result.verified !== undefined) envelope.verified = result.verified;
    if (result.mismatches !== undefined) envelope.mismatches = result.mismatches;
    return {
      success: true,
      operation,
      // Human-first reads (a9bbd065): render the envelope as text unless the
      // caller asked for the contract (--json / FORGE_JSON=1). The envelope —
      // including verified/mismatches — is rendered, never dropped.
      output: humanRender
        ? renderIssueEnvelope(humanRender, envelope)
        : JSON.stringify(envelope, null, 2),
    };
  }

  const message = result.error?.message
    || result.message
    || `Issue ${operation} failed`;
  const normalized = { success: false, error: message };
  if (Number.isInteger(result.error?.exit_code)) {
    normalized.exitCode = result.error.exit_code;
  }
  if (json) {
    normalized.output = JSON.stringify({
      ok: false,
      schema_version: result.schema_version || ISSUE_COMMAND_ERROR_SCHEMA_VERSION,
      command: result.command,
      error: result.error,
      next_commands: result.next_commands ?? [],
    }, null, 2);
  }
  return normalized;
}

// `owns` is a read whose EXIT CODE encodes the ownership verdict: exit 0 when the
// resolving actor holds the live lease, non-zero otherwise. The kernel read itself
// succeeds (ok:true) whether or not the actor owns the lease — the verdict rides in
// `data.owned` — so the plain read normalizer (which maps every ok:true to success)
// would exit 0 on a NON-owned issue and let a worker mutate someone else's claim.
// This normalizer converts a `owned:false` verdict into a non-zero conflict result
// with a clear "you do not own the lease" message, while a genuine read failure (issue
// not found) still flows through normalizeIssueResult with its contract exit code. The
// `output` (the full envelope) is preserved even on the non-owned failure so `--json`
// consumers still receive `{ ok:true, data:{ owned:false, ... } }` on stdout.
function normalizeOwnsResult(result, operation, { json = false } = {}) {
  // Raw read failure (e.g. not found) or a non-contract shape → defer to the standard
  // normalizer so the contract exit code (notFound=3, ...) and error envelope survive.
  if (!result || typeof result !== 'object' || result.ok !== true) {
    return normalizeIssueResult(result, operation, { json });
  }

  const data = result.data && typeof result.data === 'object' ? result.data : {};
  const envelope = JSON.stringify({
    ok: true,
    schema_version: result.schema_version,
    command: result.command,
    data,
    next_commands: result.next_commands ?? [],
  }, null, 2);

  if (data.owned === true) {
    return { success: true, operation, output: envelope };
  }

  const heldBy = typeof data.claimed_by === 'string' && data.claimed_by ? data.claimed_by : 'nobody';
  const expiredNote = data.expired ? ' — the lease has expired and can be reclaimed' : '';
  const issueId = typeof data.id === 'string' && data.id ? data.id : '<issue>';
  const normalized = {
    success: false,
    operation,
    error: `You do not own the lease for ${issueId} (held by ${heldBy}${expiredNote}). `
      + 'You lost the race or the claim collapsed to a duplicate — reselect via '
      + '`forge issue ready --json` and re-claim before working.',
    exitCode: ISSUE_COMMAND_EXIT_CODES.conflict,
  };
  // On --json, surface the full ownership envelope on stdout (the bin printer emits
  // result.output before the stderr error) so machine consumers still get the verdict.
  if (json) {
    normalized.output = envelope;
  }
  return normalized;
}

// Split close args into the leading run of positional ids and the trailing flag
// tokens (everything from the first `-`-prefixed token onward). A flag value such
// as `done` in `--reason done` sits after a dash token, so it is correctly kept
// with the flags and never mistaken for an id.
function splitLeadingIds(args = []) {
  const flagIndex = args.findIndex(arg => typeof arg === 'string' && arg.startsWith('-'));
  if (flagIndex === -1) {
    return { ids: [...args], flags: [] };
  }
  return { ids: args.slice(0, flagIndex), flags: args.slice(flagIndex) };
}

// Kernel close fans out one runner call per id (the kernel close op closes a single
// id — the first positional), then aggregates the per-id outcomes into ONE
// forge.issue.v1 envelope (`mutationBatch` in the contract) — NEVER a bare array,
// which broke envelope parity for multi-id close. `ok` is true only when every id
// closed; per-id outcomes live in `data.results` and the contract `exit_code` of the
// first failure is surfaced as `exitCode` so the bin printer exits with the error
// class's code. KERNEL PATH ONLY: the Beads passthrough keeps its single
// `close id1 id2 ...` invocation.
async function runKernelBatchClose(runner, operation, ids, flags, projectRoot, opts, verifyEnabled = false) {
  const results = [];
  let allSucceeded = true;
  let firstFailureExit;
  for (const id of ids) {
    const raw = await runner(operation, [id, ...flags], projectRoot, opts);
    const succeeded = Boolean(raw && (raw.ok === true || raw.success === true));
    if (succeeded) {
      // Echo the CANONICAL id the kernel closed (raw.data.id) rather than the
      // caller's token — with git-style short-id support the broker may have
      // resolved a prefix to the full id, and the envelope should report the
      // resolved id the read-back verified.
      const closedId = (raw.data && typeof raw.data.id === 'string' && raw.data.id) ? raw.data.id : id;
      const entry = { id: closedId, ok: true };
      if (raw.data && Number.isInteger(raw.data.revision)) entry.revision = raw.data.revision;
      if (raw.data && Array.isArray(raw.data.newly_unblocked)) entry.newly_unblocked = raw.data.newly_unblocked;
      // Per-id check-after-write (gate.issue_verify): the batch path fans out one
      // close per id, so each id gets its own read-back and verified/mismatches.
      if (verifyEnabled && raw.ok === true) {
        const verification = await verifyIssueMutation('close', [id, ...flags], raw, runner, projectRoot, opts);
        entry.verified = verification.verified;
        if (Array.isArray(verification.mismatches) && verification.mismatches.length > 0) {
          entry.mismatches = verification.mismatches;
        }
        warnVerifyOutcome('close', id, verification);
      }
      results.push(entry);
      continue;
    }
    allSucceeded = false;
    const error = (raw && raw.error && typeof raw.error === 'object')
      ? raw.error
      : { message: (raw && (raw.error || raw.message)) || `Issue ${operation} failed for ${id}` };
    if (firstFailureExit === undefined && Number.isInteger(error.exit_code)) {
      firstFailureExit = error.exit_code;
    }
    results.push({ id, ok: false, error });
  }

  const envelope = {
    ok: allSucceeded,
    schema_version: ISSUE_COMMAND_SCHEMA_VERSION,
    command: 'issue.close',
    data: {
      results,
      count: results.length,
      closed: results.filter(entry => entry.ok).map(entry => entry.id),
    },
    next_commands: resolveNextCommands('issue.close'),
  };
  // Aggregate the per-id verification into envelope-level verified/mismatches:
  // false if any closed id mismatched, null if any read-back was inconclusive,
  // true only when every closed id verified clean.
  const verifiedEntries = results.filter(entry => entry.ok && entry.verified !== undefined);
  if (verifiedEntries.length > 0) {
    if (verifiedEntries.some(entry => entry.verified === false)) {
      envelope.verified = false;
      envelope.mismatches = verifiedEntries
        .filter(entry => Array.isArray(entry.mismatches))
        .flatMap(entry => entry.mismatches.map(mismatch => `${entry.id}: ${mismatch}`));
    } else if (verifiedEntries.some(entry => entry.verified === null)) {
      envelope.verified = null;
    } else {
      envelope.verified = true;
      envelope.mismatches = [];
    }
  }

  const normalized = {
    success: allSucceeded,
    operation,
    output: JSON.stringify(envelope, null, 2),
  };
  if (!allSucceeded) {
    const failed = results.filter(entry => !entry.ok).map(entry => entry.id);
    normalized.error = `Failed to close ${failed.length} of ${ids.length} issue(s): ${failed.join(', ')}`;
    normalized.exitCode = Number.isInteger(firstFailureExit)
      ? firstFailureExit
      : ISSUE_COMMAND_EXIT_CODES.internal;
  }
  return normalized;
}

async function runIssueSubcommand(subcommand, args, projectRoot, rawOpts = {}) {
  const spec = SUBCOMMANDS[subcommand];
  if (!spec) {
    return { success: false, error: `Unknown issue subcommand '${subcommand}'.\n\n${formatIssueHelp()}` };
  }

  // Backend-agnostic --help short-circuit: print the subcommand's usage and return
  // BEFORE resolving the backend or dispatching any operation. Without this, a help
  // request was forwarded to the active backend as an operation arg — absorbed
  // harmlessly by Beads (which swallowed --help), but broken under the Kernel default:
  // the plural path failed with a bare "Command failed" and the singular path
  // SILENTLY minted a junk issue (and could queue a GitHub projection). Help must
  // never touch a backend.
  if (normalizeArgs(args).some(arg => arg === '--help' || arg === '-h')) {
    return { success: true, output: `${spec.usage}\n\n${spec.description}` };
  }

  if (subcommand === 'dep') {
    const depError = validateDepArgs(args);
    if (depError) {
      return { success: false, error: depError.error };
    }
  }

  // `children` needs a leading <epic-id> positional; without it the kernel read
  // binds `undefined` and surfaces a raw SQLite error. Fail with usage instead.
  if (subcommand === 'children' && !normalizeArgs(args).some((arg) => !arg.startsWith('--'))) {
    return { success: false, error: `Usage: ${spec.usage}` };
  }

  // These subcommands bind their target issue from the first positional. Without it the
  // kernel path fabricates a random UUID and quarantines it ("invalid_claim_scope",
  // exit 0) — surface a clean usage error with a non-zero exit instead (kernel 842a8be7).
  const REQUIRES_LEADING_ID = new Set(['claim', 'release', 'comment', 'show', 'update', 'close', 'owns']);
  if (REQUIRES_LEADING_ID.has(subcommand) && !normalizeArgs(args).some((arg) => !arg.startsWith('--'))) {
    return { success: false, error: `Missing required argument <id>.\nUsage: ${spec.usage}`, exitCode: 6 };
  }

  const opts = withResolvedIssueBackend(projectRoot, rawOpts);

  // Both backends are reached through the same runIssueOperation seam. Naming the
  // injected local `runIssueOperation` keeps the dispatch a literal call to a binding
  // named `runIssueOperation` (the kernel-evidence gate is syntactic) while still
  // honoring an injected runner; the `kernelBroker: opts.kernelBroker` passthrough is
  // a runtime no-op (undefined under Beads) that documents the Kernel-capable surface.
  const runIssueOperation = opts.runIssueOperation || defaultRunIssueOperation;
  const operation = resolveIssueOperation(subcommand, args);
  const operationArgs = resolveOperationArgs(subcommand, args, opts);

  // Check-after-write (gate.issue_verify): resolved ONCE per invocation, kernel
  // path only. Reads and the Beads path never trigger a read-back.
  const verifyEnabled = VERIFIED_SUBCOMMANDS.has(subcommand)
    && shouldUseKernelBroker(opts)
    && isIssueVerifyEnabled(projectRoot, opts);

  // Kernel batch close: >1 leading positional id → one runner call per id,
  // aggregated. A single id falls through to the byte-identical single path.
  if (subcommand === 'close' && shouldUseKernelBroker(opts)) {
    const { ids, flags } = splitLeadingIds(operationArgs);
    if (ids.length > 1) {
      return runKernelBatchClose(runIssueOperation, operation, ids, flags, projectRoot, opts, verifyEnabled);
    }
  }

  const result = await runIssueOperation(
    operation,
    operationArgs,
    projectRoot,
    { ...opts, kernelBroker: opts.kernelBroker },
  );
  // Verify only a SUCCESSFUL kernel-contract mutation (ok:true, not a Beads
  // {success,output} shape). Warn-only: attaches verified/mismatches, never
  // changes the result's success or exit code.
  if (verifyEnabled && result && typeof result === 'object' && result.ok === true && result.success === undefined) {
    await applyIssueVerification(subcommand, operationArgs, result, runIssueOperation, projectRoot, opts);
  }
  // Contract output is opt-in for the human-first reads: an explicit --json flag
  // or FORGE_JSON=1 in the environment (for scripts that cannot alter argv).
  const jsonRequested = normalizeArgs(args).includes('--json')
    || (opts.env || process.env).FORGE_JSON === '1';
  // `owns` maps the ownership verdict (data.owned) to the process exit code; every
  // other subcommand uses the plain read/mutation normalization.
  if (subcommand === 'owns') {
    return normalizeOwnsResult(result, operation, { json: jsonRequested });
  }
  // Reads render human-first always; writes only when the caller is an interactive
  // terminal. The CLI entry (bin/forge.js) sets rawOpts.isInteractive from
  // process.stdout.isTTY; every other caller (scripts, tests, pipes) defaults to
  // non-interactive and keeps the machine-parseable JSON envelope (842a8be7).
  const interactive = rawOpts.isInteractive === true;
  const humanSubcommand = !jsonRequested
    && (HUMAN_RENDERED_SUBCOMMANDS.has(subcommand)
      || (interactive && HUMAN_RENDERED_WRITE_SUBCOMMANDS.has(subcommand)))
    ? subcommand
    : null;
  return normalizeIssueResult(result, operation, {
    json: jsonRequested,
    humanRender: humanSubcommand,
  });
}

// Build a registry command for a single issue subcommand (e.g. `forge claim`).
// Each routes through the shared runIssueSubcommand dispatch, so the backend
// abstraction owns all tracker selection and argument translation.
function createIssueSubcommand(subcommand) {
  const spec = SUBCOMMANDS[subcommand];
  if (!spec) {
    throw new Error(`Unknown issue subcommand '${subcommand}'`);
  }

  return {
    name: subcommand,
    description: spec.description,
    usage: spec.usage,
    flags: {},
    handler: async (args, _flags, projectRoot, opts = {}) =>
      runIssueSubcommand(subcommand, args, projectRoot, opts),
  };
}

function createIssueCommand() {
  return {
    name: 'issue',
    description: 'Manage issues through the Forge command surface',
    usage: 'forge issue <create|update|claim|release|close|show|list|ready|search|stats|dep> [...]',
    flags: {},
    handler: async (args, _flags, projectRoot, opts = {}) => {
      const [subcommand, ...rest] = normalizeArgs(args);

      if (!subcommand || subcommand === '--help' || subcommand === '-h') {
        return { success: true, output: formatIssueHelp() };
      }

      return runIssueSubcommand(subcommand, rest, projectRoot, opts);
    },
  };
}

module.exports = {
  SUBCOMMANDS,
  WRITE_SUBCOMMANDS,
  createIssueCommand,
  createIssueSubcommand,
  normalizeArgs,
  normalizeIssueResult,
  normalizeOwnsResult,
  resolveIssueOperation,
  resolveOperationArgs,
  runIssueSubcommand,
  withResolvedIssueBackend,
};
