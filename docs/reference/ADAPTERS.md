# Forge Adapters

Forge adapters normalize provider-specific surfaces behind Forge-owned contracts. The bundled adapters are reference implementations; Forge owns the contract and authority rules.

## Issue Adapters

Issue adapters expose issue tracking operations without making Beads, GitHub, Linear, Jira, or another provider the Forge API. The bundled reference adapter is `BeadsIssueAdapter`.

### Issue Contract

An issue adapter has `kind: "issue"` and implements these methods:

- `list(args, context)`: list issues from the provider/backend.
- `read(args, context)`: read a single issue. The Beads adapter maps this to `bd show`.
- `create(args, context)`: create an issue.
- `update(args, context)`: update issue fields.
- `close(args, context)`: close an issue.
- `comment(args, context)`: add an issue comment. The Beads adapter maps this to `bd comments add`.
- `mapStatus(status, context)`: map provider status into the requested target state.
- `decideAuthority(change, context)`: return the Forge authority decision for a field change.

### Issue Authority

GitHub owns shared team-visible fields: GitHub identity, URL, title, body, state, assignees, labels, milestone, and remote update timestamps.

Forge owns workflow and project context: Forge issue id, dependencies, parent/child links, workflow stages, acceptance criteria, progress notes, stage transitions, decisions, memory, outbound projection bookkeeping, and drift diagnostics.

Beads is the local/reference issue adapter and cache backend. Cache fields are derived and may be rebuilt. Unknown field paths are rejected until the authority model explicitly assigns ownership.

### Conflict Behavior

During pull/import, GitHub-owned remote fields overwrite local materialized shared fields and differences are recorded as drift diagnostics. Forge-owned fields are preserved locally and are not overwritten by GitHub import. Cache fields are rebuilt from the authoritative inputs.

### Issue Non-Scope

Issue adapters do not implement team dashboard UI, ReviewAdapter internals, GitHub Projects board automation, or full comment/discussion import. GitHub issue import must use the existing `lib/issue-sync/import-primitives.js` reconciliation path rather than a separate import contract.

## Review Adapters

Forge review adapters normalize provider-specific review feedback into one contract used by review tooling and offline fixture tests.

### Review Contract

A review adapter has `kind: "review"` and implements these methods:

- `fetchThreads(context)`: fetch provider review threads. Live adapters may use GitHub, REST, GraphQL, or a provider SDK.
- `parse(payload, options)`: normalize provider payloads into review thread objects.
- `reply(context)`: post a reply to a provider review comment.
- `resolve(context)`: mark a provider review thread resolved.
- `score(threads, context)`: score or classify parsed threads, usually by checking local commits or fixture data.

Normalized thread shape:

```js
{
  id: 'provider-thread-id',
  commentId: 123,
  file: 'lib/example.js',
  line: 42,
  body: 'review text',
  author: 'review-bot',
  isResolved: false,
  raw: {}
}
```

### Review Lifecycle

1. `fetchThreads` obtains raw provider data for live review runs.
2. `parse` filters and normalizes the provider data.
3. `score` decides whether local work appears to address each parsed thread.
4. `reply` posts the resolution explanation.
5. `resolve` closes the provider thread after a reply is recorded.

The bundled `GreptileReviewAdapter` is the compatibility reference. Existing Greptile shell commands keep their public command names while the shared matching behavior is routed through the adapter implementation.

### Review Scaffold

Create a local review adapter starter:

```bash
forge new adapter coderabbit --kind=review --template=greptile
```

The scaffold is written to:

```text
.forge/adapters/review/coderabbit.js
```

Only review adapters and the Greptile-shaped starter template are supported in this foundation PR.

### Review Fixture Replay

Run adapter parsing and scoring offline:

```bash
forge adapter test greptile --fixture=fixtures/greptile-review.json
```

Fixture shape:

```json
{
  "input": {
    "data": {
      "repository": {
        "pullRequest": {
          "reviewThreads": {
            "nodes": []
          }
        }
      }
    }
  },
  "expect": {
    "threads": 0
  }
}
```

Fixture replay must not make network calls. Live provider calls belong in `fetchThreads`, `reply`, and `resolve`.

### Review Non-Scope

Review adapters do not implement issue tracking, GitHub issue sync, or the full v3 reference adapter template catalog.
