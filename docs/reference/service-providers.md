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
Mutations acquire the target's exclusive `.lock`, compare under that lock, write a
private sibling file, fsync and replace, then release the lock. Executable mode is
supported on POSIX; Windows does not use that bit to decide hook health.

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
