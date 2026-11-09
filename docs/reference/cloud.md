# Forge cloud claim server

A Cloudflare Worker with one SQLite Durable Object per project. It decides who holds a lease on a
subject. The code is in `cloud/`.

## Routes

Every route is `/p/<projectId>/<route>` and needs `Authorization: Bearer <token>`.

| Route                       | Method | Token  | What it does                                                                                                                                                                  |
| --------------------------- | ------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claim`, `renew`, `release` | POST   | device | Change a lease. Each carries a `requestId`; a retry returns the right result.                                                                                                 |
| `holder?subject=...`        | GET    | device | Read a lease.                                                                                                                                                                 |
| `devices`                   | POST   | admin  | Issue a device token: `{ device, session?, agent?, harness?, ttlMs }`. The token is shown once.                                                                               |
| `revoke`                    | POST   | admin  | Revoke a device token by id. It is refused on its next request.                                                                                                               |
| `status`                    | GET    | admin  | Whether the project has a database yet.                                                                                                                                       |
| `dump`                      | GET    | admin  | The project as JSON: issues, leases, events and receipts. No tokens, no hashes. `?cursor=start` dumps in pages (see below).                                                   |
| `restore`                   | POST   | admin  | Write a dump into an empty project. Body up to 8 MiB (`RESTORE_TOO_LARGE` over it). A row that is not valid state is refused as `RESTORE_INVALID_ROW` and nothing is written. |

A whole dump (`GET dump`) is one response for a small project: up to 3 MiB stored, 10,000 rows per table and 262,144 characters per value. A larger project is refused as `DUMP_TOO_LARGE` (413); a project with more than 10,000 rows in a table cannot be dumped at all yet (see the limits below).

## Dump and restore in pages

Use pages when a project is too big for one dump. The limits are counted in SQL, not by loading rows.

1. `GET dump?cursor=start` returns page 0. Each page is `{ format: "forge-cloud-dump-page/1", page, last, next, tables }` and holds at most about 4 MiB of rows. A row is never split.
2. While `last` is false, `GET dump?cursor=<next>` (URL-encode `next`) returns the following page. Keep every page. If the project is written to between two pages, the next page is refused as `DUMP_CHANGED` (409): start again from `cursor=start`.
3. `POST restore` each page, unchanged and in order, into an empty project. A page other than the next one is refused as `INPUT_INVALID`. Earlier pages only stage rows. The last page runs the same row checks as a whole restore over everything staged (`RESTORE_INVALID_ROW` names the table and row) and then provisions the project.

Limits: a project over 8 MiB stored, or with more than 10,000 rows in any table, is refused as `DUMP_TOO_LARGE` at page 0. A restore is checked after every staged page, in the same transaction, so the page that crosses either limit is refused (`RESTORE_TOO_LARGE`) and nothing stays staged. The last page's row checks read 16 rows at a time by key and parse events once, in sequence order, with `JSON.parse`. They retain scalar revisions and digests per record and request, current lease state, and receipt read-set and fence metadata until its event. Memory therefore grows with distinct keys, request ids and their scalar metadata, but does not retain parsed record values or the whole event history. Receipts are paged once for that metadata and again for the final checks. The existing row and byte limits stay in place; changing them is a separate decision after batching is proven (forge-1040). The conformance run sets smaller values in `wrangler.test.jsonc`; `wrangler.jsonc` sets none.

Staged rows are never served: a project is not provisioned until the last page, and every device route stops at that check before it runs any SQL.

To abandon a half restore, stop. To retry, send page 0 again: it clears the staged rows. Any refused restore request (an out-of-order page, a page over a limit, a bad document or a body that is too large) also clears them, so the next try starts at page 0. A whole `POST restore` clears them too.

A device token acts only as its own device. The admin token is the Worker secret `ADMIN_TOKEN`.

## Deploy

From `cloud/`, with `CLOUDFLARE_ACCOUNT_ID` set and an existing wrangler login (free plan only):

1. `bun x wrangler whoami` shows the login, the account and the token scopes. It needs Workers write access.
2. `bun x wrangler deploy` deploys `wrangler.jsonc` (never `wrangler.test.jsonc`, which is for CI).
3. `node scripts/set-admin-token.mjs` sets the admin token. It is not printed; it is saved to
   `~/.forge-cloud/forge-cloud-dev.token`, readable by your user only. Run it again to rotate: the old token stops working at once.

## Check a live Worker

```sh
CLOUD_BASE=https://<worker>.workers.dev CLOUD_LIVE=1 \
  CLOUD_ADMIN_TOKEN_FILE=~/.forge-cloud/forge-cloud-dev.token \
  bun conformance/conformance.ts main
```

Use the phase `latency` instead of `main` for claim p50 and p95 over 200 claims. `CLOUD_LIVE=1` skips only
the receipt-failure case, because the deployed Worker has no fault switch.

## Delete

From `cloud/`: `CLOUDFLARE_ACCOUNT_ID=<id> bun x wrangler delete forge-cloud-dev`. This removes the Worker and
all project data in its Durable Objects. Dump the projects first if you need them.
