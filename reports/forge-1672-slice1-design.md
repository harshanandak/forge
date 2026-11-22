# Forge issue report, slice 1 (forge-1672)

**Decisions needed: none.** Build the revocable session in PR A and the installable issue page in PR B. The page shows one issue. The agent can share its URL in chat, and the owner replies in chat. The design adds 0 dependencies and requires $0 of new spend within the existing free allocation.

Evidence rung 2 for tracked code on `origin/main` (8c0273e00e41781135b1bf4ec393179c5dfbe0f6). The routes, controls and counts below are a design. CI, the deployed cache contract and behavior on phones remain unverified.

## 1. Threat model

Asset: Project issue ID, title, status and body shown by the report page to the configured owner, and the session that grants the view.  
Threat: An outsider obtains or guesses the URL, forges login inputs, inserts markup in an issue or receives a private response from a cache. Someone who steals a valid cookie can use it from another browser until logout or expiry.  
Always holds: A URL alone gives an outsider a generic sign-in prompt or refusal, with no issue lookup or existence signal. Each private report requires a live session created after Clerk verified the configured owner, and every private response carries the no-store headers specified below.

**How the Worker knows.** Start a new report sign-in transaction through `clerkUpstream()` in `cloud/src/adapters/workers-oauth/production.ts`. Reuse its `begin()` and `verify()` in `clerk/upstream.ts`, `ownerPolicy()` in `cloud/src/auth/compose.ts`, and `durableRedemption().claimOnce()` for single use. Check the verified issuer, subject and audience against `CLERK_ISSUER`, `FORGE_OWNER_SUBJECT` and `CLERK_CLIENT_ID`. Check that the proof is unexpired and its authentication time is at or before the verification time. Existing `begin()` sends neither `prompt=login` nor `max_age`. The verifier checks the authentication timestamp without a maximum age. Clerk may reuse its existing sign-in. The report requires identity verification at the callback, with no claim that the owner re-entered credentials. [Production verifier](https://github.com/harshanandak/forge/blob/8c0273e00e41781135b1bf4ec393179c5dfbe0f6/cloud/src/adapters/workers-oauth/production.ts#L12-L55), [Clerk request parameters](https://github.com/harshanandak/forge/blob/8c0273e00e41781135b1bf4ec393179c5dfbe0f6/cloud/src/adapters/workers-oauth/clerk/upstream.ts#L71-L90), [OIDC time checks](https://github.com/harshanandak/forge/blob/8c0273e00e41781135b1bf4ec393179c5dfbe0f6/src/adapters/oidc/index.ts#L230-L258), [owner policy](https://github.com/harshanandak/forge/blob/8c0273e00e41781135b1bf4ec393179c5dfbe0f6/cloud/src/auth/compose.ts#L30-L46).

The new Forge cookie is `__Host-forge_report`. The current `__Host-forge_device`, `__Host-forge_device_<state hash prefix>`, `__Host-forge_lane_preview` and `__Host-forge_lane_<state hash prefix>` bind forms or pending redirects. They grant no report access. A missing report cookie, bad MAC, missing record or expired record gives a generic refusal or sign-in prompt. [Device cookie names and result page](https://github.com/harshanandak/forge/blob/8c0273e00e41781135b1bf4ec393179c5dfbe0f6/docs/reference/cloud.md#L283-L288), [lane cookie names](https://github.com/harshanandak/forge/blob/8c0273e00e41781135b1bf4ec393179c5dfbe0f6/cloud/src/auth/lane-browser.ts#L22-L32), [lane callback cookie](https://github.com/harshanandak/forge/blob/8c0273e00e41781135b1bf4ec393179c5dfbe0f6/cloud/src/auth/lane-browser.ts#L225-L242).

## 2. Entry points and checks

| Entry point | Access or change | Check |
| --- | --- | --- |
| `GET /app/sign-in` | Creates or replaces a pending sign-in cookie | Configured HTTPS origin, bounded issue ID, random state and PKCE verifier, pending cookie MAC and 600-second deadline |
| `GET /callback` with one report state | Consumes the transaction and creates a report session | Matching pending cookie, one durable claim, valid Clerk proof, exact owner and successful session record write |
| `POST /app/logout` | Deletes the session record and clears the report cookie | Exactly the configured origin in `Origin`, valid report cookie, deletion confirmed before reporting success |
| Private `CodeRedemption.fetch` at `/__forge/report-session`, and `CodeRedemption.alarm()` | Creates, reads, expires or deletes the per-session record | Internal binding and separate report object names. Create once, check absolute deadline on every read, delete on expiry or logout |
| `GET /app/`, with or without `?issue=<id>` | Opens the session page or reads a report | When an issue is requested, validate the session before selecting a project and recheck it after the awaited Project response |
| Private `Project.fetch` at `GET /__forge/report` | Reads and renders the issue | Worker creates the internal request after a live-session check. Project rechecks the deadline after any await and uses only the provisioned project's read-only views |
| `GET /app/manifest.webmanifest`, `/app/report.css`, `/app/report.js`, `/app/icon-192.png`, `/app/icon-512.png` | Supplies install, layout and history behavior | Fixed assets with exact routes. No reflection of a cookie, request parameter or issue. No service worker route, registration or cache |
| Worker, private Project response, HTTP/CDN cache and browser history | Could retain or replay private HTML | No-store headers on every app response, including refusals, redirects and internal replies. No Cloudflare cache writes or Cache API. History behavior and the deployed cache rule are release checks |
| `GET/POST /authorize`, ordinary `/callback`, `POST /oauth/token`, `POST /oauth/revoke`, `/register`, `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource` | Existing OAuth authorization, credentials, registration and discovery | These routes retain their existing checks and public responses. They neither mint a report cookie nor accept one as authority. The shared callback rejects mixed state families before dispatch |
| `/device`, `/device/approve`, `/device/deny`, device callback, `POST /p/<project>/loginstart` and `/loginpoll`, `/lane-approval/<id>[/approve\|/deny]` and lane callback | Existing device and lane flows | Their own proof, cookie, ticket or code checks still apply. They neither mint a report cookie nor accept one as authority |
| `POST /p/<project>/command` | Creates or changes issues, comments, links, dependencies and leases | Configured project, authorized device token and existing command checks. This route neither mints nor accepts a report cookie |
| `POST /p/<project>/state/read` and `/state/commit` | Reads and changes admitted namespaces, including replace or delete in the commit path | Existing device token and namespace checks. The policy excludes `forge/work`. Neither route mints nor accepts a report cookie |
| `GET /p/<project>/holder`, `POST /p/<project>/{claim,renew,release}` | Reads or changes leases | Existing device or authorized OAuth owner checks. These routes neither mint nor accept a report cookie |
| `GET /p/<project>/status`, `GET /p/<project>/dump`, `POST /p/<project>/{restore,upgrade,devices,revoke}` | Reads status, exports or restores state, migrates storage and changes device authority | Existing admin-token check before forwarding. Restore refuses a provisioned project. These routes neither mint nor accept a report cookie |

The new internal paths are reachable through Worker bindings only. Requests to those path strings at the public origin return 404, even with a valid report cookie or forged internal headers. The new logic runs only on exact app paths and the explicit report callback. Shared callback dispatch rejects a mixture of device, lane, report or ordinary OAuth state families before any handler runs. Individual valid legacy callbacks keep their current paths and checks. [OAuth route list and dispatch](https://github.com/harshanandak/forge/blob/8c0273e00e41781135b1bf4ec393179c5dfbe0f6/cloud/src/auth/compose.ts#L14-L17), [existing callback dispatch](https://github.com/harshanandak/forge/blob/8c0273e00e41781135b1bf4ec393179c5dfbe0f6/cloud/src/adapters/workers-oauth/compose.ts#L167-L193), [state admission](https://github.com/harshanandak/forge/blob/8c0273e00e41781135b1bf4ec393179c5dfbe0f6/cloud/src/state-access.ts#L14-L24), [namespace checks](https://github.com/harshanandak/forge/blob/8c0273e00e41781135b1bf4ec393179c5dfbe0f6/cloud/src/state-access.ts#L61-L79), [admin gate](https://github.com/harshanandak/forge/blob/8c0273e00e41781135b1bf4ec393179c5dfbe0f6/cloud/src/worker.ts#L206-L238), [status and holder](https://github.com/harshanandak/forge/blob/8c0273e00e41781135b1bf4ec393179c5dfbe0f6/cloud/src/project.ts#L618-L675), [restore](https://github.com/harshanandak/forge/blob/8c0273e00e41781135b1bf4ec393179c5dfbe0f6/cloud/src/project.ts#L915-L957).

## 3. Routes, session and response contract

Dispatch in `createConfiguredWorker()` before legacy OAuth routing. Check methods before storage access. Known paths with the wrong method return 405 with `Allow`. Unknown app paths return 404. Duplicate report state values and mixed families return 400 before any exchange or claim.

| Method and path | File and result |
| --- | --- |
| `GET /app/` | PR A adds a generic 200 HTML session page with Sign in or Sign out, served by `cloud/src/auth/report-session.ts`. It ignores issue parameters and reads no Project data. PR B adds a GET issue ID field and links the manifest from `cloud/src/report-app.ts` |
| `GET /app/sign-in[?issue=<id>]` | `report-session.ts` sets the pending cookie and returns 302 to Clerk. The issue ID, if present, must meet the same syntax and length bounds as the report route |
| `GET /callback?state=forge-report.<random>&code=…` | `report-session.ts` consumes the pending sign-in. Successful owner verification writes the session record, sets the report cookie, clears the pending cookie and returns 303 to the fixed app path with the optional encoded issue ID. Bad proof returns generic 401, a verified non-owner 403 and unavailable config or storage 503 |
| `POST /app/logout` | `report-session.ts` deletes the session named by the cookie and clears it with `Max-Age=0`, then returns 303 to `/app/`. A missing record is a successful no-op. Delete an expired record if it still exists. Wrong or missing origin returns 403. If deletion cannot be confirmed, return 503 and leave the cookie available for another attempt |
| Private `POST/GET/DELETE /__forge/report-session` | `cloud/src/adapters/workers-oauth/report-session-store.ts`, routed by `redemption.ts`. POST writes the deadline and arms the alarm. GET returns the live deadline or 401. DELETE erases the record and acknowledges success, including when it is already absent. Keep all request values bounded and fail closed on storage errors |
| `GET /app/?issue=<id>` | PR B in `report-app.ts`. Signed-out callers get a generic 401 page with a sign-in control. Signed-in callers get 400 for an empty, malformed, oversized or duplicate issue parameter, 404 for a missing issue, or 200 HTML for a readable issue. Use one `<prefix>-<digits>` value up to 200 characters and leave prefix admission to the existing issue reader |
| Private `GET /__forge/report?issue=<id>` | PR B in `cloud/src/project.ts`. The Worker creates a new request with the validated issue ID and session deadline, carrying no browser headers or cookies. Project checks provisioning and the deadline, calls `readIssue()` with the existing `lazyViews()`, and returns no-store HTML or a generic refusal. It never receives the session token. The Worker checks the same record again after the awaited response and before releasing any body |
| `GET /app/manifest.webmanifest` | PR B in `report-app.ts`. Return `application/manifest+json` with `name` and `short_name` set to Forge, `id`, `start_url` and `scope` set to `/app/`, `display: standalone`, and the two PNG icons |
| `GET /app/icon-192.png` and `/app/icon-512.png` | Return `image/png` from generated bytes in `cloud/src/report-icons.ts`. Link the 192 px icon as `apple-touch-icon` too |
| `GET /app/report.css` and `/app/report.js` | Return fixed `text/css; charset=utf-8` and `text/javascript; charset=utf-8` in `report-app.ts`. The script only clears private display on `pagehide` and reloads on a persisted `pageshow` for a network authorization check. `/app/sw.js` and any service worker registration are deferred |

**Pending login.** Sign `__Host-forge_report_login` with a 600-second `Max-Age`. It carries random state, independent PKCE verifier, deadline and optional issue ID. Use the existing `importLoginKey()` and `DEVICE_LOGIN_HMAC_KEY` with separate MAC inputs for pending and active credentials, bound to origin, project, Clerk issuer, client and owner. Cap both cookie values at 1,024 bytes and refuse duplicate names. After checking the pending MAC, deadline and matching state, claim `sha256("report-login:" + state)` in the existing redemption path, then exchange the code with Clerk. A copied callback URL in a different browser cannot claim it without the matching pending cookie. Concurrent callbacks get at most one exchange.

**Active session and deletion.** Issue `__Host-forge_report` with `Max-Age=900; Secure; HttpOnly; SameSite=Lax; Path=/`, with no Domain. Apply the same scope and flags to the pending cookie. The active value contains a random 32-byte ID and a MAC, but it is usable only if a server record exists. Reuse the existing `CODE_REDEMPTION` binding and `CodeRedemption` class. Give each session its own object named `forge-report-session:v1:<sha256(random ID)>`, distinct from the existing bare 64-hex code object names. It stores one private key, `report-session`, with its absolute `expiresAt` in milliseconds. The Worker sends only the digest via object selection. It keeps no Clerk token or API credential in the record or browser. Persist the deadline and alarm in one transaction, and set the cookie only after success. The current `alarm()` deletes that object's storage. A read at or past the deadline refuses access and removes a lingering expired record, even if the alarm is late. Logout deletes the record through the same object, so further reads of a copied cookie fail. Revocation and expiry are checked again after awaited Project work, before release. A response that has already passed its final authorization cannot be recalled. The app cookie is a bearer during its 15-minute window, with no browser binding. Clerk logout does not delete this record. Forge Sign out does. [Existing HMAC key import](https://github.com/harshanandak/forge/blob/8c0273e00e41781135b1bf4ec393179c5dfbe0f6/cloud/src/auth/project-login.ts#L65-L91), [existing redemption storage, alarms and object selection](https://github.com/harshanandak/forge/blob/8c0273e00e41781135b1bf4ec393179c5dfbe0f6/cloud/src/adapters/workers-oauth/redemption.ts#L48-L97).

**HTML and cache rules.** Render only the issue ID, title, status and body. Cap the displayed body at 8,000 characters and mark clipping. Escape `&`, `<`, `>`, `"` and `'` in text and attributes. Construct internal links with `URLSearchParams`, then escape as attributes. Stored URLs stay plain text. Use `Referrer-Policy: same-origin` for HTML so the sign-out form can supply a same-origin `Origin` header. Send `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and this CSP. [Existing form origin behavior](https://github.com/harshanandak/forge/blob/8c0273e00e41781135b1bf4ec393179c5dfbe0f6/cloud/src/auth/device-browser.ts#L97-L107), [existing read and bounds](https://github.com/harshanandak/forge/blob/8c0273e00e41781135b1bf4ec393179c5dfbe0f6/cloud/src/issue-read.ts#L171-L202).

```text
default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; style-src 'self'; script-src 'self'; manifest-src 'self'; img-src 'self'
```

Send `Cache-Control: private, no-store`, `CDN-Cache-Control: no-store` and `Cloudflare-CDN-Cache-Control: no-store` on every app reply, including errors, redirects, private Project replies and session-store replies. Add no Cache API, browser storage or offline copy. The private Project request uses its binding and does not pass through the public CDN. At deployment, confirm that Cloudflare bypasses caching for `/app/` and its descendants and `/callback`, with no rule overriding the no-store directives.

**Release evidence still needed.** On the deployed origin, inspect status and headers on a signed-in report, signed-out and expired refusals, and the sign-in, callback and logout redirects. Confirm `Cache-Control: private, no-store`, no cache HIT or Age from Cloudflare, and no private data on a second request from an unsigned jar. Check the Cloudflare cache rule directly. On iPhone and Android, open a signed-in report, navigate away, then use Back and Forward before and after logout. Repeat after expiry. In airplane mode, reopen the installed app after leaving the report. The expected result after logout, expiry or an offline reopen is no private issue text. Browser history and OS snapshots are distinct from HTTP caches. Record what each phone actually shows, including any stale screen during restore. Keep these checks separate from unit tests, and keep the cache guarantee scoped to the controls and evidence above.

## 4. Smallest slice and split

Keep one issue's ID, title, status and body. Defer comments, clickable evidence links, the service worker, offline handling, push, passkeys and the native wrapper. The manifest and icons are the install surface. [Chrome install criteria](https://web.dev/articles/install-criteria). Approvals and answers stay in chat under forge-1673.

The formatted estimate is about 345 non-test lines across both changes. Split now. PR A delivers a working sign-in, generic session page, server record and logout. PR B adds the issue read, report and install assets on top of PR A. Each can be reviewed with its own tests. Count formatted additions and changed lines. Stop and report before exceeding 250 non-test lines in either PR. Preserve readable checks instead of compressing security code to fit.

## 5. Red-first tests and CI

Drive `createConfiguredWorker().fetch()` with Request and Response objects, separate cookie jars, a controllable clock and the real `CodeRedemption` implementation behind a test binding. Use the existing Clerk RS256 token/JWKS fixture and instrument exchanges, durable operations and Project lookups. For PR B, seed one issue through the existing test device-command driver and use `browserStorage` for the Project. No fixture should import a feature module absent on the tested base. [Clerk fixture](https://github.com/harshanandak/forge/blob/8c0273e00e41781135b1bf4ec393179c5dfbe0f6/test/adapters/clerk/jwt-fixture.ts#L10-L34), [redemption fixture](https://github.com/harshanandak/forge/blob/8c0273e00e41781135b1bf4ec393179c5dfbe0f6/test/cloud/auth/redemption.test.ts#L35-L90), [Project fixture pattern](https://github.com/harshanandak/forge/blob/8c0273e00e41781135b1bf4ec393179c5dfbe0f6/test/cloud/auth/device-browser.test.ts#L77-L149).

| Four starter reds | Expected red on pinned main | Green assertion |
| --- | --- | --- |
| A: `report sign-in is bound and single-use` | Sign-in returns 404 instead of 302 | Valid owner obtains one session. Wrong or missing pending proof, expired proof, replay, and parallel callbacks fail or produce at most one exchange and record. Exercise wrong subject, issuer and audience |
| B: `report requires owner` | Anonymous issue GET returns 404 instead of 401 | Existing and missing IDs both get generic 401 without Project lookup. Check bad MAC, missing record, expiry and changed owner or project |
| B: `report renders escaped owner data` | Sign-in returns 404 instead of 302 | Owner sees only the requested issue's escaped fields. Verify CSP, clipping, 404 for a missing issue, rejection of POST, and zero issue writes |
| B: `report install assets stay public and inert` | Manifest returns 404 instead of 200 | Manifest, MIME types and icon dimensions are correct. The assets contain no issue data and do not reach Project. Service worker and registration routes return 404 |

**Additional tests.**

- PR A checks `Max-Age=900`, cookie flags and server deadline. Copy the valid cookie into another jar and show that both jars initially have a session. In separate runs, sign out in the first jar or advance the clock to expiry. The second jar loses the session in both cases. Read back deletion after logout, after the expiry alarm and after an expired read with the alarm delayed. Check cross-origin logout refusal, idempotent logout and deletion failure.
- PR A tries all 3 mixed pairs of device, lane and report state in both orders, plus all 3 together and an ordinary OAuth state mixed with report state. Assert refusal before exchange or storage, including duplicate report states. Exercise a valid single legacy state through existing tests.
- PR A replays a valid report cookie without the existing route's credentials across every OAuth, discovery, device, lane, command, state, dump, holder and status path listed above. Compare with an otherwise identical request without the cookie. Public responses may still succeed. No extra authority, private data, privileged write, session lookup or report cookie issuance.
- PR B copies the cookie to a second jar and reads the report, then verifies refusal after logout and expiry. Pause the Project fetch after initial authorization, advance the clock to expiry or delete the record, resume the fetch, and assert the Worker discards its body. Also check signed-in empty, malformed, oversized and duplicate issue inputs. Test no-store on successful HTML, errors, redirects and the internal Project reply, and assert no direct public access to either internal path.

Add the tests first. In the existing Cloud claims job, run the starter tests once against the pinned source in a disposable checkout, with the new test fixtures and the installed dependencies. Require the named assertion failures and the specified actual and expected responses. PR B also runs its starter cases against its actual base containing PR A. On that base the anonymous issue request gets the generic 200 session page, the signed-in flow gets the session page without issue text, and the manifest returns 404. Require those specific failures. Restore the PR source and run the full suite for that PR once, including the additional security cases. A load error, timeout or wrong failure fails CI. Keep the regular unit suite and production dry-run bundle. No raised timeouts, retries or skips. [Existing CI counterfactual pattern](https://github.com/harshanandak/forge/blob/8c0273e00e41781135b1bf4ec393179c5dfbe0f6/.github/workflows/cloud.yml#L111-L142).

## 6. Files, line budget and phone install

| PR | File | Proposed formatted non-test lines |
| --- | --- | ---: |
| A | `cloud/src/auth/report-session.ts` | 108 |
| A | `cloud/src/adapters/workers-oauth/report-session-store.ts` | 50 |
| A | `cloud/src/adapters/workers-oauth/redemption.ts` | 8 |
| A | `cloud/src/adapters/workers-oauth/compose.ts` | 21 |
| A | `cloud/src/report-http.ts` | 19 |
| A | `.github/workflows/cloud.yml` | 18 |
| **A total** | Session foundation | **224** |
| B | `cloud/src/report-app.ts` | 68 |
| B | `cloud/src/report-icons.ts` | 2 generated data lines |
| B | `cloud/src/adapters/workers-oauth/compose.ts` and `cloud/src/auth/report-session.ts` | 16 |
| B | `cloud/src/project.ts` | 21 |
| B | `cloud/src/issue-commands.ts` | 1 to export `lazyViews()` |
| B | `.github/workflows/cloud.yml` | 13 |
| **B total** | Issue report and install assets | **121** |

Test files are `test/cloud/auth/report-session.test.ts` and `test/cloud/auth/report-fixture.ts` in A, and `test/cloud/auth/report-app.test.ts` in B. The estimates include CI changes. Measure after formatting. Drop no control to fit the 250-line stop point.

1. On iPhone, open the deployed `/app/` in Safari. Tap Share, then Add to Home Screen. Enable Open as Web App if shown and tap Add.
2. On Android, open the deployed `/app/` in Chrome. Open the menu, tap Add to Home screen, then Install.
3. Open Forge from its icon. Enter an issue ID and sign in to Clerk as the configured owner when prompted. Use Sign out to revoke the current Forge session, including any copies of its cookie. [Apple install steps](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/27/ios/27), [Chrome install steps](https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DAndroid).

## 7. Rejected options

| Option | Reason |
| --- | --- |
| Stateless signed session cookie | A copied cookie would remain usable after Forge logout until its signed expiry. A live server record makes logout revocable |
| Device or lane cookie, API token or URL token | The existing browser cookies bind pending flows. Existing API tokens carry separate authority. URL tokens can escape through history or logs |
| New store or a report table in Project | An isolated object in the existing binding already supplies a durable record and alarm. A Project table adds migration and alarm coordination |
| Comments, Markdown and extracted links | The 4 issue fields deliver a complete first read with one existing query and a plain-text template |
| Inert service worker and offline cache | The manifest is the chosen install surface. A service worker adds scope and update management. Private cached copies would undermine revocation |
| Approval buttons, push and native packaging | The owner acts in chat. This slice establishes that the owner can open and read one report on a phone |
