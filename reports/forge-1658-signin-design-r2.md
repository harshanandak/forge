# forge-1658: one-step device sign-in, design revision 2

Decisions needed: none new. The four decisions in revision 1 (S1 in 0.0.1, keep the tick box, keep the Approve-then-Clerk order, agent mode later) carry over with the same defaults. This revision only changes how S0 and S1 are built.

Revision 1: `.overseer/reports/forge-1658-signin-design.md`. Review: Sol, PASS WITH CHANGES (thread `delegate-task:4dd23b5e`). Code read from `93c1db8f` (origin/main, 2026-11-20) with `git show`. Rung for every code fact: pointed at the line. Nothing was run. Specs read: RFC 8628 (rfc-editor.org text) and W3C Fetch Metadata (w3.org/TR/fetch-metadata, fetched 2026-11-20 with curl).

## 0. What changed from revision 1

| Revision 1 said | Revision 2 says | Why |
|---|---|---|
| S1 reuses the POST preview writer as is | GET uses the same writer in an add-only mode: it never removes, replaces or evicts a row; when it cannot add safely it shows today's Continue form | Review change 1: the shared writer removes the same-cookie row and evicts the oldest row (`device-browser.ts:390-397`), which can kill a live ticket or a Clerk round trip |
| `Sec-Fetch-Dest: document` plus `Sec-Fetch-Mode: navigate` keeps scanners out | Those two headers plus a user-caused navigation (`Sec-Fetch-Site: none` or `Sec-Fetch-User: ?1`) and no speculation header (`Sec-Purpose`, legacy `Purpose: prefetch`). This lowers accidental effects; it proves nothing about intent | Review change 2 |
| "Charge the GET preview the same way" | Successful previews are never charged. Only a lookup that finds no pending challenge charges the failure budget (5 per address, 30 per project, per 60 s) | Review change 2: the old text was wrong about the code |
| S0 line "carries no secret" | S0 line has exactly `url`, `code`, `expiresAt`, built with `JSON.stringify` from a literal; `expiresAt` is the polling deadline; docs call the code sensitive and short-lived | Review change 3 |
| (silent) | Clerk redirect gets `Referrer-Policy: no-referrer`; page keeps `same-origin`; tick box unchanged; device and session never come from GET parameters; GET responses carry `Vary` | Review smaller points; Fetch Metadata 5.1 |

## 1. Required changes: chosen approach, rejected alternative, exact touch points

### Change 1: an automatic GET never harms a live row

**Chosen: add-only GET allocation with a Continue-form fallback.**

Move the preview block of `deviceRoute` (`device-browser.ts:365-424`: ticket minting, hashes, the `conditionalUpdate` at 375-410, the approval page at 413-424) into one function:

```ts
async function preview(ctx, code: string, mode: "replace" | "add"): Promise<Response | "fallback">
```

`ctx` carries `store`, `userCodeKey`, `project`, `address`, the page cookie value and `csrf`. POST `/device` calls it with `"replace"` and keeps today's behavior byte for byte. The GET fast path calls it with `"add"`.

Inside the one synchronous `conditionalUpdate` (no await, so it is atomic in the Durable Object):

1. Budget room check `spend(state, who, now, "previews", false)` (line 377), unchanged. No room: refuse `rate_limited` (429), as POST does.
2. Pending-challenge lookup (lines 379-384), unchanged. Not found: charge one failure (line 386) and refuse `invalid_code` (400), as POST does. The GET must not become an unmetered code oracle, so it shares POST's failure counter.
3. `live` = rows with `now < expiresAt` (no same-cookie filter in add mode). `mine` = live rows for this challenge.
4. Add mode only: if any row in `mine` has this cookie hash (a ticket row or a decided row), or `mine.length >= PER_CHALLENGE` (3), or `live.length >= MAX_PENDING_STATES` (256), return `fallback` and touch no row. Replace mode keeps lines 390-398 as they are.
5. Otherwise set `state.browser = live` (drops only expired rows, which no ticket or callback can use: both check `now < expiresAt` at lines 219 and 311) and push the new ticket row.

`fallback` renders today's Continue form (lines 167-171). The Continue button is a user POST and keeps today's replace behavior, so the owner can always finish, with one extra click.

Touch points in `cloud/src/auth/device-browser.ts`:

| Where | Change |
|---|---|
| New helper near line 129 | `userNavigation(headers)` (change 2) and `const VARY` |
| 157-172 GET branch | Compute the prefilled code as today. If the code is empty or `userNavigation` is false, return the form now (no store access). Otherwise fall through to setup |
| 173-198 setup | Unchanged. `needsClerk` is false for GET `/device`, so no new Clerk requirement |
| New, after 198 | GET fast path: missing `CF-Connecting-IP` returns the form (today GET needs no address, so it must not start throwing); else `preview(ctx, code, "add")`, and `fallback` returns the form |
| 343-350 Clerk redirect | Add `"Referrer-Policy": "no-referrer"` |
| 359-424 POST preview | Becomes `preview(ctx, code, "replace")`; the Origin and CSRF check (352-358) and code normalization (361-364) stay in the POST branch |
| 295-300, 302-337 decision checks | Unchanged |
| 200-273 callback | Unchanged |
| 97-112 `page()` | Unchanged; the GET branch sets `Vary` on its response |

**Rejected: lane-style signed tickets (`lane-browser.ts:329-339`).** GET would write nothing: tickets would be `HMAC(action, challenge, cookie, nonce)`, redeemed once on POST through `redemption.claimOnce`. Rejected for three reasons:

1. It changes the decision checks (lines 295-337), which today read a stored ticket row. Revision 1 promised that S1 leaves every decision check alone; this would turn S1 into a security redesign that needs a fresh review.
2. The decided row still has to be written at decision time, so the decision POST would inherit the same capacity question (3 per challenge, 256 per project) that add-only already answers.
3. Size: about 90 to 120 new lines across GET, both POSTs and the ticket format, against about 55 for add-only. The two ticket kinds (stored for POST previews, signed for GET) would also have to coexist or POST would change too.

**Rejected: GET replaces only its own cookie's ticket row (not decided rows).** Rejected because a refresh after the owner opened a second tab on the same cookie would still kill the first tab's tickets, and the fallback already covers refresh with one click.

### Change 2: automation and quota policy

**Chosen: a narrow fast-path gate, all failures fall back to the form with no store access.**

```ts
const userNavigation = (h: Headers) =>
  h.get("Sec-Fetch-Dest") === "document" &&
  h.get("Sec-Fetch-Mode") === "navigate" &&
  (h.get("Sec-Fetch-Site") === "none" || h.get("Sec-Fetch-User") === "?1") &&
  !h.has("Sec-Purpose") &&
  !/\bprefetch\b/i.test(h.get("Purpose") ?? "");
```

Policy, stated for the code and the docs:

| Request | Store write | Budget charge | Response |
|---|---|---|---|
| Any `Sec-Purpose` value (`prefetch`, `prefetch;prerender`) | none | none | Continue form |
| `Purpose: prefetch` (legacy) | none | none | Continue form |
| Either Fetch Metadata header missing or another value (old browser, curl, iframe, subresource) | none | none | Continue form |
| Script or meta-refresh navigation from another site (`Sec-Fetch-Site: cross-site`, no `Sec-Fetch-User`) | none | none | Continue form |
| User navigation, valid code, room to add | one ticket row | none (success is never charged) | Approval page |
| User navigation, valid code, no room or this cookie already has a row | none | none | Continue form |
| User navigation, well-formed code with no pending challenge | none | one failure (address and project) | `invalid_code` 400 |
| User navigation, failure budget full | none | none | `rate_limited` 429 |

Budget facts (corrects revision 1): `spend(..., "previews", false)` at `device-browser.ts:377` only asks for room. A failure is charged only at line 386 when no pending challenge matches. Limits are `ADDRESS_STARTS = 5` and `PROJECT_STARTS = 30` per `WINDOW_MS = 60_000` (`project-login.ts:37-39`, logic at 127-159). Successful previews cost nothing.

What the gate does and does not do (Fetch Metadata 4.2, 4.3): the `Sec-` prefix stops page script from forging these headers, but a page can still cause a real navigation with them, and a non-browser client can send any header. So the gate reduces accidental effects (prefetch, prerender, script redirects, unfurlers without a browser); it is not a person check. The safety of the design rests on change 1 (a GET cannot destroy a live row) and on the unchanged decision checks, not on the gate.

Residual, accepted and documented: a hostile page that gets one user click per attempt (or a scanner driving a real browser) can spend the victim address's 5-failure window with unknown codes, blocking fresh previews for up to 60 s. It cannot remove an issued ticket or a Clerk transaction. A client that already holds the code can fill the challenge's 3 rows or the project's 256 through POST today; that weakness exists before S1 and S1 adds no new path to it (the fallback form plus POST still lets the owner evict the oldest row for their own challenge).

`Vary: Sec-Fetch-Dest, Sec-Fetch-Mode, Sec-Fetch-Site, Sec-Fetch-User, Sec-Purpose, Purpose` on both GET responses, per Fetch Metadata 5.1. `no-store` already keeps caches out; `Vary` makes the dependency explicit.

**Rejected: `Sec-Fetch-Site: none` only.** Drops the fast path for links clicked in web mail or web chat (`cross-site` with `?1`), which is a main "from anywhere" route. **Rejected: charge successful GET previews.** Lets scanners and the owner's own refreshes exhaust the budget faster and changes POST semantics. **Rejected: GET skips the budget on unknown codes and shows the form instead.** The approval page versus the form would then be an unmetered validity oracle.

Touch points: new `userNavigation` helper; GET branch at 157-172; nothing in `project-login.ts`.

### Change 3: S0 output contract

**Chosen.** In `src/assembly/cloud-login.ts` at lines 310-316, after `deadline` (line 304) and before `openBrowser` (line 316):

```ts
const expiresAt = new Date(deadline).toISOString();
progress(`Open this link on any device where you can sign in as the project owner: ${link}`);
progress(`Code: ${challenge.userCode} (check that the approval page shows this code)`);
progress(`Waiting for approval; the code expires at ${expiresAt}.`);
progress(`forge-login-pending ${JSON.stringify({ url: link, code: challenge.userCode, expiresAt })}`);
```

Rules: the object is a literal with exactly three named fields; never spread `challenge`, `started`, the response, `deps.env` or the credential (`challenge.deviceCode` is the polling secret used at line 178). `expiresAt` comes from `deadline`, the same fixed value `pollForCredential` uses (lines 154, 162), never a fresh `now()`. The line goes to `progress` (stderr by default, line 308), never stdout, which carries the final envelope. A refused start (line 302) prints nothing, as today.

Docs (`src/blocks/cloud/docs.json`, `src/blocks/cloud/README.md`, `docs/reference/cloud.md`) say: "The code and link are sensitive, short-lived login information. Anyone who has them before they expire can see the project, device and session on the approval page and can use up this login's browser slots. They cannot approve the login or get a token without the owner's sign-in and the device's private polling code. Do not paste them into public logs or CI output."

**Rejected: put the pending line on stdout.** Breaks the single JSON envelope on stdout. **Rejected: `expiresIn` seconds.** An agent reading the line later cannot tell when the count started; an absolute time matches the polling deadline exactly.

## 2. Invariants and the smallest case that would break each

| # | Invariant | Smallest breaking case |
|---|---|---|
| I1 | A GET never removes or replaces a live row for its own cookie | Owner GETs the link, gets tickets, presses refresh (same cookie). If add mode filtered out the same-cookie row as line 393 does, the first page's Approve returns 400 |
| I2 | A GET never removes a decided row | Owner clicks Approve, is at Clerk, presses Back (the page is `no-store`, so the browser re-GETs `/device?code=...` with the same cookie). If GET replaced the row, the Clerk callback returns `access_denied` (line 237) |
| I3 | A GET never evicts another browser's live row | Owner is at Clerk; three GETs with three fresh cookies arrive. If add mode ran line 396, the third evicts the owner's decided row and the callback fails |
| I4 | A GET that cannot add safely changes no row | Challenge holds 3 live rows; a fourth GET. Any write to `state.browser` before the fallback return (for example assigning the pruned list first) breaks it |
| I5 | Speculative requests write nothing and charge nothing | GET with `Sec-Purpose: prefetch;prerender` and a valid code. A check for the exact value `prefetch` would miss it and mint a row |
| I6 | Missing Fetch Metadata keeps the Continue form | GET with `Sec-Fetch-Dest: document` and no `Sec-Fetch-Mode` (some proxies strip headers). An `||` in the gate would mint a row |
| I7 | The fast path is not an unmetered oracle | Six GETs with unknown, well-formed codes from one address in a minute. The sixth must be 429; if GET skipped the failure charge, it would be 400 forever |
| I8 | Successful previews are never charged | Six valid GETs (six cookies, two challenges) from one address must all succeed; a `charge: true` at line 377 would refuse the sixth |
| I9 | Approval still needs every POST check | A GET-minted approve ticket posted without `confirm=yes`, with a foreign Origin, or with another browser's cookie. Any one accepted means the extraction moved a check |
| I10 | Device and session shown come only from the stored challenge | `GET /device?code=X&device=evil&session=evil`. If the page showed `evil`, labels could be spoofed |
| I11 | The user code never reaches Clerk in `Referer` | The approval page now lives at `/device?code=...`. If the page policy were relaxed to `unsafe-url` and the 302 had no policy, the Clerk request would carry the full URL. Page `same-origin` (line 105) plus `no-referrer` on the 302 both block it |
| I12 | The decision POST keeps a valid Origin | Changing the page itself to `no-referrer` makes browsers send `Origin: null` (comment at line 104), so every Approve fails line 296 |
| I13 | The tick box stays | Dropping lines 413-414 lets one click approve an attacker's challenge from a phishing link (RFC 8628 5.4) |
| I14 | S0 line has exactly three fields | `JSON.stringify({ ...challenge, url })` prints `deviceCode` |
| I15 | S0 `expiresAt` equals the polling deadline | Computing `Date.now() + expiresIn * 1000` at print time after a slow start gives a later time than the poll uses |
| I16 | S0 prints before the browser opens and never on a refused start | Moving the line after `openBrowser`, or before the `refused` check at line 302 |

## 3. Tests: the review's 8 groups as table rows

All in CI only (owner rule: no local tests). Files: `test/cloud/auth/device-browser.test.ts` (groups 1 to 7) and `test/assembly/cloud-login.test.ts` (group 8). One new fixture helper, `fast(code, opts)`, sends `GET /device?code=` with default user-navigation headers (`Sec-Fetch-Dest: document`, `Sec-Fetch-Mode: navigate`, `Sec-Fetch-Site: none`) through the existing `send` (its `headers` option exists, line 61) and returns the reply and the jar parsed from `Set-Cookie`. Existing `ticketFor`, `selectorFor`, `submit`, `callback`, `frozen` and `rows` work on a GET-minted page unchanged. No existing test needs a change except extending the one at line 659: the prefill table (line 1591) sends no Fetch Metadata, so it still sees Continue.

| Group | Row | Steps | Expect | Invariant |
|---|---|---|---|---|
| 1 Live rows | 1a | `fast` then `fast` again with the same cookie | Second is the Continue form; first page's Approve is 302 and the callback is `approved` | I1 |
| | 1b | Approve from a `fast` page (302); `fast` again with the same cookie | Continue form; callback with the bind cookie is 200 `approved` | I2 |
| | 1c | Approve from a `fast` page (302); three `fast` calls with fresh cookies | Callback 200 `approved` | I3 |
| | 1d | `fast` (owner); three `fast` with fresh cookies | Owner's Approve still 302 | I3 |
| 2 Capacity | 2a | Three `fast` with fresh cookies; a fourth | Fourth is Continue form; `browser` array bytes unchanged; that browser's Continue POST then works and evicts the oldest (today's rule) | I4 |
| | 2b | Seed 256 live rows in `domain_cloud_login` state; `fast` | Continue form; `browser` array bytes unchanged | I4 |
| 3 Metadata matrix | 3a to 3i | Header sets: none; Dest only; Mode only; Dest `iframe`; Mode `no-cors`; Site `cross-site` without User; `Sec-Purpose: prefetch`; `Sec-Purpose: prefetch;prerender`; `Purpose: prefetch` | Continue form, `frozen()` unchanged (no store access at all) | I5, I6 |
| | 3j, 3k | Site `none`; Site `cross-site` with User `?1` | Approval page with the tick box | gate positive |
| 4 Budget | 4a | Six valid `fast` from one address across two challenges | All 200 approval pages | I8 |
| | 4b | Five `fast` with unknown codes, then a sixth, then a POST preview, same address | 400 `invalid_code` five times, then 429, then POST 429 (shared counter) | I7 |
| | 4c | Eight concurrent unknown-code `fast` from one address | Exactly five 400 and three 429 | I7 |
| | 4d | Fill the failure budget; use a GET-minted ticket, then its bound callback | 302, then 200 `approved` (bound proofs skip budgets, lines 228, 319) | I7 with existing rule |
| 5 GET to completion | 5a to 5j | From a `fast` page: approve plus owner; deny plus owner; replay the same ticket; approve ticket on `/device/deny`; wrong selector; another browser's cookie; no `confirm`; foreign Origin; Clerk `other-subject`; challenge advanced past 600 s then `fast` | 200 `approved` and poll 200; 200 `denied` and poll fails; 400; 400; 400; 400; 400; 400; 403 `AUTH_FORBIDDEN` with the challenge still pending; 400 `invalid_code` | I9 |
| 6 Session parity | 6a | Extend the test at line 659: loop `via` over POST preview and `fast`, the GET with `&device=evil&session=injected` | Same assertions as today for both; page never shows `evil` or `injected` | I10 |
| 7 Privacy headers | 7a | `fast` page, fallback page, `invalid_code` refusal | `no-store`, `DENY`, `same-origin`, CSP `frame-ancestors 'none'`; GET responses carry `Vary` | I11, I12 |
| | 7b | Approve from a `fast` page | 302 has `Referrer-Policy: no-referrer` and `no-store`; `Location` does not contain the user code | I11 |
| 8 S0 contract | 8a | Normal login (`FORGE_NO_BROWSER=1`) | Exactly one line starts with `forge-login-pending `; its JSON keys are exactly `url, code, expiresAt`; `expiresAt` equals `new Date(start + expiresIn * 1000).toISOString()`; `url` equals `${ORIGIN}/device?code=${USER_CODE}` | I14, I15 |
| | 8b | Inject `deps.browser` whose `launch` pushes `LAUNCH` into `lines` | Pending line index is before `LAUNCH` | I16 |
| | 8c | Start body with extra fields (`NEWMARK`) and the device code | Pending line contains neither; existing `expectNoSecrets` still passes | I14 |
| | 8d | Refused start, bad user code | `lines` stays `[]` (existing tests at 374 and 539 already assert this; no new code) | I16 |

Group 7's browser-level check (that a real browser sends no user code to Clerk and keeps a valid Origin on the POST) cannot run in CI, which has no browser. It becomes one manual acceptance step on the S1 PR: open a fresh link in the T3 integrated browser, approve, and record the Clerk request's `Referer` from the network view. It is not claimed as tested until that is recorded.

Test size estimate: helper 10, group 1 35, group 2 25, group 3 30, group 4 30, group 5 35, group 6 10, group 7 15, group 8 25. Total about 215 lines. Cap: changed non-test code lines (new or edited, excluding unchanged moved lines) are about 13 (S0) plus about 55 (S1) = 68, so the cap is 2 x 68 + 100 = 236. The plan fits with about 20 lines spare.

## 4. Non-test line estimates per slice

| Slice | File | New or edited | Moved unchanged | Notes |
|---|---|---|---|---|
| S0 | `src/assembly/cloud-login.ts` | about 10 (3 old lines replaced) | 0 | Lines 310-316 |
| S0 | `docs.json`, `README.md`, `docs/reference/cloud.md` | about 25 | 0 | Link wording, phone browser advice, sensitivity text, no admin rights |
| **S0 total** | | **about 35** | **0** | |
| S1 | `device-browser.ts` helper `userNavigation` plus `VARY` | about 10 | 0 | |
| S1 | GET branch and fast path | about 18 | about 5 | Form rendering moves into a small `continueForm` function |
| S1 | `preview()` signature, add-mode branch, fallback return | about 20 | about 50 | Lines 365-424 move; the eviction block (390-398) gains the add branch |
| S1 | POST call site, Clerk `Referrer-Policy` | about 6 | 0 | |
| **S1 total** | | **about 55** | **about 55** | |

Both slices are well under 200 non-test lines, so no split is needed. If the final diff of S1 goes past about 120 new lines, that signals the extraction drifted and the builder should stop and report rather than grow it.

## 5. Owner-visible steps per sign-in

Counting what the owner sees or does after `forge auth login` starts. `k` is the Clerk sign-in steps (possibly none if Clerk keeps a session; unverified).

| Step | Before (today) | After, fast path | After, fallback |
|---|---|---|---|
| Terminal shows | 3 lines: link, code, seconds left | 4 lines: link with "any device" wording, code with "check the page", expiry time, `forge-login-pending {...}` | Same 4 lines |
| Open the link | 0 if auto-opened, else 1 | 0 or 1 | 0 or 1 |
| Page with the code filled in, click Continue | 1 | 0 | 1 |
| Read code, project, device, session | 1 | 1 | 1 |
| Tick "I started this login myself..." | 1 | 1 | 1 |
| Click Approve | 1 | 1 | 1 |
| Clerk sign-in | k | k | k |
| See "approved"; terminal finishes | 1 | 1 | 1 |
| **Clicks and checks (excluding Clerk)** | **4 or 5** | **3 or 4** | **4 or 5** |

Fallback happens for old browsers or ones that strip Fetch Metadata, prefetch or prerender, a script redirect from another site, a refresh or Back after a ticket exists on that browser, and a challenge already holding 3 browser rows. Fallback is exactly today's flow, so no owner is worse off than today.

## 6. Where the design follows or differs from the specs

| Spec | Text | This design |
|---|---|---|
| RFC 8628 3.3 | The server must offer an interaction where the user supplies the user code "at some stage", then "should then inform the user about the action they are undertaking and ask them to approve or deny" | Follows. The approval page with project, device, session, code and Approve/Deny is unchanged. The code arrives in the link instead of being typed |
| RFC 8628 3.3.1 | With the complete URI, 3.3 "is still followed, with the optimization that the user does not need to type in the user_code"; the server SHOULD display the code and ask the user to verify it matches | Follows. The GET drops only Continue; the code stays on the page and the tick box asks for the match |
| RFC 8628 3.2 | `verification_uri_complete` is an optional server response field | Differs: the Worker returns only `verification_uri: "/device"` (`project-login.ts:326`); the CLI builds the complete link from its trusted origin. No change in S0 or S1 |
| RFC 8628 5.4 | With the complete URI "it is particularly important to confirm that the device is in the user's possession"; show the code and device information | Follows. Tick box and device and session display stay (I13); docs warn not to approve a link from someone else |
| Fetch Metadata 2.1, 2.2 | `Sec-Fetch-Dest` and `Sec-Fetch-Mode` describe the request's destination and mode | Follows: fast path only for `document` plus `navigate` |
| Fetch Metadata 2.3, 2.4, 4.3 | `Sec-Fetch-Site: none` marks user-agent-initiated navigations (address bar, bookmarks); `Sec-Fetch-User: ?1` is sent only for navigations triggered by user activation | Follows, as a narrowing only. The design does not treat either as proof of intent |
| Fetch Metadata 4.1 | `Sec-Fetch-Site` turns `cross-site` if any URL in a redirect chain is cross-site | Accepted: links through Safe Links style redirectors arrive as `cross-site`, so they need `Sec-Fetch-User: ?1` (unverified for each redirector) |
| Fetch Metadata 4.2 | The `Sec-` prefix stops script from setting the headers | Relied on only to stop forged headers from page script; non-browser clients are covered by change 1, not by the gate |
| Fetch Metadata 5.1 | Responses that depend on these headers should send `Vary` | Follows: `Vary` on both GET responses |
| Speculation headers | `Sec-Purpose` is defined by the WICG prefetch and prerender work and documented by Chrome; `Purpose: prefetch` is the legacy form | Follows the review: any `Sec-Purpose`, or `Purpose` containing `prefetch`, falls back with no write |

## 7. What I could not verify

- Which headers each target browser sends when the CLI opens a URL through `rundll32`, `open` or `xdg-open`. I expect `Sec-Fetch-Site: none`; if a browser sends something else without `Sec-Fetch-User`, that owner gets the fallback form (today's flow), not a failure.
- Whether Safe Links, Slack and Teams redirectors keep `Sec-Fetch-User: ?1` through their redirects.
- Real scanner header sets, deployed cache rules, and whether any log keeps the query string.
- Whether Clerk keeps a session (k = 0) and whether Clerk providers hop out of in-app phone browsers.
- Nothing was run: no tests, builds or live logins. Line estimates are from reading the code.
