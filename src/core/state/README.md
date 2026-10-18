# State owner

`StateOwner` accepts the locked `SqlDatabase` and `ClockPort` ports. `initialize()` is an explicit write; construction and reads do not initialize anything. `client(namespace, actor)` returns only the four methods in `StateClient`, with namespace and actor captured. It never exposes a connection.

`put` atomically checks the expected revision, checks any lease fence on the owner's clock, writes the record, appends its event, and saves the idempotent result. A reused request ID with different input is refused. Acquisition takes a holder and request ID, without a generation. Renewal, release and fenced writes require the current generation and the same actor and session. Released and expired generations are never reused. A historical acquisition replay cannot revive authority.

The synchronous database adapter rejects nested and asynchronous transaction bodies. Both runtime bindings normalize an absent row to `undefined`. Native driver failures propagate; they are never blindly retried or swallowed.

Reviewed first-party registrations supply migrations, table names (prefixed `domain_`), and a review digest. The owner persists each table's namespace and review identity. Outside clients have no registration method. A different registration cannot take over an existing table. The registration API is a trusted assembly boundary; a digest string alone is not code admission.

`export()` asks the storage adapter to create a consistent complete SQLite image using the selected runtime's `VACUUM INTO`. The snapshot keeps its existing records, history, receipts, lease and domain metadata, read from that image, and adds the database image as base64 so JSON transport remains lossless. It also records `eventHighWaterMark` from the same image. Restore requires event sequences exactly 1 through that mark before replaying records, receipts and leases; a missing or invalid mark, a gap, duplicate or truncated history refuses the whole snapshot. Snapshots exported without the mark must be exported again. Binary cells and large integers survive without conversion through INSERT statements.

`restore()` requires an initialized empty store with matching reviewed registrations, schema and known migration versions. The adapter writes an exclusive private temporary file beside the target, fsyncs it, opens it read-only and checks integrity, foreign keys and the owner's schema and identity requirements before touching the live store. The owner releases imported leases in the staged copy while retaining counters and receipts. Final recovery approval runs under the target's SQLite writer lock. A restore fence blocks other adapter handles; handles whose file identity changes must reopen.

The adapter closes the live connection, refuses lingering SQLite sidecars, retains and fsyncs the previous database, checks the staged file's identity and digest, then atomically renames it over the target. It reopens and verifies the replacement before releasing the fence. Failure rolls back to the retained previous file; if rollback itself fails, the store remains closed and fenced. Successful file restores retain `<store>.previous-<random>` for offline recovery; a process interrupted during replacement leaves its `.restore-lock` fence for explicit offline recovery after all connections stop. In-memory handles use the same validated staged image and retain their old connection through verification. POSIX directories are fsynced; Windows uses file fsync and same-directory rename because Node does not expose directory fsync there.

`withState` closes owned handles on success and failure and leaves borrowed handles open. The storage adapter releases partial opens and closes idempotently.

The recovery adapter binds approval to file identity and content, pins open descriptors, retains a separate exclusive private copy, and checks the source, backup, recovery copy and sidecars through the supplied commit verifier. Keep the retained copy for recovery. `hardenPrivatePaths` applies and reads back a protected owner-only Windows ACL through `ProcessPort`; other systems use private file modes. Pass their verifier to `restore` for the final fenced approval check.

Filesystem classification is pure over host signals; its adapter rejects recognized cloud and network paths. Missing platform probes produce a once-per-process stderr warning, rather than asserting a local disk. Hosts should supply drive and mount evidence to `classifyFilesystem` when available.

## Integration and evidence

The compiled modules are present in the tarball. Assembly must add public package subpath exports for the owner and storage adapter; this lane does not own `package.json` or the root entry point. The fixture deliberately imports the installed tarball's compiled modules, never a source checkout.

`test/node-fixtures/state/packed.test.ts` builds, packs once, installs, runs sixteen journeys under the current Node and Bun, then removes individual fixes in the installed copy and requires the corresponding journey to fail. Set `STATE_NODE26` to an additional Node executable to run the third runtime in one invocation. The filesystem counterfactual replaces the linear scan with the old backtracking expression and must time out on the hostile suffix; the normal journey completes.

Initialization rejects unknown applied migration IDs and nonzero schema versions with `NewerStoreError` before executing schema or data writes. Recovery copies fsync their contents and, on POSIX, their parent directory before commit; Windows skips directory fsync because Node does not support it.

Baseline and migrated stores are compared structurally and by complete snapshots. Fault injection places competing calls at transaction entry and moves authority immediately before a fenced transaction. Windows ACL tests modify and verify only disposable files.
