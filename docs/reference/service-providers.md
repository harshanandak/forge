# Services for captured blocks

Blocks declare required interfaces in `forge.block.json`. Assembly supplies them through
`services.<slot>`; slot names are chosen by the block. The binding target is `core`.
Configuration selects existing capabilities; it cannot construct a provider. These
providers are mechanisms shared by blocks, with no command or account policy.

```json
{
  "requires": [
    { "slot": "process", "interface": "forge.process@1" },
    { "slot": "files", "interface": "forge.files@1" },
    { "slot": "environment", "interface": "forge.environment@1" },
    { "slot": "crypto", "interface": "forge.crypto@1" }
  ]
}
```

Bind explicitly with `bind: { process: core, files: core, environment: core, crypto: core }`
when a composition has competing providers. Ordinary imports use the exported types
from `forge-workflow/runtime`; captured entry files use type-only imports.

## Process

`forge.process@1` implements the existing `ProcessPort` unchanged and adds `cwd`, the
host project root. `resolve(program, env)` probes PATH/PATHEXT without launching.
`run(resolved, argv, options)` requires `external:process` on the current operation and
its admission grant. Every launch needs this effect, including observational Git/gh
commands: a generic provider cannot infer whether arbitrary arguments mutate the
machine. Handlers additionally declare their domain and external mutation effects.

Options explicitly include `cwd`, the full child `env`, `timeoutMs`, and
`maxOutputBytes`; `stdin` and `signal` are optional. There is no implicit environment
inheritance. Arguments are arrays, never shell command strings. The host merges the
runtime signal with the caller signal, caps command timeout at the invocation
deadline, and takes containment from the operation. Runtime tracks pending calls,
stops supervised descendants, and drains them before returning. Strict containment
uses the existing `processContainment: strict` declaration and fails before activation
on unsupported hosts. Declared operation timeouts and instance `operationTimeouts`
remain the outer budget.

## Files and snapshots

`forge.files@1` requires project or leased context for the assembly's project root.
It exposes `root` and `roots: { project, git, common }`. Git resolves the current
worktree's private Git directory and the clone's common directory; this supports
linked worktrees without treating their `.git` pointer as a directory.

```ts
read(path: string, maxBytes: number, area?: "project" | "git" | "common"): string | undefined;
inspect(path: string, area?: "project" | "git" | "common"):
  { regular: boolean; executable: boolean; size: number } | undefined;
write(path: string, text: string, options?: {
  area?: "project" | "git" | "common";
  expected?: string | null;
  executable?: boolean;
}): void;
remove(path: string, options?: {
  area?: "project" | "git" | "common";
  expected?: string | null;
}): void;
list(path: string, maxEntries: number, area?: "project" | "git" | "common"): readonly string[];
lock(paths: readonly string[]): { release(): void };
snapshot(input: {
  paths: readonly string[];
  maxBytes: number;
  timeoutMs: number;
  maxOutputBytes: number;
}): Promise<{ head: string; filesDigest: string }>;
```

The default area is `project`. Reads/inspect/snapshot require `files:read` and never
write or create directories. Mutations require `files:write`; declared domain and
external write effects belong to the handler as appropriate. Text reads and writes
use UTF-8. Scripts/config use this API; arbitrary binary inputs are hashed as exact
bytes by snapshot. There is no separate effective-config service: handlers already
receive `args.config`. Git configuration is normally changed through Git's CLI.

`expected: null` means create only when absent. A string means replace/remove only
when the current contents match. Omitting `expected` allows unconditional replacement
or removal. Conflicts throw `INPUT_CONFLICT` with reconcile-first retry advice.
Hook installers use `expected: null`, and uninstallers use the saved owned content.
Mutations acquire the target's exclusive `.lock`. Conditional mutations capture file
identity, size, modification time and content hash, claim the original in a durable
private recovery location, then reverify before publishing or deleting. Publication
and restoration refuse to replace a newly created target. A conflicting original is
kept recoverable when restoration cannot safely complete; backups are removed only
after success. Unconditional replacement uses a private file, fsync and atomic rename.
Executable mode is
supported on POSIX; Windows does not use that bit to decide hook health.

This is not an OS-level compare-and-swap. Native pathname calls cannot atomically
compare arbitrary file contents and mutate that path. Conditional replacement can
briefly expose an absent path; readers must handle that as a retryable observation.
An uncooperative writer holding the original inode, or concurrently replacing an
ancestor directory, still creates an OS-level window. Static link escapes and final
target replacements are tested; adversarial ancestor replacement remains follow-up
work. Do not treat these trusted-project services as an OS sandbox.

`list` reads at most the explicit entry budget plus one before refusing overflow,
never silently truncates, and returns sorted entry names. Its safety ceiling is
1024 entries; `.` selects the area's root. It requires `files:read`.

`lock` requires `files:write` and exclusively creates at most three native `.lock`
files held by the invocation. Relative names use the common Git directory; absolute
names must remain under the verified common or worktree Git metadata roots. Partial
acquisition rolls back. Release is synchronous and idempotent; owned cleanup releases
the raw handles even after handler revocation. File identity and random ownership
markers prevent release from removing pre-existing or replaced locks. Blocks choose
which paths to lock and recheck their domain identity/revision while locks are held.

Paths are relative, reject traversal, absolute paths, symlink/reparse components and
non-regular file reads. Reads reject oversized input before allocating and never
silently truncate. The default per-file safety ceiling is 1 MiB; a host may lower it
with `AssemblyOptions.providers.maxFileBytes`. Snapshot caps the total selected bytes,
includes ordered path identities and missing markers, hashes dirty/untracked selected
files, excludes nothing implicitly, and rejects duplicate paths. It checks exact HEAD
before and after capture and refuses drift or missing HEAD. The digest covers the
selected bytes, not an atomic repository-wide snapshot; callers recheck before acting.

## Environment and platform primitives

`forge.environment@1` exposes `platform` and `select(names)`. Selection requires
`environment:read`, returns only existing explicitly named variables, and returns a
fresh object. Empty names returns `{}`. PATH, loader variables and credentials are
never implicitly added. Names use the host platform's case rules. Do not serialize
selected credentials into output or persistent state. Hosts may supply a restricted
baseline through `AssemblyOptions.providers.env`.

`forge.crypto@1` exposes `sha256(text)` (UTF-8, lowercase hex, no prefix) and
`randomUUID()`. These expose platform primitives absent from the captured VM; parsers,
canonical JSON, receipt policy and other pure functions remain in blocks. Hash input
has a 1 MiB safety ceiling. Neither method needs an I/O effect.

Every service, property and cached method is invocation-scoped. Return, throw, timeout
or cancellation revokes access. Synchronous file work also checks deadlines directly.
Discovery does not construct services. Files and environment add no background
resource; process supervisors exist only while a child runs. Host supervision settings
are configurable through `AssemblyOptions.providers.supervision`; defaults bound cleanup
to 5 seconds, poll to 25 ms, output drain to 250 ms and concurrent supervisors to one.

## Final L12 requirements reconciliation

Compared against the finalized consumer brief (2026-10-19 15:41):

| Need                                                                                        | Disposition                           | Service or boundary                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Git/gh argv, stdin, explicit cwd/env and bounded output                                     | Covered                               | Existing ProcessPort unchanged; missing executables return Unavailable. No network-specific provider.                                                                                    |
| Canonical clone and linked-worktree metadata roots                                          | Covered                               | `files.root` and `files.roots`; Git resolves common and per-worktree directories.                                                                                                        |
| Host environment and platform                                                               | Covered differently                   | `environment.select(names)` and `environment.platform`; only explicitly selected variables are copied, rather than exposing the entire ambient environment.                              |
| Bounded file bytes for hooks/config                                                         | Covered differently                   | Bounded UTF-8 `read`/`write`; invalid UTF-8 is refused. Snapshot hashes exact binary bytes. General binary editing has no consumer here.                                                 |
| Create without overwriting                                                                  | Covered differently                   | `write(..., { expected: null, executable })`; typed conflict replaces a false return.                                                                                                    |
| Remove only owned contents                                                                  | Covered differently                   | `remove(..., { expected: savedText })`; typed conflict preserves changed content and provides reconcile-first advice.                                                                    |
| Executable/regular-file inspection                                                          | Covered                               | `inspect`; final links are not followed.                                                                                                                                                 |
| Bounded directory listing                                                                   | Covered, added after reconciliation   | `list(path, maxEntries, area?)`; explicit budget and 1024-entry safety cap.                                                                                                              |
| Destructive-operation exclusion across native Git writers                                   | Covered, added after reconciliation   | Invocation-owned `lock(paths)` for at most three common/per-worktree metadata `.lock` files, with partial rollback and replacement-safe cleanup.                                         |
| Clone-local Git configuration                                                               | Covered                               | Git CLI through ProcessPort; no special Git-config API or global account switch.                                                                                                         |
| Namespaced, lease-fenced state                                                              | Covered                               | Existing state provider; only the current operation's noun write effect opens writable state.                                                                                            |
| Observational launches without write authority                                              | Covered differently                   | Declare `external:process`, `files:read` and `environment:read` as used. These grant capabilities without manufacturing a domain write grant.                                            |
| Deadline, AbortSignal, strict preflight, partial-open rollback, descendant drain            | Covered                               | Runtime invocation scope plus owned cleanup for internal Git reads and metadata locks.                                                                                                   |
| Optional account/author/committer selection                                                 | Deliberately outside generic assembly | The accounts block owns selection and transient credential handling. Its non-secret clone binding key is `forge.githubAccount`; it does not publish credentials through catalog outputs. |
| Worktree membership, dirty/head checks, provider login verification and uncertain mutations | Deliberately in consumer blocks       | Domain policy uses these generic capabilities; assembly has no GitHub/worktree-specific methods or blind-retry policy.                                                                   |
