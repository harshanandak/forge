# Pervasive E2E-encrypted, authenticated dashboard→agent channel (DESIGN, not implemented)

Extends [security-model.md](security-model.md). That doc covers server integrity, transit,
and at-rest per tier; this doc designs the **message channel itself**: dashboard→agent
messages as ciphertext everywhere they travel, decryptable and actionable at exactly one
point, with no way to add, forge, replay, inject, or bypass.

Requirement (verbatim): "cant we keep info encrypted thats passing to never let anyone read
or decrypt it" — extended to: no one can read, ADD anything, BYPASS it, INJECT anything, or
ACCESS anything by any method.

## 0. The honest frame — state it before any crypto

**Absolute "no one can ever decrypt" is impossible**: the agent must decrypt the message to
act on it. The achievable maximum is:

> Only the **intended local agent** — keyed to the OS user account that owns the project —
> can decrypt and act. Everyone and everything else (the serve process's storage, other
> local users, the network, a cloud relay, git history, backups) sees only ciphertext, and
> nothing that is not a validly authenticated envelope is ever surfaced to the agent as a
> message.

**The irreducible limit**: an attacker running **as your own OS user at the live terminal**
can invoke `forge` and unwrap the same OS-keystore key the agent uses — within one account,
E2E reduces to authenticity + access control + tamper evidence, not secrecy from that
attacker. Only **account separation** (running serve/agent under a dedicated user,
security-model.md §2.9) defeats the same-user case. This is a law of the platform, not a
design gap; pretending otherwise would be theater (security-model.md §7).

A second honest boundary, local tier: `forge serve` runs as the same user as the agent, so
"the server can't decrypt" is not a meaningful local claim — serve *could* unwrap the same
key. What the local design actually buys is: **everything at rest and on the wire is
ciphertext** (kernel DB, JSONL projections, journal, git history, backups, loopback bytes'
payloads), and serve is *architected* never to decrypt (it stores and relays opaque
envelopes), so no plaintext ever lands anywhere durable. The "server provably cannot
decrypt" claim becomes real only on the **online tier**, where asymmetric keys mean the
relay never possesses decryption material at all.

## 1. Five guarantees, one envelope

| Guarantee | Mechanism | Section |
|---|---|---|
| NO-READ | AES-256-GCM body encryption; ciphertext at rest + in transit + in git | §3, §4 |
| NO-ADD / NO-FORGE / NO-REPLAY | AEAD auth tag + associated-data binding (project ‖ issue ‖ verb ‖ session ‖ seq) + per-message nonce + monotonic seq; fail-closed reject | §3 |
| NO-BYPASS | Every write path carries the same envelope; the single agent-facing surface only ACTIONS valid envelopes, whatever path deposited the bytes | §6 |
| NO-INJECT-INTO-AGENT | Verify-then-fence: decrypt+authenticate BEFORE surfacing, then `fenceUntrusted` provenance fence — body is DATA, never instructions | §5 |
| NO-ACCESS-BY-ANY-METHOD | Ciphertext in sqlite/JSONL/journal + owner-only perms (0o600/DACL, security-model.md §2.5/§5) + key wrapped in OS keystore (never a plaintext file) | §4, §7 |

Confidentiality and integrity come from the **same primitive** (AEAD): a message that
decrypts is by construction unmodified and produced by a key holder. Authenticity beyond
key possession (online tier) adds a sender signature.

## 2. Key model — per tier

### Tier (a)/(b) — local single-user and shared machine: SYMMETRIC, OS-wrapped

- **One per-project DEK**: 32 random bytes (`crypto.randomBytes(32)`), generated on first
  `forge serve --secure` (or `forge key init`). Identified by `kid` = first 8 hex of
  SHA-256(DEK).
- **At rest**: never a plaintext file. Wrapped by the OS user-credential store and stored
  wrapped at `.forge/keys/<kid>.dek` (0o600/owner-DACL): **DPAPI** user-scope on Windows
  (`ProtectedData.Protect` via the dependency-free PowerShell child described in
  security-model.md §5), **Keychain** (`/usr/bin/security add-generic-password`) on macOS,
  **libsecret** (`secret-tool`) / kernel keyring on Linux, 0o600 keyfile as loudly-labeled
  last resort. Zero new npm deps.
- **Delivery to the browser**: in the **URL fragment**, exactly like the token today
  (`serve.js:443` prints `#token=…`; extend to `#token=…&k=<base64url DEK>`). Fragments are
  never sent to the server, never in Referer, and `app.js` already captures the fragment
  once and moves it to sessionStorage (`web/dashboard/app.js:1335-1348`) — the key rides the
  identical, already-audited path. The serve process minted it, so this adds no exposure
  over the token; the point is the key never appears in a URL the *server logs* or any
  intermediary sees.
- Why symmetric here: dashboard and agent are the same trust domain (same OS user); a
  shared key is the simplest primitive that makes every stored/transported byte ciphertext,
  and it lets the dashboard **decrypt history for display** (comments list) with the same
  key — no multi-recipient machinery.

### Tier (c) — online / relay / team: ASYMMETRIC to the agent

- **Agent identity keypair**: X25519 (Node `crypto.generateKeyPairSync('x25519')`),
  private key wrapped in the OS keystore on the agent's machine, public key registered with
  the relay at pairing. Fingerprint pinned in the dashboard's join link (fragment), so a
  malicious relay cannot swap keys undetected.
- **Per message (ECIES pattern)**: browser generates an ephemeral X25519 key →
  ECDH(ephemeral, agent-pub) → HKDF-SHA256 → per-message AES-256-GCM key → encrypt. The
  relay carries `{ephemeral-pub, nonce, ct}` and **never possesses any decryption
  material** — this is where "the server cannot decrypt" becomes literally true.
- **Sender authenticity**: per-session Ed25519 (or ECDSA P-256 where WebCrypto Ed25519 is
  unavailable) signing key generated in the browser at pairing, public half registered via
  the authenticated pairing flow; every envelope is **sign-then-encrypt**. The agent
  verifies the signature after decrypt and rejects unknown senders — key possession alone
  is no longer sufficient to author (defeats a leaked-relay-credential attacker).
- **Dashboard read-back** (seeing its own sent history): wrap the per-message content key
  to two recipients — agent pubkey and the dashboard user's pubkey (age-style
  multi-recipient). Cheap: one extra 32-byte wrap per message.

## 3. The envelope (one format, all tiers)

Stored **as the comment body** — the kernel already treats bodies as inert opaque user data
(`lib/commands/serve.js:44,50`), so the store needs **zero schema change**:

```
forge-e2e/1 <base64url(JSON)>
{ v:1, alg:"A256GCM"|"X25519+A256GCM", kid, n:<12-byte nonce>,
  ad:{ project, issue, verb, session, seq, ts }, ct, epk?, sig? }
```

- **Nonce**: 12 random bytes per message, never reused (random is safe at this volume; the
  agent additionally rejects any (kid, nonce) it has seen within the seq window).
- **Associated data** (GCM AAD, authenticated but not encrypted): project id ‖ issue id ‖
  verb ‖ serve session/run id ‖ **monotonic seq** ‖ timestamp. This kills cross-context
  replay: a validly sealed comment for issue A cannot be replayed onto issue B, another
  project, another session, or re-delivered later (seq must strictly increase per
  (kid, session); the agent persists last-seen seq in a 0o600 state file).
- **Relation to the security-model.md §3 HMAC+nonce mutation envelope**: keep both, layered.
  The HMAC(token) envelope authenticates the **transport hop** (browser→serve POST — serve
  rejects forged/replayed POSTs without ever opening the payload); the AEAD envelope
  authenticates the **message end-to-end** (survives storage, git, relay). Transport MAC
  gates entry; E2E envelope is what the agent trusts.
- **Fail-closed at the agent**: an envelope that fails GCM auth, AAD match, seq/nonce
  freshness, or (tier c) signature verification is **never surfaced as content and never
  actioned** — it surfaces only as a one-line tamper flag (`⚠ 1 message failed
  authentication — possible tamper/bypass, kid=…, issue=…`).

## 4. The ciphertext path — encrypt point → ciphertext everywhere → one decrypt point

**ENCRYPT — in the browser, before the POST.** `serveComment()` collects the plaintext
(`web/dashboard/app.js:1440-1444`) and calls `serveApply('issue.comment', [id, body])` →
`fetch('/api/mutation')` (`app.js:1362-1364`). The seal happens here, via
`crypto.subtle` AES-GCM — available because `http://127.0.0.1` / `localhost` is a
**secure context** (potentially-trustworthy origin), so WebCrypto works on the local
dashboard without TLS. The POST body's `args[1]` is already the envelope string.

**CIPHERTEXT EVERYWHERE — no component between browser and agent ever opens it:**

| Hop | Where | What it sees |
|---|---|---|
| Transport | `POST /api/mutation` (`serve.js:16,340,365-366`) | envelope string inside the token+HMAC-gated POST |
| Serve relay | `handleMutation` → in-process broker relay (`app.js:1322-1323`: dashboard never mutates the kernel directly) | opaque `args`; serve stores/relays only ciphertext, by contract never holds a decrypt step |
| Kernel store | comment row, body column (comment verb mapping `serve.js:55`; `comments.body` preserved through the store per `lib/kernel/spine-beads-compat` contract) | ciphertext body |
| Git projection | `.forge/kernel/comments.jsonl` (`lib/kernel/projection-jsonl-writer.js:20,51,97-121` — bodies serialized verbatim into the JSONL + manifest hash) | ciphertext **in git history, forever** — solves security-model.md §4's "plaintext in git by design" caveat for message bodies without breaking local-first sync |
| Snapshot read-back | `GET /data.json` carries full issue/message data (`serve.js:369,376`) | ciphertext bodies; the **dashboard** decrypts client-side for display with its fragment-delivered key — the served snapshot file on disk stays ciphertext |
| Journal | `appendEvents`/`writeSnapshot` (`lib/pr-monitor/journal.js:114,150`) | any message-bearing payload stored sealed; chain records upgrade from hash-chain to **HMAC(DEK)-chain** (security-model.md §4) |
| Online sync/relay | git-sync export↔hydrate of the JSONL projections; Phase-2 relay seam (design.md:98-102) | moves ciphertext blobs; hydrate does **not** verify or decrypt — verification stays at the surface (§6 W4) |

**DECRYPT — exactly one point: the agent-facing surface render inside forge.** Not the
server, not the kernel, not the browser POST path. See §5.

## 5. Decrypt-at-agent mechanics — how, without spreading the key

The agent never holds key-handling code, which preserves **agent-agnostic**: the
SessionStart/UserPromptSubmit hooks that surface messages are rendered per-agent by
`lib/hook-renderer.js:395-401` (Claude/Cursor/Codex/Hermes), but every one of them just
**invokes forge**; the digest/orientation is assembled inside the forge process
(`lib/memory-digest.js:150`, `lib/orientation.js`). That forge process runs **as the OS
user**, so it — and only a process of that user — can unwrap the DEK from
DPAPI/Keychain/libsecret at render time.

Order of operations at the surface (the coordinator-mandated pipeline):

1. **Fetch** comment rows (`show` attaches comments,
   `lib/kernel/issue-command-contract.js:107-110`; digest fetches issues/notes,
   `memory-digest.js:41-81`).
2. **Unwrap** DEK from the OS keystore (in-memory only, zeroed after; never written, never
   in argv/env — same discipline as the serve token).
3. **Decrypt + authenticate**: GCM open with AAD check, then seq/nonce freshness, then
   (tier c) sender signature. **Failure ⇒ fail-closed**: the body is dropped, a tamper flag
   line is emitted instead (§3).
4. **Fence**: pass the *plaintext* through `fenceUntrusted`
   (`lib/untrusted-content.js` — delimiter-neutralizing provenance fence), exactly where
   sections are fenced today AFTER `applyBudget` truncation
   (`memory-digest.js:162-165`, `orientation.js:124-130`). Decrypt THEN fence — the fence
   wraps plaintext, and the existing invariant (close-marker always present, nested
   delimiters neutralized) is unchanged.
5. **Surface** into the digest the hook prints.

So injection is defeated **twice**: an attacker without the key can't get a message
*surfaced at all* (step 3 rejects it); even an authentic message body can never be read as
instructions (step 4 fences it as provenance-labelled DATA).

The same decrypt-verify-fence helper is the **only** module in the codebase allowed to
unwrap the DEK for reads; `forge issue show` / `forge recap` route through it too, so a
human reading the issue in the terminal sees plaintext (they are the same trust domain)
while every file on disk stays sealed.

## 6. NO-BYPASS — enumerate every write path, one verification chokepoint

The rule: **the agent only actions valid envelopes, no matter which door the bytes came
through.** Writers inside the trust domain can all seal (they can unwrap the DEK); anything
that cannot produce a valid envelope is, by definition, outside the trust domain and is
flagged, never actioned.

| # | Write path | Treatment when channel security is ON |
|---|---|---|
| W1 | Dashboard POST `/api/mutation` (`app.js:1362`, `serve.js:365`) | seals in-browser (§4); serve additionally **rejects** unsealed `issue.comment` bodies at the door (schema check on the opaque prefix — serve validates shape, not content) |
| W2 | CLI `forge issue comment` (AGENTS.md stage-context flow) | forge seals at write time — it runs as the user and unwraps the DEK; zero UX change |
| W3 | Direct file/db writes: sqlite open on `kernel.sqlite`, hand-editing `comments.jsonl`, appending to the journal NDJSON | cannot mint a valid envelope without OS-keystore access → fails step 3 at the surface → tamper flag, never surfaced as content, never actioned. Journal deletion/reorder additionally trips the HMAC chain (`journal.js:62` verify-on-read per security-model.md §4) |
| W4 | Online git-sync hydrate / relay deposit into the inbox projection | envelopes travel opaque end-to-end; hydrate performs no trust operation — verification happens only at the agent surface, so a compromised relay or poisoned sync can inject nothing actionable |
| W5 | pr-monitor journal events (`journal.js:114`) | message-bearing payloads sealed; chain HMAC'd with the DEK |

There is deliberately **one** verification chokepoint (§5's helper) rather than
per-writer enforcement — you cannot forget to guard a door you never trusted. This is the
mechanism-not-identity principle: trust is "can you produce a valid envelope," never "which
process claims to be writing."

## 7. Key lifecycle

- **Generation**: `forge key init` (implied by first `--secure` serve): random 32-byte DEK,
  wrap, store wrapped file, print fingerprint. Tier (c): agent keypair generated the same
  way, pubkey published at pairing.
- **Scope**: per-project DEK (matches the per-project kernel DB), with **per-run browser
  delivery** via fragment. Per-session sub-keys (HKDF(DEK, runId)) were considered and
  rejected for tier (a)/(b): they'd block the dashboard from rendering prior-run history and
  buy nothing against the threats in scope (the fragment path is already token-grade).
  Tier (c) sessions get real per-session sender keys (§2).
- **Rotation**: `forge key rotate` mints a new DEK (new kid); old wrapped DEKs are retained
  in `.forge/keys/` as a keyring for decrypting history — envelopes name their `kid`, so
  reads pick the right key. Rotation does not re-encrypt history (append-only stores; git
  history is immutable anyway).
- **Key loss** (OS reinstall without keystore backup, deleted keyring): **that ciphertext
  is permanently unreadable — accepted and documented.** This is the honest price of the
  scheme; messages are coordination data, not the system of record for code. `forge key
  export` (prints a wrap passphrase-protected backup, explicit opt-in) is the documented
  escape hatch.
- **Same-user limit, restated**: rotation and wrapping never defeat a same-user attacker —
  they can run `forge key export` themselves. Account separation (security-model.md §2.9)
  remains the only real boundary there.

## 8. Primitives (all in-platform, zero new dependencies)

| Role | Primitive | Availability |
|---|---|---|
| Body encryption + integrity | **AES-256-GCM** | Node `node:crypto` `createCipheriv('aes-256-gcm')` / `webcrypto.subtle`; browser `crypto.subtle` (works on `http://127.0.0.1` — localhost is a secure context) |
| KDF | HKDF-SHA256 | Node `crypto.hkdf`; browser `subtle.deriveKey` |
| Tier-c key agreement | **X25519** (ECDH P-256 fallback where WebCrypto X25519 is missing) | Node `generateKeyPairSync('x25519')` + `crypto.diffieHellman`; browser X25519 in current Chrome/Safari/Firefox, P-256 everywhere |
| Tier-c sender signature | **Ed25519** (ECDSA P-256 fallback) | Node native since v12; WebCrypto Ed25519 in current browsers, P-256 fallback universal |
| Key wrap at rest | **DPAPI** (user scope) / **Keychain** / **libsecret**; 0o600 keyfile last resort | Dependency-free child-process pattern already specified in security-model.md §5 |
| Transport-hop auth | HMAC-SHA256(token) + nonce | security-model.md §3, unchanged |

RSA-OAEP is noted as the maximally-compatible asymmetric alternative but not recommended
(bigger envelopes, slower, no forward-secrecy story vs ephemeral ECDH).

## 9. Proportionality — honest recommendation per tier

- **Local single-user: OPT-IN, default OFF** (`forge serve --secure` /
  `security.e2eChannel=true`). Loopback + token + 0o600/DACL perms already hide messages
  from every attacker this tier has (security-model.md §1); E2E here mainly buys
  ciphertext-in-git/backups at the cost of key-loss risk. Don't force that trade.
- **Shared machine: ON** (bundled with `--shared`). Here it's load-bearing: other users
  reading a mis-permissioned repo, backups, or the git remote get ciphertext; W3 bypass
  writes become non-actionable.
- **Online/relay: MANDATORY, asymmetric.** A third-party relay/host must only ever carry
  ciphertext it cannot decrypt (§2 tier c) — this is non-negotiable for that tier and is
  the case the whole envelope design is shaped to serve unchanged.

Ranked build order (slots into security-model.md §6): envelope format + surface
decrypt-verify-fence helper first (it's the chokepoint everything shares) → symmetric tier
with fragment delivery + keystore wrap → journal HMAC upgrade → tier-c ECIES + signatures
with the relay work.

## 10. What this does and does NOT protect — the closing honest statement

**Does:** message bodies are ciphertext in the serve process's storage, the kernel sqlite,
the JSONL projections, git history, backups, the journal, loopback packets' payloads, and
any online relay; only a validly authenticated, non-replayed, context-bound envelope is
ever surfaced to the agent, and even then only as provenance-fenced DATA; every write path
— API, CLI, raw file, sync — funnels through one fail-closed verification point; the key
material never exists as a readable file, only OS-keystore-wrapped.

**Does NOT:** protect against an attacker running **as your own OS user** (they can unwrap
the key exactly as forge does, read the agent's terminal, or just run `forge` — only
account separation per security-model.md §2.9 closes that), against admin/root, or against
key loss (unreadable history is accepted by design). "No one can ever decrypt" is not
achievable for a message an agent must act on; "only the intended agent's account can
decrypt, and no one can forge, replay, inject, or bypass" is — and that is what this
design delivers.
