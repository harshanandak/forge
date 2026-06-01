# Decisions: 0.0.20 Local Broker Contract

## D1: Keep SQLite runtime injected

Decision: Implement the local broker as a contract around an injected driver instead of adding a SQLite package in this PR.

Rationale: The existing 0.0.20 schema slice is dependency-free, and this broker slice only needs to lock the command/API boundary, Git common-dir authority lookup, WAL pragmas, and migration ordering. A driver boundary lets later storage-runtime work bind the same contract without rewriting command routing.

Impact: Kernel command paths can be tested now through `kernelBroker` or `kernelDriver` injection. Default Beads behavior remains unchanged until the import/export and runtime storage PRs are ready.

## D2: Kernel command path is opt-in for this PR

Decision: `runIssueOperation` selects the Kernel backend only when `useKernelBroker`, `issueBackend: "kernel"`, or `kernelBroker` is supplied.

Rationale: PR B must create the Kernel broker and command API contract without breaking current users whose issue commands still rely on Beads. This also avoids treating Beads as authority for new Kernel paths.

Impact: Representative command interactions can prove Kernel routing now, while the default command surface stays compatible.
