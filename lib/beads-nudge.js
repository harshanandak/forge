'use strict';

const { resolveIssueBackend } = require('./issue-backend');
const { detectBeadsJsonlSource } = require('./beads-detect');

// Unmigrated legacy-store nudge (kernel issue a5399f3d — upgrade-safety
// 0.0.10 -> current).
//
// The 0.0.10 -> current upgrade flipped the DEFAULT issue backend to the Kernel,
// but the legacy -> kernel migration fires ONLY from `forge setup`/`init`, never
// lazily on the issue path. So a user who runs `bun update` then `forge list` /
// `forge ready` reads an EMPTY kernel and their 0.0.10 issues APPEAR GONE — the
// data is safe on disk, just invisible, with no hint. This helper closes that
// footgun: when the resolved backend is the (default) Kernel, a read comes back
// empty, AND a legacy jsonl store still exists, it prints a one-time guided hint.
//
// It lives in this NEUTRAL module (not lib/commands/_issue.js) on purpose: the
// message text names the retired backend + its `.beads` store, and _issue.js is a
// D20 release-readiness hot-path surface that must stay free of those tokens (the
// bd-call-site audit + kernel-backed checks scan it). Keeping the strings here
// lets the hot path call a token-free helper.
//
// Best-effort and non-blocking: it NEVER throws and never alters the read result.
// Fires at most once per project root per process to avoid spam.
const NUDGE_READS = new Set(['list', 'ready']);
const warnedRoots = new Set();

// A kernel read looks empty when its contract data carries no issues. Handles the
// issue.list/issue.ready shape ({ issues, count }) plus a bare array / null, and
// is deliberately conservative: anything it cannot confirm as empty is treated as
// NON-empty so a user with real kernel issues is never nagged.
function kernelReadLooksEmpty(result) {
  if (!result || typeof result !== 'object' || result.ok !== true) {
    return false;
  }
  const data = result.data;
  if (data === null || data === undefined) {
    return true;
  }
  if (Array.isArray(data)) {
    return data.length === 0;
  }
  if (Array.isArray(data.issues)) {
    return data.issues.length === 0;
  }
  if (Array.isArray(data.items)) {
    return data.items.length === 0;
  }
  if (typeof data.count === 'number') {
    return data.count === 0;
  }
  return false;
}

function maybeWarnUnmigratedBeads(subcommand, result, projectRoot, rawOpts = {}) {
  try {
    if (!NUDGE_READS.has(subcommand) || !projectRoot) {
      return;
    }
    if (warnedRoots.has(projectRoot)) {
      return;
    }
    const env = rawOpts.env || process.env;
    // Resolve the EFFECTIVE backend (default kernel). An explicit opt-in to the
    // retired backend means the user chose it deliberately — nothing to nudge.
    const backend = resolveIssueBackend({ deps: rawOpts, env, projectRoot, warn: () => {} });
    if (backend !== 'kernel' || !kernelReadLooksEmpty(result)) {
      return;
    }
    if (!detectBeadsJsonlSource(projectRoot)) {
      return;
    }
    warnedRoots.add(projectRoot);
    console.error(
      '\n[forge] Legacy issue data detected (.beads/*.jsonl) but the Kernel issue store is empty.\n'
      + 'Forge now defaults to the Kernel backend (breaking change since 0.0.10). Your legacy\n'
      + 'issues are safe on disk but will not appear until migrated. To migrate:\n'
      + '  forge migrate --from beads   # import your legacy issues into the Kernel\n'
      + '  forge setup                  # (re)wire hooks + provision the Kernel store\n'
      + 'Prefer to stay on the legacy backend? Set `issueBackend: beads` in .forge/config.yaml '
      + '(or FORGE_ISSUE_BACKEND=beads).\n',
    );
  } catch (_err) {
    /* the nudge is a best-effort hint; it must never break a read */ // NOSONAR S2486
  }
}

module.exports = {
  maybeWarnUnmigratedBeads,
  kernelReadLooksEmpty,
};
