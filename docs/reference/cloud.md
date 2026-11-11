# Forge cloud claim server

A Cloudflare Worker with one SQLite Durable Object per project. It decides who holds a lease on a
subject. The code is in `cloud/`.

## Routes

Every route is `/p/<projectId>/<route>` and needs `Authorization: Bearer <token>`, except `loginstart` and `loginpoll`.

| Route                                        | Method    | Token  | What it does                                                                                                                                                                  |
| -------------------------------------------- | --------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claim`, `renew`, `release`                  | POST      | device | Change a lease. Each carries a `requestId`; a retry returns the right result.                                                                                                 |
| `command`                                    | POST      | device | Typed issue commands for `FORGE_CLOUD_PROJECT`; body up to 512 KiB. See below. OAuth and admin tokens get 403.                                                                |
| `holder?subject=...`                         | GET       | device | Read a lease.                                                                                                                                                                 |
| `loginstart`, `loginpoll`                    | POST      | none   | Device login for the one project named by `FORGE_CLOUD_PROJECT`. See below.                                                                                                   |
| `/device`, `/device/approve`, `/device/deny` | GET, POST | none   | Not under `/p/`. The owner's browser approval of a device login. See below.                                                                                                   |
| `devices`                                    | POST      | admin  | Issue a device token: `{ device, session?, agent?, harness?, ttlMs }`. The token is shown once.                                                                               |
| `revoke`                                     | POST      | admin  | Revoke a device token by id. It is refused on its next request.                                                                                                               |
| `status`                                     | GET       | admin  | Whether the project has a database yet.                                                                                                                                       |
| `dump`                                       | GET       | admin  | The project as JSON: issues, leases, events and receipts. No tokens, no hashes. `?cursor=start` dumps in pages (see below).                                                   |
| `restore`                                    | POST      | admin  | Write a dump into an empty project. Body up to 8 MiB (`RESTORE_TOO_LARGE` over it). A row that is not valid state is refused as `RESTORE_INVALID_ROW` and nothing is written. |

A command is `{ requestId, op, input, context, dryRun? }` and nothing else, at most 32 levels and 5,000 values. `context` is closed too: the device comes from the token and the project from the server, so a different device or project, a project root, and a namespace, clock or variant are refused. Only the seven `issue.*` operations are known (others are `UNKNOWN_COMMAND`, 404); `issue.show` and `issue.list` run as reads and the other five are still refused as `INPUT_INVALID` (not yet supported). `dryRun` is `UNAVAILABLE` (503). Nothing is written.

`issue.show` takes `{ id }` and returns the issue as the local command shows it, with its current `revision` and a `lease` only while one is live. It needs the Worker var `FORGE_CLOUD_ID_PREFIX`, the issue id prefix (lowercase letters, digits and hyphens, at most 32 characters); a missing or invalid value is `UNAVAILABLE` (503) and no work table is read. Status codes: a missing issue is `NOT_FOUND` (404, exit 3), bad input or an unknown id prefix is `INPUT_INVALID` (400, exit 6), a stored issue that fails its schema is `INTERNAL` (500, exit 1). The response is at most 1,048,576 bytes of UTF-8 for the whole envelope; a larger one is `UNAVAILABLE` (503), "response too large".

`issue.list` takes `{ parent?, kind?, label?, labels?, status?, createdSince?, ready?, limit? }` (limit 1 to 1,000, default 1,000) and returns `{ items, truncated }` as the local command does: the matching issues, open and closed, in key order (`work-10` before `work-2`), at most `limit` of them, with `truncated` true when more matched. Filters work as in the local command: `parent` takes a current or historical prefix alias or `none`, `label` and `labels` combine with AND, and `createdSince` includes its own time. `ready: true` keeps open issues whose direct dependencies are all closed (a missing one blocks) and that no live lease holds; it does not apply `labelOrder`. It uses the same prefix setting, checks, status codes and 1 MiB cap as `issue.show`; a response over the cap is refused, never shortened. Reads are bounded before any issue body loads: a project with more than 10,000 issues or more than 8 MiB of stored issue JSON is `UNAVAILABLE` (503), "Issue list is over its read budget", whatever `limit` is. Parity with the local command holds within these limits. Every stored issue is checked before any filter or limit, so a corrupt issue is `INTERNAL` (500) whatever the filter; a lease is read only for the issues that are still candidates.

A whole dump (`GET dump`) is one response for a small project: up to 3 MiB stored, 10,000 rows per table and 262,144 characters per value. A larger project is refused as `DUMP_TOO_LARGE` (413); a project with more than 10,000 rows in a table cannot be dumped at all yet (see the limits below).

## Device login

`POST loginstart { device }` returns `{ ok, device_code, user_code, expires_in: 600, interval: 5, verification_uri: "/device", project, device }`. `POST loginpoll { device_code }` returns `{ ok: false, error }` (`authorization_pending`, `slow_down` with a longer `interval`, `expired_token`, `access_denied`, `invalid_grant`) until an approved challenge yields `{ ok: true, credential }`, once. The credential is a JSON string `{ format: "forge/device-credential/1", id, token, device, expiresAt }` for a 30 day device token (`LOGIN_TTL_MS`). Responses are `no-store`.

Neither route needs a bearer. They serve only the project named by `FORGE_CLOUD_PROJECT`, which must already be provisioned, and need the secret `DEVICE_LOGIN_HMAC_KEY` (random, base64url, at least 32 bytes) plus the owner vars `CLERK_ISSUER`, `FORGE_OWNER_SUBJECT` and `CLERK_CLIENT_ID`. A missing setting returns `AUTH_CONFIG_UNAVAILABLE` (503) on these two routes only. Starts are limited to 5 per address and 30 per project in a 60 second window (`rate_limited`, 429), and to 1,024 live challenges (`capacity_exceeded`, 429). Challenge state is one private `domain_cloud_login` row and is never in a dump. A poll that consumed its challenge and then failed to issue needs a fresh login.

### Owner approval in the browser

The owner opens `GET /device` (no bearer; the page sets a host-only `__Host-forge_device` cookie, kept if the browser already has a well formed one, so a second tab does not break the first). The cookie is also the form's CSRF proof. `POST /device` types the user code and previews the project and device; the page carries two single-use tickets, one for Approve and one for Deny, bound to this browser, this challenge and that action. `POST /device/approve` or `POST /device/deny` needs a same-origin `Origin` header, the cookie and the matching ticket. It saves a one-use state (`forge-device.` plus 43 random characters, kept only as a hash), a PKCE verifier and the user code in the private `domain_cloud_login` row for 10 minutes, sets a fresh `__Host-` cookie for that one state (kept only as a hash), and answers 302 to Clerk. A page cookie alone, stolen or planted, cannot finish the redirect. A browser holds one record per challenge (a new preview or decision replaces it), a challenge holds at most 3 records, and the project at most 256. Clerk returns to the existing `GET /callback`: a state starting `forge-device.` goes to the project object, never to the OAuth callback; every other state keeps its current path. No new Clerk redirect URI is needed. The callback consumes the state, checks the state's own cookie, claims the Clerk code once, verifies the ID token, requires the exact owner (`CLERK_ISSUER` plus `FORGE_OWNER_SUBJECT`) and then approves or denies. It shows `approved` or `denied` and never a token; only the polling device receives one.

Refusals: 400 `invalid_request` (CSRF, origin, or a missing, used or wrong ticket), 400 `invalid_code` (one answer for unknown, consumed, expired and malformed codes), 429 `rate_limited` (five failed lookups per address and 30 per project in 60 seconds, counted in one step with the lookup so overlapping requests share the budget, or the engine's five failed decisions per owner), 400 `access_denied` (state unknown, expired, replayed, or wrong browser), 401 `AUTH_INVALID` (Clerk proof refused), 403 `AUTH_FORBIDDEN` (a different Clerk user). The Worker also needs `CLERK_REDIRECT_URI`, `FORGE_API_RESOURCE`, `OAUTH_TIMEOUT_MS` and the `CODE_REDEMPTION` binding for these pages; a missing one is `AUTH_CONFIG_UNAVAILABLE` (503).

## Log in from the CLI

`forge cloud login --origin <https-origin> --project <project>` runs the device flow for one machine. The operation is declared by the `forge/cloud` block, so enable it first (`blocks: { cloud: { source: { builtin: forge/cloud } } }` in `.forge/config.yaml`). It is for a person at a terminal and is not an MCP tool. The first login needs both flags; later logins use the binding in `.forge/cloud.json`, and login never changes an established binding (`INPUT_CONFLICT`, exit 4, before any request). The checkout needs `.forge/project.json`; login never creates it (`CONTEXT_MISSING`, exit 6).

The command prints the verification address (`<origin>/device`) and a code on stderr, then polls no faster than the server's interval until the owner approves, denies or the code expires. Stdout carries one final result: origin, project, device, token id and expiry. The token and the device code are never printed. Ctrl-C cancels the wait. No wait runs past the code's own lifetime: a long `slow_down` interval is cut to the time left, a poll that crosses the deadline is refused as expired, and a code that expires ends the login as `LOGIN_EXPIRED`. A poll that fails in transit ends the login and is not retried, because it may have used the one-time code; run login again.

The credential is saved in `~/.forge/cloud/credentials.json`, a private file under the same lock and atomic replace as account files. It is checked for the current owner, private modes, a plain file with one link and, on Windows, an owner-only ACL and the current user (or the Administrators group) as owner, both before it is read or replaced and again after it is written. Any failure, including a filesystem error such as a file with no read permission, is `ACCOUNT_INTEGRITY`. A token is found only under its exact origin, project id and project name. Login keeps the previous entry until the new one reads back. If the write or the read back fails, even after the file was already replaced, it puts the previous bytes back through the same checked write. A destination that is unsafe is never overwritten: the previous document is then kept in `credentials.backup.json` beside it and the login fails with `ACCOUNT_INTEGRITY`. The binding is written last, only after the credential reads back.

`.forge/cloud.json` holds only the schema, the project id, the origin and the project name, no secret, so it is committed and travels with the project; login stays the only thing that writes it. The assembly check `cloudBinding` reads it from the project's manifest root, so nested folders and linked worktrees give the same answer. A binding that is malformed, unsafe or for another project id is refused, and so is a missing project identity. With no binding, a saved credential for this project id (live or expired) is `INPUT_CONFLICT`, exit 4: run `forge cloud login` again. The check never writes a binding or a credential and creates no folder.

Start and poll send no bearer token, follow no redirect and have a deadline and a body limit. A device id longer than 128 characters, or one the Worker would refuse, is sent as `device-` plus the SHA-256 of the full local id; the saved entry keeps both ids, and anything that compares holder identity later must apply the same mapping. Nothing in this command routes another command to the cloud.

## Dump and restore in pages

Use pages when a project is too big for one dump. The limits are counted in SQL, not by loading rows.

1. `GET dump?cursor=start` returns page 0. Each page is `{ format: "forge-cloud-dump-page/1", page, last, next, tables }` and holds at most about 4 MiB of rows. A row is never split.
2. While `last` is false, `GET dump?cursor=<next>` (URL-encode `next`) returns the following page. Keep every page. If the project is written to between two pages, the next page is refused as `DUMP_CHANGED` (409): start again from `cursor=start`.
3. `POST restore` each page, unchanged and in order, into an empty project. A page other than the next one is refused as `INPUT_INVALID`. Earlier pages only stage rows. The last page runs the same row checks as a whole restore over everything staged (`RESTORE_INVALID_ROW` names the table and row) and then provisions the project.

Limits: a project over 8 MiB stored, or with more than 10,000 rows in any table, is refused as `DUMP_TOO_LARGE` at page 0. A restore is checked after every staged page, in the same transaction, so the page that crosses either limit is refused (`RESTORE_TOO_LARGE`) and nothing stays staged. The last page's row checks read 16 rows at a time by key and parse events once, in sequence order, with `JSON.parse`. They retain scalar revisions and digests per record and request, current lease state, and receipt read-set and fence metadata until its event. Memory therefore grows with distinct keys, request ids and their scalar metadata, but does not retain parsed record values or the whole event history. Receipts are paged once for that metadata and again for the final checks. The existing row and byte limits stay in place; changing them is a separate decision after batching is proven (forge-1040). The conformance run sets smaller values in `wrangler.test.jsonc`; `wrangler.example.jsonc` sets none.

Staged rows are never served: a project is not provisioned until the last page, and every device route stops at that check before it runs any SQL.

To abandon a half restore, stop. To retry, send page 0 again: it clears the staged rows. Any refused restore request (an out-of-order page, a page over a limit, a bad document or a body that is too large) also clears them, so the next try starts at page 0. A whole `POST restore` clears them too.

A device token acts only as its own device. The admin token is the Worker secret `ADMIN_TOKEN`.

## Deploy

The owner runs these steps. Replace angle-bracket placeholders; `<worker-origin>` is an HTTPS origin without a trailing slash. Use an existing Cloudflare login with Workers/KV write access. Run every command from `cloud/` with the git-ignored `wrangler.local.jsonc` (copied from `wrangler.example.jsonc`) as `--config`; a bare `wrangler deploy` finds no `wrangler.jsonc` and stops. Commit no real value.

1. **Clerk OAuth application.** In the Clerk admin console, open **OAuth applications** and create or open an application. Set its redirect URI to `<worker-origin>/callback`, make it a public client and require PKCE S256; no client secret is used. Allow `openid profile email` scopes (the Worker currently requests `openid`). Copy the client ID from **Application credentials** and the Frontend API URL from **API keys → Show API URLs**. Clerk organizations are informational only and grant no project access. See [Clerk's public-client guidance](https://clerk.com/docs/guides/configure/auth-strategies/oauth/how-clerk-implements-oauth).
   If the Clerk instance requires organization membership, a new user must create or join an organization during sign-up before consent; organizations still grant no project access.

2. **KV namespace.** From `cloud/`, install its pinned tools:

   ```sh
   bun install --frozen-lockfile
   ```

   Copy `wrangler.example.jsonc` to `wrangler.local.jsonc` and set `account_id` and `name` first: the commands below read them through `--config`. On a first setup, create the namespace once:

   ```sh
   bun x wrangler kv namespace create OAUTH_KV --config wrangler.local.jsonc
   ```

   An existing deployment keeps its own namespace; find its id with:

   ```sh
   bun x wrangler kv namespace list --config wrangler.local.jsonc
   ```

   Set the `OAUTH_KV` id in `wrangler.local.jsonc`. Keep the rest of the example as it is: the preflight refuses any difference outside `account_id`, `name`, `vars` and that id.

3. **Public vars.** Set each var in `wrangler.local.jsonc`. All are required except `FORGE_OAUTH_REDIRECTS`; without `FORGE_OWNER_SUBJECT` or `FORGE_CLOUD_PROJECT`, device login and `/command` refuse, without `FORGE_CLOUD_ID_PREFIX`, `issue.show` answers 503, and the preflight stops the deploy in each case:

   | Name                    | Example shape                               | What `readOAuthConfig` checks                                                                                 | Classification |
   | ----------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------- |
   | `CLERK_ISSUER`          | `<frontend-api-url>`                        | HTTPS origin only, optionally one trailing slash                                                              | Not secret     |
   | `CLERK_CLIENT_ID`       | `<client-id>`                               | 1–256 printable ASCII characters, excluding spaces                                                            | Not secret     |
   | `CLERK_REDIRECT_URI`    | `<worker-origin>/callback`                  | Exactly the incoming request origin plus `/callback`                                                          | Not secret     |
   | `FORGE_API_RESOURCE`    | `<worker-origin>/p/<project-id>`            | HTTPS URL; a path is allowed                                                                                  | Not secret     |
   | `OAUTH_TIMEOUT_MS`      | `5000`                                      | Decimal integer string from 1 through 2147483647, no leading zero                                             | Not secret     |
   | `FORGE_OAUTH_REDIRECTS` | `<https-redirect-url>,<https-redirect-url>` | Optional comma-separated HTTPS URLs, no credentials, query or fragment; any bad entry makes OAuth unavailable | Not secret     |
   | `FORGE_OWNER_SUBJECT`   | `<owner-subject>`                           | `user_` plus alphanumerics; owner must match this subject and `CLERK_ISSUER` exactly                          | Not secret     |
   | `FORGE_CLOUD_PROJECT`   | `<project-name>`                            | The one provisioned project that login and `/command` serve                                                   | Not secret     |
   | `FORGE_CLOUD_ID_PREFIX` | `<id-prefix>`                               | The work block's `idPrefix` rule: lowercase letters, digits and single hyphens, 1–32 characters               | Not secret     |

   The preflight runs the Worker's own rules for these vars, at the origin of `CLERK_REDIRECT_URI`. It cannot know the deployed origin, so the smoke checks below verify the real one.

   Every HTTPS value above rejects credentials, query strings, fragments, whitespace and backslashes. Registration accepts only loopback redirects (`http` on `127.0.0.1`, `[::1]` or `localhost`) and exact matches of `FORGE_OAUTH_REDIRECTS`; anything else is refused with `REGISTRATION_INVALID` before the rate limiter counts it. Metadata uses the callback origin, not the Host header. No Clerk secret key is needed or used; never put one in `vars`.

4. **Deploy.** First prepare generated validators from the repository root:

   ```sh
   bun install --frozen-lockfile
   ```

   ```sh
   bun run gen
   ```

   Return to `cloud/`. Two secrets are required, and their values are never printed. `DEVICE_LOGIN_HMAC_KEY` (random base64url, at least 32 bytes) is needed for device login, which refuses with 503 without it. `ADMIN_TOKEN` is needed for `status`, `devices`, `dump` and `restore`. A redeploy keeps both: a new `DEVICE_LOGIN_HMAC_KEY` voids pending device approvals and a new `ADMIN_TOKEN` voids the saved one. Rotating is its own decision, not a deploy step; to rotate on purpose, run that secret's command below alone, with no device approval pending.

   **First setup only.** If the Worker does not exist yet, Wrangler offers to create it; accept. Name a token file for this Worker, so another Worker's saved token is never overwritten:

   ```sh
   node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))" | bun x wrangler secret put DEVICE_LOGIN_HMAC_KEY --config wrangler.local.jsonc
   node scripts/set-admin-token.mjs --config wrangler.local.jsonc --token-file ~/.forge-cloud/<worker-name>.token
   ```

   **Redeploy.** Skip both commands. Record the current version (`bun x wrangler deployments list --config wrangler.local.jsonc`) and keep a private dump first. Then run the preflight. It refuses placeholders, a missing var or secret name, and an `OAUTH_KV` id that is not an existing namespace, before anything is uploaded:

   ```sh
   node scripts/preflight.mjs --config wrangler.local.jsonc
   ```

   Deploy only after it passes, never with the example or the CI-only `wrangler.test.jsonc`:

   ```sh
   bun x wrangler deploy --config wrangler.local.jsonc
   ```

   Expect a deployed Worker URL. Durable Object class migrations `v1`, `v2-code-redemption` and `v3-registration-limits` apply automatically on deploy; there is no manual migration command. `set-admin-token.mjs` saves its secret to the token file you named, without printing it. For authenticated curls below, prepare private curl config files containing the appropriate `Authorization` header; never put token values on the command line or print their files. Keep response files private too.

5. **Smoke checks.** Start with metadata:

   ```sh
   curl -sS -i '<worker-origin>/.well-known/oauth-authorization-server'
   ```

   Expect 200 JSON including `{"issuer":"<worker-origin>","authorization_endpoint":"<worker-origin>/authorize","token_endpoint":"<worker-origin>/oauth/token","registration_endpoint":"<worker-origin>/register"}`.

   ```sh
   curl -sS -i '<worker-origin>/.well-known/oauth-protected-resource'
   ```

   Expect 200 JSON `{"resource":"<api-resource>","authorization_servers":["<worker-origin>"]}`, matching `FORGE_API_RESOURCE`.

   If a var is missing in a bad deploy, the same request below returns a visible config refusal; do not remove a live var just to test it:

   ```sh
   curl -sS -i '<worker-origin>/.well-known/oauth-authorization-server'
   ```

   With only `CLERK_ISSUER` missing, expect 503 `{"error":{"code":"AUTH_CONFIG_UNAVAILABLE","variable":"CLERK_ISSUER","message":"OAuth configuration unavailable"}}`. Device-token and admin routes bypass OAuth config and keep working:

   ```sh
   curl -sS -i --config '<admin-curl-config>' '<worker-origin>/p/<project-id>/status'
   ```

   Expect 200 `{"ok":true,"value":{"initialized":true}}` for a provisioned project (`false` before provisioning).

   ```sh
   curl -sS -i --config '<device-curl-config>' '<worker-origin>/p/<project-id>/holder?subject=deploy-smoke'
   ```

   With an existing unexpired device token for this project, expect 200 `{"ok":true,"value":null}` for an unused subject, or a lease object. This is the working project path.

   The admitted project (`FORGE_CLOUD_PROJECT`) must exist. On a first setup with an isolated Worker and config, `POST devices` with the admin config provisions it. On an existing deployment, check `status` and keep its binding and credentials; never point the live Worker at a disposable project. These unauthenticated checks show only that the routes answer and refuse correctly:

   ```sh
   curl -sS --output '<private-login-response-file>' --write-out 'HTTP %{http_code}\n' -H 'Content-Type: application/json' --data '{"device":"deploy-smoke"}' '<worker-origin>/p/<project-id>/loginstart'
   curl -sS -i '<worker-origin>/device'
   curl -sS -i -X POST -H 'Content-Type: application/json' --data '{}' '<worker-origin>/p/<project-id>/command'
   curl -sS -i -X POST -H 'Content-Type: application/json' --data '{}' '<worker-origin>/p/<other-project>/command'
   ```

   Expect 200 with `device_code`, `user_code`, `expires_in` and `verification_uri` (keep that file private; it counts toward the five starts per address per minute); then 200 HTML; then 401 `AUTH_REQUIRED`; then 403 `AUTH_FORBIDDEN`. The command handler only refuses until forge-1227, and owner approval in the browser is not exercised here. Treat both as unverified unless you test them separately.

   Register one public client using the real client's callback URI:

   ```sh
   curl -sS --output '<private-registration-response-file>' --write-out 'HTTP %{http_code}\n' -H 'Content-Type: application/json' --data '{"redirect_uris":["<client-redirect-uri>"],"token_endpoint_auth_method":"none"}' '<worker-origin>/register'
   ```

   In a fresh quota window expect 201 JSON including `client_id` and `redirect_uris`. Retain that client for login. Then exercise the same-IP ceiling:

   ```sh
   for attempt in 1 2 3 4 5; do curl -sS --dump-header - --output '<private-burst-response-file>' --write-out 'HTTP %{http_code}\n' -H 'Content-Type: application/json' --data '{"redirect_uris":["<client-redirect-uri>"],"token_endpoint_auth_method":"none"}' '<worker-origin>/register'; done
   ```

   After five admitted registrations total from this IP in a fixed UTC hour, expect 429 `{"error":{"code":"REGISTRATION_RATE_LIMITED"}}` with `Retry-After` seconds until the next hour; 100 global admissions also trigger it. Cloudflare supplies `CF-Connecting-IP`; do not spoof it. Bodies are capped at 8192 bytes, redirect lists at 5 entries and each URI at 512 code units; abandoned registrations expire after 86400 seconds. Wait for rollover before another registration, or reuse the retained client.

   Use an OAuth-capable MCP client to log in with that client ID, its registered redirect URI, S256 PKCE and the configured resource. Follow `/authorize`, choose Allow, sign in at Clerk and return through `/callback` to the client's redirect URI. The login check ends at a successful token exchange. If exchanging manually instead of letting the client exchange, save the one-use code and matching verifier in private files without trailing newlines, then run:

   ```sh
   curl -sS --output '<private-token-response-file>' --write-out 'HTTP %{http_code}\n' --data-urlencode 'grant_type=authorization_code' --data-urlencode 'client_id=<registered-client-id>' --data-urlencode 'redirect_uri=<client-redirect-uri>' --data-urlencode 'resource=<api-resource>' --data-urlencode 'code@<private-code-file>' --data-urlencode 'code_verifier@<private-verifier-file>' '<worker-origin>/oauth/token'
   ```

   Expect 200 JSON including `access_token` and `token_type: "bearer"`; do not print the response. Codes are single-use, failed exchanges burn them, and refresh grants are refused. Check OAuth project access using a private config with this token:

   ```sh
   curl -sS -i --config '<oauth-curl-config>' '<worker-origin>/p/<project-id>/holder?subject=deploy-smoke'
   ```

   Expect 200 `{"ok":true,"value":null}` for an unused subject when the token matches the configured owner issuer and subject. Another Clerk user, or an absent `FORGE_OWNER_SUBJECT`, must get 403 `AUTH_FORBIDDEN`. The owner's token on `GET /p/<project-id>/status` must get 401; all admin routes still require the admin token.

6. **Rollback.** From `cloud/`, select the version you recorded before the deploy:

   ```sh
   bun x wrangler rollback <version-id> --config wrangler.local.jsonc
   ```

   Expect the selected version to become active. A rollback swaps code only. It does not undo the SQL migrations a project applies when it first opens (`src/core/state/migrations.ts` and the cloud domain migrations registered in `cloud/src/project.ts`), stored data, KV clients and grants, claims, registration counters or a rotated secret. After new code has opened a project, an older binary may refuse the upgraded store and the project may break; restore your private dump into an empty project if so. Wrangler's Durable Object class migrations are separate: Cloudflare refuses rollback across them, so do not delete namespaces or migrations to force it. See [rollback limits](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).

7. **Known limits.** Links point to the originating reviews; issue IDs are tracked in Forge. [forge-1121 (registration residuals)](https://github.com/harshanandak/forge/pull/406): provider-invalid requests consume quota, fixed windows allow boundary bursts, shared or Worker-origin IPs affect quotas, and pre-existing clients retain their old TTL. [forge-1122 (replay revocation race)](https://github.com/harshanandak/forge/pull/404): a refused replay can race the winning token write, so its tokens may survive revocation, while the code still issues tokens at most once.

## Check a live Worker

```sh
CLOUD_BASE=https://<worker>.workers.dev CLOUD_LIVE=1 \
  CLOUD_ADMIN_TOKEN_FILE=~/.forge-cloud/forge-cloud-dev.token \
  bun conformance/conformance.ts main
```

Use the phase `latency` instead of `main` for claim p50 and p95 over 200 claims. `CLOUD_LIVE=1` skips only
the receipt-failure case, because the deployed Worker has no fault switch.

## Delete

From `cloud/`: `bun x wrangler delete --config wrangler.local.jsonc`. This removes the Worker and
all project data in its Durable Objects. Dump the projects first if you need them.
