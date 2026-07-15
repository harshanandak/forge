'use strict';

/**
 * PR-monitor sticky-comment upsert — race-safe, converges to EXACTLY ONE sticky
 * comment per PR even under a concurrent burst of workflow runs.
 *
 * Why this exists: the pr-monitor workflow deliberately has NO `concurrency:`
 * group. A per-PR group does not help — GitHub's queue replacement cancels the
 * previously-PENDING run in a group UNCONDITIONALLY (independent of
 * cancel-in-progress), and this workflow's triggers (check_suite:completed fires
 * ~10+ times per push, plus reviews/comments) burst hard, so a group left a trail
 * of CANCELLED runs that render as red/non-SUCCESS checks and tripped merge-gate
 * tooling (kernel issue 97e6a146). Dropping the group removes the cancellations,
 * but then two concurrent first-runs on a PR with no sticky yet would BOTH find
 * nothing and BOTH create one → duplicate sticky comments. This module closes
 * that race deterministically instead.
 *
 * Reconcile-to-one algorithm:
 *   1. List marker comments. If none, create one, then RE-LIST (a concurrent run
 *      may have created its own in the same burst).
 *   2. Pick the deterministic survivor: the LOWEST comment id (oldest). Every
 *      concurrent run picks the SAME survivor, so they never fight.
 *   3. Update the survivor with the latest body; delete every other marker
 *      comment. Deletes are idempotent (a 404 means a peer already removed it).
 *
 * A create that lands AFTER a run's re-list is self-healed by the next event:
 * every run reconciles to one, and events keep arriving, so the PR converges to a
 * single sticky comment.
 *
 * @module pr-monitor/upsert-sticky
 */

const { execFileSync } = require('node:child_process');

/** Ids of comments whose body carries the sticky marker. */
function markerCommentIds(comments, marker) {
  return (Array.isArray(comments) ? comments : [])
    .filter((comment) => typeof comment.body === 'string' && comment.body.includes(marker))
    .map((comment) => comment.id);
}

/** Ascending by numeric id, so the survivor (index 0) is the oldest comment. */
function sortIdsAscending(ids) {
  return [...ids].sort((left, right) => Number(left) - Number(right));
}

/**
 * Drive a client to exactly one sticky comment. `client` abstracts the GitHub
 * calls so the reconcile logic is unit-testable without the network:
 *   - list()        → array of { id, body }
 *   - create()      → create a new sticky comment (body supplied by the client)
 *   - update(id)    → overwrite comment `id` with the latest body
 *   - remove(id)    → delete comment `id` (must tolerate an already-deleted 404)
 *
 * @returns {Promise<{ survivor: (number|string|null), deleted: Array<number|string> }>}
 */
async function upsertStickyComment({ marker }, client) {
  let ids = markerCommentIds(await client.list(), marker);

  if (ids.length === 0) {
    await client.create();
    // Re-list: a concurrent run may have created its own sticky in this burst.
    ids = markerCommentIds(await client.list(), marker);
  }

  if (ids.length === 0) {
    // The just-created comment is not visible yet (eventual consistency); its
    // body is already correct, and the next event will reconcile if a peer raced.
    return { survivor: null, deleted: [] };
  }

  ids = sortIdsAscending(ids);
  const survivor = ids[0];
  await client.update(survivor);

  const deleted = [];
  for (const id of ids.slice(1)) {
    await client.remove(id);
    deleted.push(id);
  }

  return { survivor, deleted };
}

// Single choke point for the `gh` CLI, matching lib/commands/merge.js. `gh` is a
// hardcoded literal (never user input) and args are an array (no shell), so the
// S4036 PATH-search finding is a false positive in this developer-tool context;
// one annotation here covers every call site.
function runGh(args, options = {}) {
  return execFileSync('gh', args, options); // NOSONAR S4036 - hardcoded CLI (gh), args array (no shell), developer-tool context
}

/**
 * GitHub-backed client (shells to `gh api`, like lib/pr-monitor/gather.js). Not
 * unit-tested — the reconcile logic above is. create/update both send the same
 * pre-rendered payload file the render step wrote, so the body is identical.
 */
function ghStickyClient({ repo, pr, payloadFile }) {
  return {
    async list() {
      const out = runGh(
        ['api', `repos/${repo}/issues/${pr}/comments`, '--paginate'],
        { encoding: 'utf8' },
      );
      return out.trim() ? JSON.parse(out) : [];
    },
    async create() {
      runGh(
        ['api', '-X', 'POST', `repos/${repo}/issues/${pr}/comments`, '--input', payloadFile],
        { stdio: 'ignore' },
      );
    },
    async update(id) {
      runGh(
        ['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${id}`, '--input', payloadFile],
        { stdio: 'ignore' },
      );
    },
    async remove(id) {
      try {
        runGh(
          ['api', '-X', 'DELETE', `repos/${repo}/issues/comments/${id}`],
          { stdio: 'ignore' },
        );
      } catch {
        // Already gone (a concurrent run deleted it first) — the goal state holds.
      }
    },
  };
}

async function main() {
  const repo = process.env.GH_REPO;
  const pr = process.env.PR;
  const payloadFile = process.env.STICKY_PAYLOAD_FILE || 'monitor-payload.json';
  const { STICKY_MARKER } = require('./render-sticky');

  const client = ghStickyClient({ repo, pr, payloadFile });
  const { survivor, deleted } = await upsertStickyComment({ marker: STICKY_MARKER }, client);
  const survivorLabel = survivor === null ? 'created (not yet visible)' : survivor;
  console.log(`Sticky comment reconciled to one: survivor=${survivorLabel}, deleted=${deleted.length}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  upsertStickyComment,
  markerCommentIds,
  sortIdsAscending,
  ghStickyClient,
};
