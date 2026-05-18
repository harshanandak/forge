# Forge Review Adapters

Forge review adapters normalize provider-specific review feedback into one contract used by review tooling and offline fixture tests.

## Contract

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

## Lifecycle

1. `fetchThreads` obtains raw provider data for live review runs.
2. `parse` filters and normalizes the provider data.
3. `score` decides whether local work appears to address each parsed thread.
4. `reply` posts the resolution explanation.
5. `resolve` closes the provider thread after a reply is recorded.

The bundled `GreptileReviewAdapter` is the compatibility reference. Existing Greptile shell commands keep their public command names while the shared matching behavior is routed through the adapter implementation.

## Scaffold

Create a local review adapter starter:

```bash
forge new adapter coderabbit --kind=review --template=greptile
```

The scaffold is written to:

```text
.forge/adapters/review/coderabbit.js
```

Only review adapters and the Greptile-shaped starter template are supported in this foundation PR.

## Fixture Replay

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

## Non-Scope

This adapter foundation does not implement `IssueAdapter`, GitHub issue sync, or the full v3 reference adapter template catalog.
