# Forge Hub

## Running the service

`forge-hub serve` runs the hub until it receives SIGTERM or SIGINT, then exits
with code 0. The service supports the Slack and off chat adapters; it refuses a
Telegram selection before opening any resource.

Startup reserves worker ownership, starts chat, reconciles pending effects and
only then listens. `GET <basePath>/healthz` answers 200 once the listener is up.
Shutdown stops accepting connections, aborts pending requests and waits for
each request and stream cancel to finish, then closes the remote handler, the
core and the database. Further signals are ignored until the database closes,
and a stop during startup skips listening. A failed start (an occupied port, a
rejected chat start or a failed reconciliation) or a server error runs the same
cleanup, prints `could not run hub service` and exits 1.

The server parses at most 1,000 header fields per request. The limit is fixed
before the listener starts and cannot be changed afterwards, so the Host check
always sees the same cutoff as the parser.

## Recovering inbox items after a legacy project bind

If a session was bound to the wrong project before project checks were added,
resume that session with `hello` and then open an inbox in the item's original
project. The hub returns queued items and non-chat deliveries to their original
queue when the old session has no retained reply obligation or unresolved post.

For prior chat deliveries or sessions with retained reply work, preserve the
original rows. An operator can recover the original session binding while the
hub is offline. Take a verified database backup, reconcile any unresolved chat
posts, and confirm that the session has no attached work in other projects and
that its owner still belongs to the original project. Correct the session's
project without changing any item, delivery or reply obligation.

## Windows data directory

Use `%USERPROFILE%\.forge-hub\data` under the Windows account that runs the
hub. Expand `%USERPROFILE%` to the account's profile path before writing the
absolute path into `dataDir` in the hub configuration. The data directory
must have an owner-only DACL, and the hub checks the full path up to the volume
root for reparse points, untrusted owners, and grants that allow replacement.
