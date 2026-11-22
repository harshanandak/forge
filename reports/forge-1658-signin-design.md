# forge-1658: simple, agent-friendly device sign-in (design report)

Decisions needed:

1. Ship slice S1 (the link opens the approval page directly, no Continue click) inside release 0.0.1? It touches `cloud/src/auth/device-browser.ts`. A. Yes, with one focused security review of the diff (default). B. No, ship only S0 (CLI wording) in 0.0.1 and S1 in 0.0.2.
2. Keep the "I started this login myself" tick box? A. Keep it for 0.0.1 and revisit after S1 ships (default). B. Fold it into the button ("Approve: this code matches my terminal"), one click instead of two.
3. Order of "sign in" and "approve": A. Keep today's order, Approve then Clerk sign-in; same number of steps, no new browser session (default). B. Sign in first, then Approve; needs a short owner browser session, which is a new security design (slice S8, later).
4. Agent mode: A. Ship S0's machine-readable pending line now and the full `--no-wait` / `--wait` split (S2) after 0.0.1 (default). B. Build S2 before 0.0.1.

Code facts are read from `origin/main` at 93c1db8f (2026-11-20). Rung for each code fact: pointed at the line. Nothing was run.

## 0. The owner's acceptance bar

"I just use the command and it starts a login. I use the link from anywhere. I can log in and I can approve." Plus: sign-in must never need admin rights.

Reading of the bar used below: one command; one link that works on any device (phone, another computer); a Clerk sign-in; one Approve. The fewer browser steps between the link and "approved", the better. The bar is met by the device flow Forge already has, minus one click. It is not met by a loopback design (gh-style web flow, wrangler default, MCP), because loopback ties the browser to the CLI machine (section 2.3).

## 1. What exists today (verified)

### 1.1 The command already prints a one-click link and opens it

- `src/assembly/cloud-login.ts:310` builds `${target.origin}/device?code=<user code>`.
- Lines 311 to 315 print `Open <link>`, `Code: <code>` and the 10-minute expiry on stderr.
- Line 316 calls `openBrowser`, which is skipped when `FORGE_NO_BROWSER=1` or on Linux with no `DISPLAY`/`WAYLAND_DISPLAY` (lines 200 to 205). Windows uses `rundll32.exe url.dll,FileProtocolHandler` (line 210), macOS `open`, Linux `xdg-open`.
- Added in PR 512 (b9698ccd, 2026-11-13, "open the browser with the code filled in").
- The brief's premise "the CLI cannot print a one-click link" is wrong: the Worker returns only `verification_uri: "/device"` (`cloud/src/auth/project-login.ts:315`), but the CLI composes the complete link itself from the origin it already trusts. No server change is needed for the link.

### 1.2 What the link does in the browser

`GET /device?code=XXXX-XXXX` (`cloud/src/auth/device-browser.ts:157-172`) only prefills a form. It sets the page cookie `__Host-forge_device` (`Secure; HttpOnly; SameSite=Lax; Max-Age=900`) and shows a Continue button. The approval page appears only after `POST /device` (lines 352 to 424), which checks Origin and the double-submit CSRF cookie, charges the preview budget, finds the pending challenge and mints two single-use tickets (approve, deny). The approval page shows code, project, device and, when bound, session, plus the required tick box (lines 413 to 414) and Approve/Deny buttons.

Approve (`POST /device/approve`, lines 278 to 350) needs: same Origin, CSRF match, the tick box (`confirm=yes`), the approve ticket bound to this browser's cookie and this challenge. It then sets a per-state cookie `__Host-forge_device_<hash>` and redirects to Clerk with PKCE. The Clerk return (`/callback`, lines 200 to 276) needs that cookie, claims the Clerk code once, verifies audience, expiry and `authenticatedAt`, checks the single owner, and hands the identity to the engine, which approves only a pending, unexpired challenge.

### 1.3 No admin rights anywhere in sign-in

- Credential files live in the user's home: `~/.forge/cloud/credentials.json` (`src/assembly/cloud-profile.ts:93`, `openCloudFiles` at line 131). The project binding is `.forge/cloud.json` in the checkout (line 21).
- On Windows the private-file guard reads the file owner (`src/adapters/process/windows-acl.ts:95-99`, `GetFileSecurityW`) and writes only the DACL: `SetFileSecurityW(path, 0x80000004, ...)` at line 119. 0x80000004 is `PROTECTED_DACL_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION`. It never sets the owner (that is flag 0x1 and would need `SeTakeOwnershipPrivilege`). A file's owner always holds WRITE_DAC on it, so no elevation is needed.
- The owner check accepts the user's own SID or the Administrators group (`src/adapters/store-sqlite/private-files.ts:60-66`), so a folder made earlier by an elevated shell is accepted, not a reason to elevate.
- The browser opener runs `rundll32.exe url.dll,FileProtocolHandler` as the user (`cloud-login.ts:210`). No `runas`, no UAC, no service install, no registry write appears in `cloud-login.ts`, `cloud-profile.ts` or `device-identity.ts` (case-insensitive search for runas, elevat, sudo, admin, HKLM, setx: no hits in those files).
- The device id is stored under `deps.deviceRoot` by `nodeDeviceIdentity(...).acquire()` (`cloud-login.ts:119`), or comes from `FORGE_DEVICE_ID`.
- Conclusion (rung 2, pointed at the lines): `forge auth login` needs no admin rights. An admin prompt during sign-in would be a bug. If the owner saw one, the likely source is outside Forge (a browser or Clerk sign-in app); I could not reproduce or verify that.

### 1.4 "From anywhere": nothing ties the browser to the CLI machine

- Every cookie in the flow is set by the browser that opens the link: the page cookie on `GET /device` (line 170), the per-state cookie on the redirect to Clerk (line 348). The CLI never sets or reads a browser cookie. The CLI only polls with `device_code`.
- `SameSite=Lax` cookies are sent on the top-level GET return from Clerk to `/callback`, so the round trip works in any one browser, phone included.
- The rate limits key on `CF-Connecting-IP` of whoever is asking (`device-browser.ts:190`), not on the CLI's address.
- So the link already works on a phone or a second computer today (rung 2: from the code; not run on a phone).

What breaks on another device:

1. Sign-in that hops browsers. If the phone opens the link in an in-app browser (Slack, Teams, mail) and Clerk's sign-in jumps to the system browser or an identity app, the return lands in a browser without `__Host-forge_device_<hash>`. The callback then refuses with `access_denied` (line 237). Fix for the owner: open the link in the phone's real browser. Whether Clerk's providers hop browsers is unverified.
2. Link scanners and unfurlers (Slack previews, Outlook Safe Links) GET the link. Today that is harmless: GET only prefills a form. Slice S1 must keep it harmless (section 4, S1).
3. Comparing the code. The code is shown on the CLI machine. On a phone, the owner compares against the terminal they ran, or against the message an agent relayed. If the link came from a message, the comparison is only as good as that channel (section 3, phishing).
4. The 10-minute lifetime (`device-login.ts` `LIFETIME = 600`) includes walking to the other device and signing in.

## 2. Research (primary sources, fetched 2026-11-20 with curl)

### 2.1 RFC 8628 (https://www.rfc-editor.org/rfc/rfc8628.txt)

- 3.2: `verification_uri_complete` is OPTIONAL, "a verification URI that includes the user_code ... designed for non-textual transmission".
- 3.3: the server MUST implement an interaction that starts at `verification_uri` and has the user supply the `user_code` "at some stage". The server "should then inform the user about the action they are undertaking and ask them to approve or deny".
- 3.3.1: when the user arrives by the complete URI, "the user interaction described in Section 3.3 is still followed, with the optimization that the user does not need to type in the user_code. The server SHOULD display the user_code to the user and ask them to verify that it matches the user_code being displayed on the device". Clients "MUST still display the user_code".
- 5.4 Remote phishing: an attacker can start the flow on their own device and send the victim the link. With the complete URI "it is particularly important to confirm that the device is in the user's possession, as the user no longer has to type in the code". Suggestion: show the code and ask the user to verify the same code is on their device. Keep the lifetime short.
- 5.5 Session spying: someone who sees the code can race to approve. Not changed by a link.

What a one-click link may drop and must keep:

| Today's step | With the code in the link | Source |
|---|---|---|
| Type the code | Drop | 3.3.1 "does not need to type in the user_code" |
| Click Continue to submit the code | Drop (it only submits the code the link already carries) | 3.3.1 |
| Page shows the code | Keep, required | 3.3.1 SHOULD display, 5.4 |
| Ask the user to confirm the code matches and that they started it | Keep in some form | 3.3.1, 5.4 "particularly important" |
| Show project, device, session | Keep | 5.4 "display information about the device" |
| Approve or Deny choice | Keep | 3.3, 3.3.1 |
| Sign in (authenticate) | Keep | 3.3 |
| CLI prints the code | Keep (already does, line 312) | 3.3.1 MUST |

### 2.2 gh and wrangler (source read)

gh (cli/cli trunk f24a94ff; cli/oauth main e7af273c):

- `gh auth login` default is the device flow. `internal/authflow/flow.go:83` prints "First copy your one-time code"; interactive: "Press Enter to open <url> in your browser" (line 100); non-interactive: "Open this URL to continue in your web browser" (line 96). `--clipboard` copies the code (line 75).
- gh opens `verification_uri`, not the complete URI (`cli/oauth` `oauth_device.go:63`), so the user still types or pastes the code.
- Agents and headless shells: `--with-token` from stdin or `GH_TOKEN` (`pkg/cmd/auth/login/login.go:87-97`).
- `gh auth status`: text mode exits 1 on problems; `--json` always exits 0 unless fatal (`status.go:226-227`); fields include host, login, tokenSource, scopes, expiry; token hidden unless `--show-token`.
- `gh auth logout` removes local credentials and "does not revoke authentication tokens" (`logout.go:42`).

wrangler (cloudflare/workers-sdk main 56974d49):

- Default `wrangler login` is authorization code with PKCE and a local callback server on `localhost:8976` (`packages/workers-auth/src/flow.ts`, options at lines 63 to 69). `--device` uses RFC 8628 for containers and SSH (`packages/wrangler/src/user/commands.ts:86-88`).
- In device mode it validates both server URLs against the auth domain before printing or opening them, opens `verification_uri_complete` or synthesizes `?user_code=`, and always prints the bare URI and the code, citing RFC 8628 3.3.1 (`device-flow.ts:424-475`). First poll is immediate; interval floor 1 s.
- Non-interactive with no credentials returns `no-credentials-non-interactive` instead of prompting (`flow.ts:403-407`); CI uses `CLOUDFLARE_API_TOKEN`.
- `wrangler logout` revokes the refresh token at the revoke URL, then clears storage (`flow.ts` logout, lines 435 to 484). `wrangler whoami --json` exists (`commands.ts:256`).

### 2.3 MCP authorization and RFC 8252

- MCP spec 2025-11-25 and 2026-07-28 (`modelcontextprotocol/modelcontextprotocol` docs): OAuth 2.1; clients MUST use PKCE with S256; redirect URIs MUST be localhost or HTTPS; state SHOULD be used; RFC 8707 resource indicators MUST be used (2026-07-28 `basic/authorization/index.mdx:217`, `security-considerations.mdx:43-75`).
- RFC 8252 7.3 (https://www.rfc-editor.org/rfc/rfc8252.txt): native apps may receive the redirect on `http://127.0.0.1:{port}`; servers MUST allow any port.
- Lesson: loopback plus PKCE proves the browser is on the CLI's machine, which defeats remote phishing, but it fails the owner's "link from anywhere" bar (phone, SSH box, cloud agent). Forge's device flow is the right base. A loopback fast path could later be an extra for the same-machine case (S7), never the only path.

## 3. Step counts

### A. Today (per sign-in, from the code)

Human, link opened (auto-open on the same machine, or the printed link copied to any device):

| # | Action |
|---|---|
| 1 | Run `forge auth login` (or an agent runs it) |
| 2 | Open the link (0 if auto-opened) |
| 3 | Click Continue (code already filled in) |
| 4 | Compare code, project, device, session |
| 5 | Tick "I started this login myself..." |
| 6 | Click Approve |
| 7 | Clerk sign-in (k steps; possibly a pass-through if Clerk remembers the session; unverified) |

Total: 6 actions plus Clerk, 5 when auto-opened. The owner's description (go to `/device`, type the code) is the path where the link is not used: 8 actions plus Clerk.

Agent: run the command (it blocks up to 10 minutes polling), relay the link and code from stderr if its harness shows stderr before exit, read the final JSON envelope on stdout. There is no non-blocking start, and `cloud.login` declares `callers: ["human"]` (`src/blocks/cloud/forge.block.json`), so it is never an MCP tool (`src/contract/mcp.ts:61`). The CLI path works for agents.

Two machines: everything twice. Second session on the same machine: no new sign-in, because a login token without a session covers every session on its device (`docs/reference/cloud.md:61`). With `--bind-session` each session signs in, and the new credential replaces the saved one for the project (`cloud-login.ts:333-336`).

Lane resume (`src/blocks/work/README.md:88`): agent runs `forge lane resume`, gets `APPROVAL_REQUIRED` with `result.url`, relays it; owner opens the link, clicks Approve, signs in to Clerk; agent reruns with `approval: {request}`. Forge opens no browser and does not poll. Human: 3 plus Clerk. Agent: 2 runs plus 1 relay.

### B. Target

| # | Human action | Slice |
|---|---|---|
| 1 | Run `forge auth login` (or an agent runs it) | today |
| 2 | Open the link on any device (0 if auto-opened) | today |
| 3 | Check the code and click Approve (with the tick box: 2 clicks; Decision 2B: 1 click) | S1, S6 |
| 4 | Clerk sign-in | today |

Total after S1: 4 actions plus Clerk (3 when auto-opened). After S6: 3 plus Clerk. That is "command, link, approve, sign in". Agent after S2: one `--no-wait` call, one relay, one `--wait` call, no prompt.

## 4. Security: every check in today's flow

| # | Check (file) | Threat covered | Verdict |
|---|---|---|---|
| 1 | 8-letter code, 20-letter alphabet, rejection sampling, HMAC-hashed at rest (`device-login.ts`) | Guessing; reading codes from storage | Keep |
| 2 | 10-minute lifetime, 5 s poll, slow_down (`device-login.ts`) | Stale codes used for phishing (RFC 5.4); poll floods | Keep |
| 3 | Start budget 30 per project and 5 per address per minute; 1,024 live challenges (`project-login.ts`) | Challenge flooding | Keep |
| 4 | Device and session format checks (`project-login.ts`) | Injection in labels shown to the owner | Keep |
| 5 | `__Host-` page cookie, Secure, HttpOnly, SameSite=Lax (`device-browser.ts:170`) | Cookie theft and planting | Keep |
| 6 | Origin check plus double-submit CSRF on `POST /device` (`device-browser.ts:352-358`) | Cross-site preview forcing | Keep for POST. S1 adds a GET preview gated by `Sec-Fetch-Dest: document` and `Sec-Fetch-Mode: navigate` instead (see S1). The preview decides nothing |
| 7 | Preview budget per address (`spend(..., "previews")`) | Code guessing through the page | Keep, and charge the GET preview the same way |
| 8 | Approval page shows code, project, device, session | Remote phishing (RFC 5.4) | Keep. Optional: also show when the login started |
| 9 | Single-use approve/deny tickets bound to cookie and challenge | CSRF and replay of a decision | Keep |
| 10 | Tick box "I started this login myself, and this code matches..." (lines 413 to 414) | Remote phishing with a one-click link (RFC 5.4 "particularly important") | Keep for 0.0.1. Decision 2B replaces it with the claim on the button itself; the threat stays covered by the visible code and the explicit claim, but loses the second deliberate act. Never drop without one of the two |
| 11 | Per-state cookie `__Host-forge_device_<hash>` (line 348) | A stolen or planted state finishing in another browser | Keep |
| 12 | Clerk with PKCE S256 and state prefix; Clerk code claimed once (`upstream.ts:86-88`, `device-browser.ts:239-245`) | Code interception and replay | Keep |
| 13 | Audience, expiry, `authenticatedAt` checks (lines 246 to 256) | Tokens for another client; stale proofs | Keep |
| 14 | Single-owner policy (`ownerPolicy`, lines 258 to 267) | Anyone else approving | Keep |
| 15 | Engine approves only pending, unexpired; 5 failed tries per principal per minute | Approving dead or guessed codes | Keep |
| 16 | Poll consumes once; issuance rechecks owner, client and expiry (`project-login.ts` issue) | Double issuance; identity swap | Keep |
| 17 | 30-day token TTL (`LOGIN_TTL_MS`) | Long-lived leaked tokens | Keep |
| 18 | Decision and callback budgets (`browserAttempt`) | Brute force on tickets and states | Keep |
| 19 | CSP `default-src 'none'`, `X-Frame-Options: DENY`, `no-store` | Framing, clickjacking, caching | Keep |
| 20 | CLI never prints `device_code` or the token | Secret leakage to logs and agents | Keep; S2's pending handle must keep `device_code` in a private file |
| 21 | `FORGE_NO_BROWSER`, headless detection | Unwanted browser launches | Keep |
| 22 | Lane approval: per-request tickets, Clerk, policy identity, epoch and incarnation staleness, live requester token (`lane-browser.ts`, `lane-approval.ts`) | Stale or forged resumes | Keep |

Dropped: only the Continue click, which submits a code the link already carries (RFC 3.3.1). The human approval click and the Clerk sign-in stay in every slice.

## 5. Slices, in order

Sizes are estimated non-test lines. "Security path" means `cloud/src/auth` or credential storage.

| Slice | What | Files | Lines | Security path | Risk | 0.0.1? |
|---|---|---|---|---|---|---|
| S0 | CLI wording and an agent-readable pending line | `src/assembly/cloud-login.ts`, `src/blocks/cloud/docs.json`, `src/blocks/cloud/README.md`, `docs/reference/cloud.md` | about 15 code, 20 docs | No | Very low | Yes, no review needed beyond normal |
| S1 | The link opens the approval page directly | `cloud/src/auth/device-browser.ts` | about 30 (extract the preview block into one function, about 20 new) | Yes | Low; no decision check changes | Owner choice (Decision 1). Recommended with one focused review |
| S2 | Agent mode: `--no-wait` and `--wait` | `src/assembly/cloud-login.ts`, `src/assembly/cloud-profile.ts` (private pending file), cloud block schemas | about 150 | Yes (stores `device_code` privately) | Medium | No |
| S3 | `forge auth status` (local, read-only) | new op in `src/blocks/cloud`, `cloud-login.ts` or a sibling, schemas | about 120 | Reads credential metadata, never the token | Low | Optional; can wait |
| S4 | Lane resume opens the link and can `--wait` | `src/assembly/cloud-state-client.ts`, work block lane resume, `src/blocks/work/README.md` (changes "does not poll") | about 70 | No server change | Low to medium (documented contract change) | No |
| S5 | `forge auth logout` revokes the token on the server | new self-revoke route in `cloud/src/project.ts`, CLI | about 80 | Yes | Medium | No |
| S6 | One-click Approve (Decision 2B) | `device-browser.ts` | about 5 | Yes | Low code, real security decision | No, after S1 is in use |
| S7 | Optional same-machine loopback fast path (RFC 8252 plus a nonce the poll must present) | CLI, `device-login.ts`, `device-browser.ts` | about 200 | Yes | High; new design review | No |
| S8 | Sign in once, approve several (owner browser session; also sign-in-first ordering) | `device-browser.ts`, new session store | about 250 | Yes | High; new design review | No |

### S0 detail (zero security change)

- Print the link first and plainly: "Open this link on any device where you can sign in as the project owner: <link>". Keep the code line and say "Check that the approval page shows this code."
- Say how long the code lasts as a time ("expires at 06:40 UTC (10 minutes)").
- Add one stderr line agents can parse: `forge-login-pending {"url":"<link>","code":"XXXX-XXXX","expiresAt":"<ISO>"}`. It carries no secret (the user code is meant to be shown; `device_code` stays private). An agent that runs the command in the background reads it and relays the link without waiting for exit.
- Docs: replace "type the code" instructions with "open the printed link"; say it works on a phone; say "open it in the phone's browser, not inside a chat app" (section 1.4 item 1); say sign-in needs no admin rights.

### S1 detail (the smallest slice that reaches "command, link, approve, sign in")

Change one branch in `deviceRoute` (`device-browser.ts:157-172`):

1. When `GET /device` has exactly one valid `?code=` (the existing check at lines 164 to 166) and the request carries `Sec-Fetch-Dest: document` and `Sec-Fetch-Mode: navigate`, run the same preview as `POST /device` (lines 359 to 424): charge the preview budget, look up the pending challenge, mint the two tickets bound to this browser's page cookie, and render "Approve this device?" with the tick box. Set the page cookie in that same response.
2. Otherwise (no code, bad code, missing Fetch Metadata headers, old browsers, link scanners, unfurlers) keep today's prefilled form with Continue. Scanners send no `Sec-Fetch-Dest: document`, so they create no ticket rows and charge nothing; the owner's later visit is unaffected.
3. Move the preview block into one function used by both paths so the checks cannot drift.

Why this is safe:

- The preview decides nothing. Approve still needs POST, same Origin, CSRF match, the tick box, a ticket bound to this browser's cookie and challenge, then Clerk, the owner policy and the engine's pending check (rows 6 and 9 to 16 unchanged).
- A cross-site page cannot read the tickets (CSP, `X-Frame-Options: DENY`, no CORS). The worst a forced top-level navigation does is spend the victim's preview budget for 60 seconds, the same as today's POST being retried.
- `PER_CHALLENGE = 3` rows per challenge still caps rows; the oldest row is evicted first.

Tests to add (CI only): GET with a valid code and Fetch Metadata renders the approval page and sets the cookie; GET without Fetch Metadata renders the old form and writes no row; GET with an unknown code charges the preview budget and refuses; approve from a GET-minted ticket still needs Origin, CSRF and the tick; a ticket from one browser fails in another.

Result: command, link (auto-opened or any device), tick plus Approve, Clerk sign-in.

### S2 detail (agent mode)

- `forge auth login --no-wait`: starts the challenge, opens the browser unless `FORGE_NO_BROWSER=1` or headless, writes `device_code` and the deadline to a private file `~/.forge/cloud/pending/<handle>.json` (same private-file guard as credentials), prints the envelope `{status: "pending", url, code, expiresAt, interval, handle}` on stdout and exits 0. Never prompts.
- `forge auth login --wait [--handle <h>] [--timeout <seconds>]`: polls with the server's interval and slow_down rules until approved, denied or expired. Exit 0 with today's output schema on approval; exit 1 with `LOGIN_DENIED` or `LOGIN_EXPIRED`; exit 2 (`INCOMPLETE`) when the timeout passes while still pending, so it can be called again; exit 6 on bad input (exit-code meanings from `docs/reference/cloud.md:128`). The pending file is deleted on any final outcome.
- A transport failure during a poll still ends the login (today's rule, `cloud-login.ts` `pollForCredential`), because the poll may have consumed the challenge.
- `cloud.login` stays `callers: ["human"]` for MCP. Agents use the CLI; the owner's click is what grants trust.

### S3 detail (`forge auth status`)

Local and read-only: binding origin and project, device id, session if bound, token id, expiry and days left, whether `.forge/cloud.json` matches the saved credential. Never the token. Text mode exits 1 when not signed in; `--json` exits 0 with `signedIn: false`, the gh rule. Callers human and agent. A server-side check (`--check`) needs a whoami route and comes later.

### S4 detail (lane resume)

On a TTY, open the approval link in the browser (today Forge never does). Add `--wait`: retry the resume with `approval: {request}` at a fixed interval until it succeeds or the request expires (10 minutes, `lane-approval.ts:208`). The server already answers a pending request with `APPROVAL_REQUIRED` and no new link, so retries are safe. Human steps stay: open link, Approve, Clerk. Agent steps drop to one call.

## 6. Other open questions

5. Second machine: A. Keep one approval per machine; each is now command, link, Approve, sign-in, and Clerk may remember the session (default). B. Plan S8 so one sign-in approves several pending logins.
6. Logout: A. Keep local-only logout for 0.0.1 and say so in its output (default). B. Add server revoke (S5) before 0.0.1.

## 7. What I could not verify

- Whether Clerk skips the sign-in form when the owner already has a Clerk session. Forge sends no `prompt` or `max_age` (`upstream.ts:86-88`), so it may, but Clerk's behavior was not checked.
- Whether Clerk's sign-in providers (for example Microsoft) hop from an in-app browser to the system browser on phones, which would break the callback cookie.
- That every target mobile browser sends `Origin` on form POSTs and `Sec-Fetch-Dest`/`Sec-Fetch-Mode` on navigations. Browsers without Fetch Metadata fall back to the Continue form in S1, so this affects convenience, not safety.
- The source of the admin prompt the owner saw: no admin path exists in the sign-in code, but nothing was run.
- Whether the MCP 2026-07-28 spec folder is final or a draft; I read it from the spec repo's main branch.
- Nothing was run: no tests, no live login, no phone test.
