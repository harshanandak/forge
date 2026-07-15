# `forge serve` — security model

Issue: `8eabd92c-a6ef-4635-891d-7a6c6f4bb07e` (serve hardening) · doc-drift fix
`d3c47131-a675-4b18-9210-6ae6702e4904` (B5a). Companion to
[design.md](design.md); this file is the authoritative security ground-truth for
`lib/commands/serve.js`.

## Threat model

`forge serve` is a **local, loopback-only** companion that turns the static
dashboard into an interactive one. It has **no accounts, no cloud, no daemon**;
the process and its per-run token die together. The realistic adversaries are:

1. **A remote / cross-origin web page** trying to reach the server or forge a
   write (drive-by CSRF, DNS-rebinding).
2. **Another local user or process on a shared machine** trying to read the
   snapshot (issue/message data) or the token, or to squat the port.
3. **A local actor tampering with the after-the-fact record** of what the server
   did (editing/deleting journal history to hide a mutation).

It is explicitly **not** a multi-tenant auth boundary. On a single-user machine
the loopback + token fence is the whole story; the controls below raise the
floor on a *shared* box without pretending to be authentication.

## Endpoint authentication matrix

The per-run token is `crypto.randomBytes(32)`, minted at startup and compared in
constant time (`crypto.timingSafeEqual`). The **dashboard client** keeps it in
the page's URL **fragment** (`#token=…`) and attaches it via the `X-Forge-Token`
header — the browser never puts a fragment in a `Referer`, so a foreign origin
cannot learn it that way. Note this describes client behavior: `readRequestToken`
*also* accepts a `?token=` query fallback, so a token CAN appear in a request
line (and thus a server/proxy access log) if a client chooses to send it there.
Every gated request must also pass the loopback Host/Origin fence.

| Endpoint | Method | Loopback fence | Token required | Rationale |
|----------|--------|:--------------:|:--------------:|-----------|
| `/health` | GET | yes | **no** | Capability probe only — flips the page SNAPSHOT→LIVE; discloses nothing. |
| `/data.json` | GET | yes | **yes** | Carries the FULL issue/message snapshot — a real disclosure. Gated by the SAME fence as the write path (loopback + constant-time token). See `serve.js` `handleRequest` (`/data.json` branch). |
| `/api/mutation` | POST | yes | **yes** | The write path. Body `{ token, verb, args }`; wrong/missing token → 403. |
| `/*` static assets | GET | yes (bind) | no | Inert dashboard files (HTML/JS/CSS) under a traversal-safe path resolver. |

> **Corrected (B5a).** An earlier draft of this model listed `GET /data.json`
> reads as an **open unauthenticated gap**. That is stale: the shipped code
> token-gates `/data.json` with the same loopback + constant-time-token fence as
> `POST /api/mutation` (`lib/commands/serve.js`, the `/data.json` branch of
> `handleRequest`; regression-tested in `test/commands/serve.test.js`). The
> snapshot is **not** world-readable over the socket.

## Local actor / origin is advisory, never authenticated

The mutation journal records an `actor: "local"` and the request `origin`. **This
is advisory coordination metadata, not an authenticated identity.** A loopback
request is authorized solely by possession of the per-run token; the server does
no OS-level peer-credential check (SO_PEERCRED / named-pipe SID) and cannot prove
*which* local user or process sent a request. Treat `actor`/`origin` as a hint
for human coordination on a dev box — never as tamper-proof provenance, and never
as an authorization input. This keeps the model honest and forward-compatible
with the hosted/sync tier, where the **kernel is the authority** and real
identity is established server-side, not inferred from a local socket.

## The three ALWAYS controls (`lib/commands/_serve-security.js`)

Cheap, always-on hardening for the shared-machine case. State lives under
`.forge/serve/` (owner-only) so the shared `.forge/` config dir is never
re-chmod'd out from under other tooling.

### 1. `serve.lock` single-instance guard

`acquireLock()` exclusively creates `.forge/serve/serve.lock` (`open(..,'wx')`)
holding `{ pid, port, startedAt }`. A second `forge serve` for the same project
finds a **live** holder and is refused (prevents a rogue second server / port
squat). A **stale** lock (holder PID no longer alive, via `process.kill(pid,0)`)
is reclaimed. `releaseLock()` deletes the lock only if it is ours (matching PID),
wired to `SIGINT`/`SIGTERM`/`exit` so the lock is released cleanly. Reclaim is
best-effort and not hardened against a simultaneous double-reclaim race —
acceptable for a loopback dev-server guard.

### 2. `securePath()` — owner-only perms at creation + startup audit

Lock and journal files are created `0o600` and their directory `0o700` **at
creation** (mode on `open`/`mkdir`, re-`chmod`'d to be certain). At startup the
server **audits** those paths and warns loudly if any is group/other-readable.

**Windows honesty:** `chmod` on Windows only toggles the read-only bit — it does
**not** change NTFS ACLs — and `fs.stat().mode` does not reflect ACLs. So on
Windows `securePath()` is a best-effort no-op (`applied:false`) and the audit
does **not** raise false alarms from meaningless mode bits; it prints a one-line
caveat recommending a single-user profile instead. On POSIX the `0o600`/`0o700`
bits are real and test-asserted.

### 3. Hash-chained tamper-evident journal

Every **token-valid** mutation attempt (whether the handler then accepts **or**
rejects it) is appended to `.forge/serve/journal.jsonl`. (A request that fails
the loopback/token fence gets a `403` and returns *before* the append, so failed
auth probes are not journaled — see the filed follow-up on journaling those,
which needs its own flood-control design.) Each record embeds `prevHash` and
carries `hash = sha256(prevHash ‖ JSON(record-without-hash))`, genesis = 64
zeros. `verifyJournal()` re-walks the chain from genesis; **editing** a past
record breaks its `hash`, and **deleting a non-tail record** breaks the following
record's `prevHash` — either returns `{ ok:false, brokenAt, reason }`.
**Tail truncation** (dropping the most recent record(s)) leaves a still-valid
prefix and is **only** detectable with an externally anchored head hash (a filed
follow-up); the built-in check does not catch it. `verifyJournal()` is run at
`forge serve` **startup** (loud warn on failure, never blocking), so the control
actually executes on every serve. This makes silent after-the-fact *edits* and
*mid-chain deletions* of serve's action history detectable. (It is integrity, not
secrecy or non-repudiation: a local actor who can rewrite the whole file can also
recompute a fresh valid chain — the guarantee is that *partial* tampering that
leaves later records intact is always caught.)

## Forward compatibility (hosted / sync tier)

These controls are strictly local and additive. They do not introduce a second
authority: the kernel/broker remains the sole mutation authority (the server is a
dumb in-process relay). When the hosted/sync tier lands, real identity and
authenticated provenance are established server-side by the kernel; the local
journal remains a useful local integrity record but never claims to be that
authority.

## Test coverage

- `test/commands/_serve-security.test.js` — lock (first/blocked/stale-reclaim/
  release), perms-at-creation + audit (POSIX asserts real mode bits; Windows
  asserts best-effort/no-throw), hash-chain append + tamper/delete detection.
- `test/commands/serve.test.js` — `/data.json` token gate (regression for B5a),
  every token-valid mutation journaled + tamper-detected end-to-end, and the
  startup `verifyJournalAtStartup` check (warns on a tampered journal, silent on
  an intact/absent one).
