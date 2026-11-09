# Forge cloud claim server

A Cloudflare Worker with one SQLite Durable Object per project. It decides who holds a lease on a
subject. The code is in `cloud/`.

## Routes

Every route is `/p/<projectId>/<route>` and needs `Authorization: Bearer <token>`.

| Route                       | Method | Token  | What it does                                                                                    |
| --------------------------- | ------ | ------ | ----------------------------------------------------------------------------------------------- |
| `claim`, `renew`, `release` | POST   | device | Change a lease. Each carries a `requestId`; a retry returns the right result.                   |
| `holder?subject=...`        | GET    | device | Read a lease.                                                                                   |
| `devices`                   | POST   | admin  | Issue a device token: `{ device, session?, agent?, harness?, ttlMs }`. The token is shown once. |
| `revoke`                    | POST   | admin  | Revoke a device token by id. It is refused on its next request.                                 |
| `status`                    | GET    | admin  | Whether the project has a database yet.                                                         |
| `dump`                      | GET    | admin  | The project as JSON: issues, leases, events and receipts. No tokens, no hashes.                 |
| `restore`                   | POST   | admin  | Write a dump into an empty project. Body up to 8 MiB (`RESTORE_TOO_LARGE` over it).             |

A dump is a single response with fixed caps (50,000 rows per table, 262,144 characters per value); paged export is tracked in forge-1020.

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
