# State owner

`StateOwner` accepts the locked `SqlDatabase` and `ClockPort` ports. `initialize()` is an explicit write; construction and reads do not initialize anything. `client(namespace, actor)` returns only the four methods in `StateClient`, with namespace and actor captured. It never exposes a connection.

`put` atomically checks the expected revision, checks any lease fence on the owner's clock, writes the record, appends its event, and saves the idempotent result. A reused request ID with different input is refused. Acquisition takes a holder and request ID, without a generation. Renewal, release and fenced writes require the current generation and the same actor and session. Released and expired generations are never reused. A historical acquisition replay cannot revive authority.

The synchronous database adapter rejects nested and asynchronous transaction bodies. Both runtime bindings normalize an absent row to `undefined`. Native driver failures propagate; they are never blindly retried or swallowed.

Reviewed first-party registrations supply migrations, table names (prefixed `domain_`), and a review digest. The owner persists each table's namespace and review identity. Outside clients have no registration method. A different registration cannot take over an existing table. The registration API is a trusted assembly boundary; a digest string alone is not code admission.

`export()` takes a consistent read snapshot of complete records, events, idempotency receipts, lease counters and registered domain rows. Binary and integer cells use explicit lossless encodings. `restore()` requires an initialized empty store with matching reviewed table registrations. It runs in one transaction and imports lease counters as released, never as live authority. Its optional recovery verifier runs immediately before commit, so a changed recovery file rolls back restored state.

`withState` closes owned handles on success and failure and leaves borrowed handles open. The storage adapter releases partial opens and closes idempotently.

The recovery adapter binds approval to file identity and content, pins open descriptors, retains a separate exclusive private copy, and checks the source, backup, recovery copy and sidecars through the supplied commit verifier. Keep the retained copy for recovery. `hardenPrivatePaths` applies and reads back a protected owner-only Windows ACL through `ProcessPort`; other systems use private file modes. These helpers do not replace the owner's transaction: pass their verifier to `restore`.

Filesystem classification is pure over host signals; its adapter rejects recognized cloud and network paths. Missing platform probes produce a once-per-process stderr warning, rather than asserting a local disk. Hosts should supply drive and mount evidence to `classifyFilesystem` when available.

## Integration and evidence

The compiled modules are present in the tarball. Assembly must add public package subpath exports for the owner and storage adapter; this lane does not own `package.json` or the root entry point. The fixture deliberately imports the installed tarball's compiled modules, never a source checkout.

`test/node-fixtures/state/packed.test.ts` builds, packs once, installs, runs eight journeys under the current Node and Bun, then removes individual fixes in the installed copy and requires the corresponding journey to fail. Set `STATE_NODE26` to an additional Node executable to run the third runtime in one invocation. The filesystem counterfactual replaces the linear scan with the old backtracking expression and must time out on the hostile suffix; the normal journey completes.

Baseline and migrated stores are compared structurally and by complete snapshots. Fault injection places competing calls at transaction entry and moves authority immediately before a fenced transaction. Windows ACL tests modify and verify only disposable files.
