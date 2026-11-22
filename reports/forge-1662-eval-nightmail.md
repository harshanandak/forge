# Nightmail source evaluation

Commit: `cc7e16bbd9d19c4475041dbbe1f57e84a2a66136`, shallow clone of default branch `dev`. Source references below are paths and line ranges at that commit. Evidence level: code inspection, not an executed or live-system test. Judgements and experiment targets are ours.

## Verdict in plain words

- Nightmail is email infrastructure with agent inboxes, not a ready-made human question and answer service.
- Its inbox retains mail and returns a position marker, a useful model for finding messages after a disconnection.
- Its waiting request hides repeated checks from the agent, but the server still checks the database every second.
- Mail that exceeds an inbox limit is held instead of discarded, and ordinary waiting does not show it.
- Accounts, workspace roles, and restricted inbox keys offer useful access-control patterns.
- A sender's email authentication result does not by itself prove which individual answered a question.
- Its event and delivery records offer patterns for retrying and tracking notifications, with duplicates possible.
- Slack delivery exists, but the inspected code does not establish a single updating phone notification or the requested reminder schedule.
- Its routing language runs as limited instructions, with endpoint credentials kept outside the rule interpreter.
- Its production configuration uses external PostgreSQL and Amazon SES alongside Cloudflare services, so it does not meet the zero-external-service requirement as deployed.
- Reuse the ideas of scoped access, stable cursors, durable delivery records, and secret isolation; build an ask-specific record and answer authorization.
- No project-wide reuse license was found; obtain permission before copying code, and do not treat a young repository as proven dependable.

## Need by need

| Need | Source evidence and judgement | Verdict |
| --- | --- | --- |
| N1 | Inbox create and message schemas validate email data (`api/src/inboxes.ts:29-87`); an ask-specific fixed record is not established by the inspected paths. Model a dedicated validated ask. | adopt the pattern |
| N2 | Cursors and oldest-first commit order (`api/src/inboxes.ts:274-299`); client waits in 30-second calls (`sdk/src/inbox.ts:20-44`); server reads again every second (`api/src/auth.ts:78-85`). Keep cursor semantics, replace server polling. | adopt the pattern |
| N3 | Verified invitation acceptance and per-workspace roles (`api/src/workspaces.ts:27-34,103-103,207-207`); mailbox authentication verdicts (`api/src/inboxes.ts:78-87`). Ask-level eligibility, person-to-person handoff and verified answer identity are not established. | adopt the pattern |
| N4 | Endpoint delivery records and retry state (`api/src/mailbox-events.ts:66-82`); no inspected implementation establishes per-person phone update or 0/5/15/30 schedule. | not useful |
| N5 | Durable database records and event jobs (`api/src/mailbox-events.ts:18-47,66-82`); this supports a server-held message pattern, subject to service availability and retention. | adopt the pattern |
| N6 | Worker production bindings include Hyperdrive, R2, Queues, and SES (`api/wrangler.prod.jsonc:66-71,95-122`); actual free-tier cost and quotas were not measured. This deployment is not self-contained in Workers and DOs. | not useful |
| N7 | Workspace roles (`api/src/mcp.ts:83-96`) and Slack endpoints (`api/src/endpoints.ts:1-5,40-54`) are useful pieces; neither proves per-person ask delivery state. | adopt the pattern |
| N8 | GitHub API license is null; search found only third-party font and vendor licenses and no package.json license fields. Repo created 2026-11-09, with 37 stars and 8 forks at lookup. Reuse permission and production maturity are unproven. | not useful |

## Under the hood

1. **Identity and sign-in.** Read `api/src/account-login.ts:32-49,70-72,92-117,157-177,193-220`, `api/src/workspaces.ts:27-34,89-103,200-207`, `api/src/oidc-resource.ts:66-84`. Dashboard sign-in uses OIDC discovery, state, nonce and PKCE, checks the returned token, and stores hashed session tokens. Workspace invitations require the recipient's verified email; roles include owner, admin and member. Workspace access intersects grant and membership. This is account-level identity, not proof that an email sender is a particular person.

2. **API keys.** Read `api/src/auth.ts:87-100,125-172,211-238`, `api/src/inbox-connection.ts:13-25`, `api/src/mcp.ts:103-129,154-162,329-341`. Keys are looked up by digest and checked for expiration, revocation, workspace and permissions. An inbox connection stores selected inbox IDs and read or read/send permission. MCP restricts available operations and dispatches using scoped access; waiting rechecks changed credentials. The route's query also filters by visible inbox (`api/src/inboxes.ts:292-299`).

3. **Hosted MCP.** Read `api/src/mcp-auth.ts:60-63`, `api/src/oidc-resource.ts:19-38,159-191,200-224`, `api/src/mcp.ts:198-206,329-341`, `docs/mcp.md:19-22`. The resource publishes OAuth protected-resource metadata and an authentication challenge pointing to an external account issuer. JWT access tokens are validated against issuer discovery, keys, audience and scopes; every call resolves a workspace and checks current membership, role and token permissions. Docs say OpenCode uses a client metadata document while other clients register with the account service. **Partial:** the issuer's actual client-registration and consent implementation is outside the inspected repository; its correctness is unverified.

4. **Inbox wait.** Read `api/src/inboxes.ts:29-43,70-87,274-299`, `api/src/auth.ts:74-100`, `sdk/src/inbox.ts:8-44`. An HTTP request waits at most 30 seconds, repeatedly reading the database at one-second intervals and stopping on timeout or abort. The SDK repeats these requests for up to two minutes by default, passes `after`, and returns a message cursor; it does not demonstrate automatic recovery from every network error. The API orders by inbox sequence in commit order. Quota or expiry causes stored held mail, excluded from waited results and available via `include=held`. The caller must persist the cursor and reconnect; replay and retention should be tested.

5. **Events and webhooks.** Read `api/src/mailbox-events.ts:7-11,18-47,66-105`, `api/src/inbound-webhook.ts:222-236`, `api/src/endpoint-delivery.ts:36-72`, `api/src/ritual-retry.ts:10-44`, `api/src/worker.ts:251-294`. Events include received, held, delivered, bounced and thread changes. Database event and delivery/job records form the durable work source; queue wakes trigger draining. Subscriptions are at least once with a stable Webhook-Id. Routed rule webhooks also receive a stable delivery Idempotency-Key. Exponential retry starts at 15 seconds, capped at 12 hours with jitter and Retry-After support; uncertain timeouts are not retried by default for Slack, Discord or webhook, unlike deduplicated forwarding. Inspect receiver idempotency; do not assume exactly once.

6. **Rituals, now rules.** Read `api/src/ritual-engine.ts:1-8,48-87,136-165,183-201,379-391,407-429,548-563`, `api/src/ritual-pipeline.ts:363-383`, `api/src/endpoints.ts:1-5,40-54,76-87`, `api/src/endpoint-delivery.ts:36-46`. JavaScript-like source is compiled to serializable instructions interpreted by a small VM, not executed as arbitrary JavaScript. Loops, nested functions, async and generators are rejected; compile work, tokens, regex states, steps, output and actions are bounded. A rule emits named intents; separate endpoint delivery resolves the stored destination and secrets. Slack/Discord targets are encrypted and shown masked, with webhook secrets/headers handled by endpoint code. This is a pattern, not a proven security audit.

7. **Omens, now decisions.** Read `api/src/ritual-pipeline.ts:32-51,119-119,234-265,292-298,337-351`, `api/src/ritual-engine.ts:342-354`, `api/src/screen.ts:367-385`. Domains or routes opt in to sending evidence for AI decisions. Questions are batched into a single Jev request with a 1.5-second deadline; results must have the expected numeric 0-to-1 answers. Failure produces no scores, so a configured fallback applies, defaulting to zero or false; `defer` schedules another attempt up to a 30-minute receipt deadline. The external model and key are dependencies. Inference: this is classification, not a human answer mechanism.

8. **Threading and sender authentication.** Read `api/src/mailbox-ingest-store.ts:8-16`, `api/src/mailbox-ingest.ts:72-87,585-586,620-627`, `api/migrations/354_receiving_headroom.sql:184-205,244-245`, `api/src/inboxes.ts:78-87,155-168`, `api/src/routing-match.ts:64-94`, `api/src/inbound-threads.ts:191-196,259-265`. Incoming In-Reply-To, reversed References and Message-ID supply candidate IDs; the SQL finds an existing workspace thread or creates one, including a provider-ID lookup. SPF, DKIM and DMARC verdicts are stored and exposed; configured DMARC requirements can hold or skip delivery. **Partial:** the inspected paths do not establish an end-to-end mapping from a reply to the particular agent that originated it, nor person-level identity; email headers and domain authentication are insufficient proof of that mapping.

9. **Storage and deployment.** Read `api/wrangler.prod.jsonc:66-71,95-122`, `api/src/worker.ts:80-107,251-294`, `api/src/dispatcher-do.ts:24-36,78-125,132-139`. Workers handle requests and queue/scheduled processing; Hyperdrive connects to PostgreSQL, R2 stores objects, and live SES is enabled. A dispatcher Durable Object per account/region/shard uses alarms and retains pacing state; PostgreSQL rows are the dispatch queue. Cloudflare Queues provide wake hints and feedback paths. These dependencies do not establish zero cost or free-allocation capacity; other services and actual bills were not audited.

10. **Tests and CI.** Read `.github/workflows/ci.yml:43-49,163-202`, `.github/workflows/nightly.yml:3-6,38-80`, `.github/workflows/deploy.yml:405-411,492-504`, `api/scripts/e2e.ts:1-7,39-47`. CI specifies type/build checks, Rust lint/unit tests and sharded acceptance tests with PostgreSQL and object storage. Nightly repeats acceptance to find flakes. Deployment defines a live dev E2E using the public client and a fixture. These are test designs, not evidence that they passed at this SHA; none was run for this audit.

## Proof we could run

1. **Resume:** send 10,000 numbered asks while disconnecting clients at random points and restarting them from saved cursors. Measure missing, duplicated and reordered records. Target zero missing or reordered; any gap after acknowledged cursor persistence changes the design.
2. **Waiting cost:** compare 1,000 idle agents for one hour using event-driven DO wait versus one-second database polling. Measure requests, CPU, storage operations, wake latency and free-allocation use. Target zero periodic reads and p95 wake under two seconds; exceed the allocation or lose wakeups and revisit the transport.
3. **Reminders and authorization:** use 100 asks across two people; simulate delivery retries, handoffs, offline phones and a process restart. Measure notification IDs, reminder times, duplicate visible notifications and unauthorized accepted answers. Target one notification per recipient, reminders within one minute of 0/5/15/30, zero unauthorized answers. Any accepted unauthorized answer blocks release.
4. **Outbox:** inject network timeouts before and after a fake Slack receiver accepts 1,000 deliveries. Measure missing and duplicate messages and recovery time. Target no missing durable intents and record ambiguous outcomes; if the receiver cannot deduplicate or update reliably, make that limitation visible and choose another delivery contract.

## Limits

- No dependency was installed, no repository script was run, and no live behavior, CI result, cost, or license permission was verified. Code inspection is evidence of intended behavior, not production proof.
- Search for licenses covered tracked clone paths and all package.json files. GitHub reported `license: null`; the MIT vendor license at `api/src/email-preview/vendor/caniemail/LICENSE:1` and font licenses apply to their own materials, not demonstrably to the project. Obtain an explicit project license or permission.
- GitHub API reported default branch `dev`, created 2026-11-09, 37 stars, 8 forks and 33 open issues at lookup; these are time-sensitive signals, not reliability measures.
- PowerShell wildcard arguments to initial `rg` searches failed on Windows; later directory-and-glob searches supplied the evidence above. The clone was treated as untrusted data.
- MCP issuer registration and consent internals, and an agent-specific reply attribution chain, were not verified; items 3 and 8 are partial. Search results cannot prove a feature absent. No assertion is made that every code path was read.

COVERED 8 OF 10