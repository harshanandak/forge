# `forge serve` — tamper-resistant + encrypted-in-transit security model (DESIGN, not implemented)

Requirement (verbatim): "no one should be able to interrupt the serve with any access to the
terminal as that would affect our cases a lot; we need a clean encrypted system to make sure
messages are not viewable while they are transferred."

Hard constraints preserved throughout: **zero-cost, agent-agnostic, local-first**. Nothing here
adds accounts, cloud dependencies, paid certs, or agent-specific hooks.

## 0. Verified current state (ground truth)

| Control | Where | Status |
|---|---|---|
| Loopback-only bind | `lib/commands/serve.js:434` (`server.listen(port, '127.0.0.1')`) | ✅ |
| Per-run 32-byte token, minted in-process (never argv/env) | `serve.js:97-99`, `serve.js:444` | ✅ |
| Token required on every POST, constant-time compare | `serve.js:101-104`, `serve.js:336-338` | ✅ |
| Non-loopback Host/Origin rejected on POST | `serve.js:114-127`, `serve.js:328` | ✅ |
| Token delivered via URL **fragment** (never sent to server / Referer) | `serve.js:422` | ✅ |
| Path-traversal-safe static root | `serve.js:282-305` | ✅ |
| **Reads unauthenticated** (`/data.json`, `/health`, static) | `serve.js:348-360`; design.md:72 | ⚠️ gap (see A1) |
| No single-instance lock for serve | — (journal has one: `lib/pr-monitor/journal.js:211-240`) | ⚠️ gap |
| Journal NDJSON written with default perms | `journal.js:114-118` (`appendFileSync`, no mode) | ⚠️ gap |
| Kernel DB `<gitCommonDir>/forge/kernel.sqlite` | `lib/kernel/cli-broker-factory.js:32-37` | default perms |
| Plaintext JSONL projections **committed to git** | `.forge/kernel/{issues,comments,dependencies}.jsonl` | by design (local-first) |

Honesty notes: `lib/inbox.js` **does not exist** in the repo (no `inbox` hits anywhere in `lib/`);
"inbox" below means the kernel comments/messages store + its JSONL projection. Kernel issue
`7c813e9d` was **not found** in the available `.forge/kernel` projections of this checkout; the
online tier is grounded instead on the Tier-1/Tier-2 seam in
`docs/work/2026-07-13-forge-serve/design.md:98-102` (multi-project registry, Phase-2
authoritative server = fast-follow).

## 1. Threat model — three tiers, proportionate

Key OS facts that drive proportionality (and keep us from over-engineering):

- **Loopback traffic cannot be sniffed without admin/root.** Linux: capturing `lo` needs
  root/CAP_NET_RAW. Windows: loopback capture needs an admin-installed driver (npcap). A
  non-privileged *other* user cannot see 127.0.0.1 packets. Loopback bytes never leave the kernel.
- **A different (non-admin) user cannot kill or ptrace your process.** Same-user or admin can —
  always, on every OS. No userland design changes that.
- Therefore: on-machine "encryption in transit" is mostly **already provided by the OS boundary**;
  the real local exposures are (a) unauthenticated reads on the TCP port, (b) files on disk,
  (c) port squatting after a crash.

### Tier table (tier × attack × in-scope)

| # | Attack | (a) Single-user local | (b) Shared machine (other non-admin user/process) | (c) Online/hosted |
|---|---|---|---|---|
| T1 | Read messages via unauthenticated `GET /data.json` on 127.0.0.1 | Out (attacker = you) | **IN — works today**; any local user can `GET` the full snapshot | IN (must be authed) |
| T2 | Steal token from `ps`/argv/env | Out | IN — **already defeated** (token never in argv/env, `serve.js:444`) | IN |
| T3 | Steal token from terminal scrollback / shell history (printed URL, `serve.js:422-425`) | Accepted (it's your terminal) | Out for other users (can't read your terminal); IN if screen shared/unlocked | n/a (no printed token) |
| T4 | Sniff loopback traffic | Out (needs admin = you) | **Out for non-admin**; admin attacker is out of scope (owns the machine) | **IN — network attacker; TLS mandatory** |
| T5 | Kill your serve process | You only | **Out** — OS blocks cross-user kill; admin out of scope | IN (platform concern) |
| T6 | Port-squat / kill-and-replace server to impersonate (fake dashboard, harvest typed message bodies) | Out | **IN** — after a crash any user can bind 8730 and serve a look-alike | IN (TLS + cert identity solves) |
| T7 | Read kernel.sqlite / JSONL projections / pr-monitor journal on disk | Out | **IN** if repo dir is group/world-readable (default umask often allows) | IN (server-side at-rest) |
| T8 | Tamper journal/inbox files (forge or delete messages) | Out | IN if writable by others; tamper-*evidence* wanted | IN |
| T9 | Second `forge serve` instance corrupting state / stealing the flow | IN (accidental self-interference) | IN | IN |
| T10 | CSRF / malicious website driving mutations | IN — **already defeated** (fragment token + Origin fence, `serve.js:114-127,336`) | IN — same defense | IN |
| T11 | Replay of an observed mutation | Out (observer = admin) | Effectively out locally (T4); cheap MAC+nonce anyway | IN — TLS + nonce |

Out of scope at every tier, stated honestly: an attacker running **as your own user** or as
**admin/root**. They can read process memory, keylog, replace `node`, edit `web/dashboard/*.js`
before it's served (`serve.js:319`), or DPAPI-decrypt anything your user encrypted. No userland
design defends against them; pretending otherwise would be theater.

## 2. Server integrity / anti-hijack

**A. Cheap-and-always (ship in serve MVP hardening):**

1. **Token-gate reads too (fix T1).** Require the token on `GET /data.json` (header
   `X-Forge-Token`, attached by `app.js`, which already holds it from `location.hash`).
   `/health` may stay open (it leaks nothing but existence); static assets stay open (no data in
   them). One-line-class change, closes the only *working* shared-machine read today.
2. **Single-instance lock (fix T9).** `.forge/serve.lock` reusing the proven
   crash-recoverable lock-dir pattern of `journal.js:211-240` (atomic `mkdirSync`, owner
   `pid:timestamp`, staleness steal, heartbeat). Record `pid + port + tokenFingerprint(=first 8
   hex of SHA-256(token))`. A second `forge serve` refuses with "already running on :8730 (pid N)".
   Also makes replacement *detectable*: the lock owner must match the listener.
3. **Fail-loud on bind failure.** `EADDRINUSE` (today it rejects at `serve.js:432-435`) should
   print an explicit warning naming the squatting possibility, not just an error string.
4. **Keep token out of argv/env forever** (already true) and offer `--quiet-token`: print the URL
   without the fragment and place it on the clipboard / open the browser directly (`serve.js:427`),
   so the token never lands in scrollback (mitigates T3 for screen-share cases).
5. **Restrictive perms at creation** on everything under `.forge/` that serve/monitor writes:
   journal NDJSON + snapshot + pid files (`journal.js:114-118,150-154,243-245`) and the serve lock
   → `mode: 0o600` (files) / `0o700` (dirs) on POSIX; on Windows see §5. Plus a startup
   **perm audit**: if `.forge/`, the kernel DB dir, or the journal is group/world-readable, print a
   one-line warning with the exact `chmod`/`icacls` fix. Warn-don't-block (local-first).
6. **Graceful, exclusive shutdown.** Keep SIGINT/SIGTERM close (`serve.js:413-417`) and release
   the lock in the same handler, so the lock is only ever free when the port is genuinely free —
   shrinking the squat window of T6 to real crashes.

**B. Tier-gated (shared machine):**

7. **Server identity pinning (fix T6) — without TLS.** At startup mint a second per-run secret
   (`serverId`), put its fingerprint in the fragment alongside the token
   (`#token=…&sid=…`). `app.js` challenges `/health` with a random nonce; server answers
   `HMAC(serverId, nonce)`. A post-crash impostor can't answer; the page shows a hard red
   "SERVER IDENTITY CHANGED — do not type" state instead of silently rendering. Cheap (Node
   `crypto` only), no cert store, works in any browser. This is the honest anti-kill-and-replace
   control, because a *different* user could never kill the real server anyway (T5) — the exposure
   is only ever *after* a crash/exit.
8. **UNIX-domain socket / Windows named pipe — for non-browser clients only.** Honest limit:
   the dashboard is a **browser page; browsers cannot fetch over UDS/named pipes**, so "no TCP
   port at all" is not available for the primary UI. Offer `--socket` as an *additional* bind for
   CLI/agent consumers (agent-agnostic: it's just HTTP-over-UDS), where the OS enforces identity
   via socket file perms (0o600) / pipe SDDL — those clients get T1/T6 immunity for free.
9. **Run-as-service option for "our cases" (interruption resistance).** The only real defense
   against terminal-holders killing the flow is *account separation*: document (and later
   `forge serve --install-service`) running serve under a dedicated user via a Windows service
   (auto-restart on crash) / `systemd --user` unit with `Restart=always`. Same-user terminal can
   then no longer kill it without elevation, and crashes self-heal — which also closes the T6
   squat window structurally. This is the truthful answer to the user requirement; a userland
   flag cannot deliver it.

## 3. Encryption in transit

**Honest verdict per tier:**

- **(a) single-user:** loopback bytes are unreadable below admin (T4). TLS-on-loopback here is
  **pure theater** — the only party who could sniff is the party who owns the cert anyway. Do not
  build it for this tier.
- **(b) shared machine:** still no non-admin sniffing path; loopback-TLS is **defense-in-depth
  only**. Where it *does* earn its keep is server identity (T6) — but §2.7's HMAC handshake buys
  that for ~40 lines instead of a self-signed-cert UX (browsers show scary interstitials for
  self-signed localhost certs; pinning a fingerprint from the fragment can't override the
  browser's own trust model — the page can't inspect the cert it loaded over). So: **HMAC
  identity over plain HTTP loopback**, not TLS, for tier (b).
- **Per-run message MAC (cheap, ALWAYS):** since the POST body already carries the bearer token,
  add `hmac = HMAC-SHA256(token, verb ‖ args ‖ ts ‖ nonce)` and a server-side nonce cache for the
  run. Cost is trivial; value is (i) forgery/replay resistance if a token ever leaks via
  scrollback (T3) — an observed URL alone no longer suffices to replay a mutation days later,
  (ii) the same envelope is reused verbatim by the online tier. Honest label: locally this is
  belt-and-suspenders, not load-bearing.
- **(c) online/hosted: real TLS is mandatory, not optional.** Never expose the token-in-fragment
  scheme past loopback. Spec: the hosted tier fronts serve with TLS 1.3 (LetsEncrypt/Caddy or the
  platform's terminator — still zero-cost), replaces the per-run token with per-user bearer
  credentials (scrypt-hashed at rest), sets `Strict-Transport-Security`, keeps the Origin fence
  (`serve.js:114-127`) generalized to the configured origin, and keeps the MAC envelope from
  above as the second factor binding messages to a session. Optional E2E (encrypting message
  bodies browser→kernel so the host can't read them) is a **later** tier-(c) add: per-project
  X25519 keypair, body sealed in the browser, kernel stores ciphertext — only worth it when a
  third party hosts the relay. **Full design: [e2e-channel.md](e2e-channel.md)** (pervasive
  authenticated-encrypted channel — key model per tier, envelope, no-bypass chokepoint,
  decrypt-verify-fence at the agent surface).

## 4. Encryption at rest

- **(a) single-user:** `0o600/0o700` perms (§2.5) are **sufficient**. Encrypting local files
  against yourself protects nothing (bootstrapping problem: the key must be readable by the same
  account that the attacker is). Don't build it here.
- **Git projections caveat (all tiers):** `.forge/kernel/*.jsonl` (issues/comments) are plaintext
  *in git history* by design — that's the local-first sync value. If message bodies ever become
  sensitive, the correct control is **don't commit bodies** (projection redaction flag), not
  encrypting the working tree.
- **(b) shared machine:** perms are the primary control; add **opt-in body encryption**
  (`forge config security.encryptBodies=true`) for kernel comment/message bodies + journal event
  payloads: AES-256-GCM with a per-project random DEK. **The crux is where the DEK lives** —
  a keyfile next to the DB is readable by exactly the attacker we're defending against. Answer:
  wrap the DEK with the OS user-credential store (§5): DPAPI on Windows, Keychain on macOS,
  libsecret/kernel keyring on Linux, keyfile-with-0o600 as the honest last-resort fallback (and
  say so in the warning). This genuinely defeats: other local users reading a mis-permissioned
  file, backups/copies of the repo, and offline disk access (when the OS store is bound to the
  login credential). It does **not** defeat same-user or admin — state that in the docs.
- **Tamper-evidence (cheap, ALWAYS):** chain the pr-monitor journal — each NDJSON record carries
  `h = SHA-256(prev_h ‖ record)`; `readAllEvents` (`journal.js:62-72`) verifies on read and flags
  a broken chain instead of silently skipping (today a corrupt/deleted line is just skipped,
  `journal.js:69`). Detects both accidental corruption and message deletion/reordering. Keyless
  (so it's integrity-evidence, not authenticity) unless the tier-(b) DEK exists, in which case
  it upgrades to an HMAC chain for free.
- **(c) online:** server-side at-rest encryption is table stakes (platform disk encryption + the
  DEK scheme above with a server KMS/secret store); E2E as in §3 when hosting is third-party.

## 5. Windows specifics (native-Windows-first)

- **ACLs, not chmod:** Node's `mode: 0o600` is largely a no-op on NTFS. The perms primitive is an
  explicit DACL: create `.forge/` secured items with owner-only ACL (equivalent of
  `icacls <path> /inheritance:r /grant:r "%USERNAME%":F`), via a tiny `securePath()` helper that
  does chmod on POSIX and spawns `icacls` (absolute path `%SystemRoot%\System32\icacls.exe`,
  matching the S4036-safe pattern of `serve.js:393-400`) on win32. The startup perm audit (§2.5)
  reads the DACL the same way.
- **DPAPI is the clean key-storage answer: yes.** `CryptProtectData` (user scope) wraps the DEK
  with keys derived from the user's logon credential — no passphrase UX, no key file, nothing for
  another user to read, survives reboots, zero cost. No native addon needed: callable via a
  3-line PowerShell `[Security.Cryptography.ProtectedData]::Protect/Unprotect` child process
  (slow path, key ops are rare) — keeps forge dependency-free and agent-agnostic. Limits (state
  them): any process *of the same user* can unprotect; machine-scope DPAPI would let admins/other
  services too, so always user-scope.
- **Named pipes:** `\\.\pipe\forge-serve-<projecthash>` with an SDDL granting only the current
  SID — Node `net.Server.listen(pipePath)` supports it. Same browser limitation as UDS (§2.8):
  agents/CLI only.
- **macOS / Linux equivalents:** Keychain via `/usr/bin/security add-generic-password` (user
  keychain, no dep); Linux libsecret via `secret-tool` when present, else kernel keyring
  (`keyctl`), else 0o600 keyfile fallback with an explicit downgrade warning.
- **Cross-user kill on Windows:** a standard user cannot `taskkill` another user's process
  (needs SeDebugPrivilege) — same guarantee as POSIX; the service option (§2.9) additionally
  protects against *same-account* interruption and auto-restarts.

## 6. Ranked build list

**ALWAYS — ship in the serve MVP hardening (all cheap, no new deps, no UX cost):**

1. Token-gate `GET /data.json` (closes the one working shared-machine read — T1).
2. Single-instance lock `.forge/serve.lock` (pid+port+token-fingerprint; journal-lock pattern) — T9.
3. `securePath()` perms-at-creation (0o600/0o700 POSIX, owner-only DACL win32) on journal,
   snapshot, pid, lock files + startup perm audit that warns with the exact fix — T7.
4. Token stays memory-only (already true — hold the line); `--quiet-token` to keep it out of
   scrollback — T2/T3.
5. Per-run HMAC+nonce envelope on `POST /api/mutation` (replay/forgery resistance; reused by the
   online tier) — T11.
6. Hash-chained journal records with verify-on-read (tamper-evidence; flags instead of skipping) — T8.
7. Fail-loud EADDRINUSE message + lock release inside the existing shutdown handler — T6 window.

**SHARED-MACHINE tier (opt-in: `forge serve --shared` / config flag):**

8. Server-identity HMAC handshake in the fragment + hard red impostor state in `app.js` — T6.
9. Opt-in at-rest body encryption (AES-256-GCM, per-project DEK) with DPAPI / Keychain /
   libsecret-wrapped key; 0o600 keyfile only as loudly-labeled fallback — T7.
10. `--socket` UDS/named-pipe secondary bind for CLI/agent consumers (browser keeps TCP) — T1/T6
    for non-browser clients.
11. Loopback-TLS: **explicitly rejected** for this tier (no non-admin sniff path; self-signed UX
    cost; §2.7 covers identity). Revisit only if a compliance regime demands it.

**ONLINE tier (with the hosted/Phase-2 authoritative server; grounded on design.md:98-102 seam —
kernel issue 7c813e9d not locatable in this checkout's projections, flag for re-link):**

12. Real TLS 1.3 (platform terminator or Caddy/LetsEncrypt — zero-cost), HSTS, generalized Origin
    fence; fragment-token scheme retired in favor of per-user credentials (scrypt-hashed) +
    short-lived session tokens — T4/T1.
13. The ALWAYS MAC envelope becomes the session-binding second factor; add server-side rate
    limiting on `/api/mutation`.
14. Server-side at-rest encryption via the tier-9 DEK scheme backed by the host's secret store.
15. E2E sealed message bodies — **mandatory** for this tier; full channel design (envelope,
    keys, no-bypass, decrypt-at-surface) in [e2e-channel.md](e2e-channel.md).

**Rejected as disproportionate:** loopback TLS for tiers a/b (theater below admin); encrypting
local files for the single-user tier (bootstrapping problem); encrypting the git JSONL
projections (breaks the local-first/git-sync value — use projection redaction instead); any
account system for local tiers (violates zero-cost/local-first).

## 7. Honest limits (what no design here can prevent)

- **Your own account is the trust boundary.** Anyone executing as your user can kill the server,
  read its memory (token, DEK), call DPAPI/Keychain to unwrap the key, edit `web/dashboard/*.js`
  that `serve.js:319` will serve, or simply run `forge` verbs directly against the kernel. The
  requirement "no one with terminal access can interrupt the serve" is fully satisfiable only via
  account separation + service supervision (§2.9); within one account it reduces to auto-restart
  resilience, not prevention.
- **Admin/root owns everything** — sniffing loopback, ptrace, cert stores, DPAPI (via your logon
  material). No tier defends against the machine's administrator.
- **In-transit encryption on loopback is provided by the OS**, not by us; our controls there are
  authentication (token on reads+writes), identity (HMAC handshake), and integrity (MAC) — that
  is the "clean system" that actually matches the threat, and it is what the online tier's real
  TLS composes with unchanged.
