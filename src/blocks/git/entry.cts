import type {
  HandlerCall,
  Operations,
  ProcessPort,
  ProcessResult,
} from "../../contract/author.ts";
import type { LeaseStateClient } from "../../assembly/state-client.ts";
import type { StateRecord } from "../../generated/types.ts";

declare const fail: (code: string, message: string) => never;

interface Clone {
  readonly root: string;
  readonly roots: Readonly<Record<Area, string>>;
  readonly env: Readonly<Record<string, string>>;
  readonly platform: string;
  read(path: string, maxBytes: number): Uint8Array | undefined;
  create(
    path: string,
    bytes: Uint8Array,
    options: { executable: boolean },
  ): boolean;
  remove(path: string, expected: Uint8Array): boolean;
  inspect(path: string): { executable: boolean; regular: boolean } | undefined;
  lock(paths: readonly string[]): { release(): void };
}
interface Services {
  readonly process: ProcessPort;
  readonly clone: Clone;
  readonly state: LeaseStateClient;
}
type Area = "project" | "git" | "common";
interface FileLocation {
  readonly path: string;
  readonly area: Area;
}
interface Files {
  readonly root: string;
  readonly roots: Readonly<Record<Area, string>>;
  read(path: string, maxBytes: number, area?: Area): string | undefined;
  inspect(
    path: string,
    area?: Area,
  ): { regular: boolean; executable: boolean } | undefined;
  write(
    path: string,
    text: string,
    options: { area?: Area; expected: null; executable: boolean },
  ): void;
  remove(path: string, options: { area?: Area; expected: string }): void;
  lock(paths: readonly FileLocation[]): { release(): void };
}
interface RawServices {
  readonly process: ProcessPort & { readonly cwd: string };
  readonly files: Files;
  readonly environment: {
    readonly platform: string;
    select(names: readonly string[]): Readonly<Record<string, string>>;
  };
  readonly state: LeaseStateClient;
}
interface HookCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly files: readonly string[];
}
interface Config {
  readonly remote: string;
  readonly worktreeRoot: string;
  readonly commandTimeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxWorktrees: number;
  readonly fetchBeforeClean: boolean;
  readonly envNames: readonly string[];
  readonly hookDirectory?: string;
  readonly hookArea?: Area;
  readonly hookCommand?: HookCommand;
  readonly hookMaxBytes?: number;
}
interface Binding {
  readonly path: string;
  readonly branch: string;
  readonly base: string;
  readonly baseSha: string;
  readonly status: "creating" | "active" | "removed" | "uncertain";
  readonly issue?: string;
  readonly run?: string;
}
interface Tree {
  path: string;
  head: string;
  branch?: string;
  locked?: boolean;
  bare?: boolean;
}
interface Ref {
  readonly path: string;
  readonly expectRevision: number;
  readonly expectedHead: string;
}
interface Create {
  readonly name: string;
  readonly branch: string;
  readonly base?: string;
  readonly expectRevision: number;
  readonly issue?: string;
  readonly run?: string;
}
interface HookRef {
  readonly name: string;
  readonly expectRevision: number;
  readonly adoptExisting?: boolean;
}
interface HookReceipt {
  readonly path: string;
  readonly body: readonly number[];
  readonly hooksPath: string;
  readonly created: boolean;
  readonly removed: boolean;
}
interface Output {
  readonly [key: string]: unknown;
}
type Types = {
  readonly "worktree.create": readonly [Create, Output];
  readonly "worktree.list": readonly [Record<string, never>, Output];
  readonly "worktree.remove": readonly [Ref, Output];
  readonly "worktree.clean": readonly [{ readonly dryRun: boolean }, Output];
  readonly "branch.push": readonly [
    {
      readonly branch: string;
      readonly expectedHead: string;
      readonly remoteBranch: string;
    },
    Output,
  ];
  readonly "hook.install": readonly [HookRef, Output];
  readonly "hook.remove": readonly [HookRef, Output];
  readonly "hook.status": readonly [{ readonly name: string }, Output];
};
interface Call<I> extends HandlerCall<I> {
  readonly config: Config;
  readonly services: Services;
}
function call<I>(args: HandlerCall<I>): Call<I> {
  const s = args.services as RawServices | undefined;
  const config = args.config as Config;
  if (!s?.process || !s.files || !s.environment || !s.state)
    fail(
      "PROVIDER_MISSING",
      "git requires process, files, environment and state services",
    );
  const location = (path: string): FileLocation => {
    const normalized = path.replace(/\\/g, "/");
    if (!normalized.startsWith("/") && !/^[A-Za-z]:/.test(normalized))
      return { path: relativePath(normalized), area: "project" };
    for (const area of ["git", "common", "project"] as const) {
      const root = s.files.roots[area].replace(/\\/g, "/").replace(/\/$/, "");
      const prefix = root + "/";
      if (
        samePath(
          normalized.slice(0, prefix.length),
          prefix,
          s.environment.platform,
        )
      )
        return { path: relativePath(normalized.slice(prefix.length)), area };
    }
    fail(
      "INPUT_INVALID",
      "File path is outside the clone and its verified Git metadata roots",
    );
  };
  const conditional = (action: () => void): boolean => {
    try {
      action();
      return true;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "error" in error &&
        typeof error.error === "object" &&
        error.error !== null &&
        "code" in error.error &&
        error.error.code === "INPUT_CONFLICT"
      )
        return false;
      throw error;
    }
  };
  const clone: Clone = {
    root: s.files.root,
    roots: s.files.roots,
    env: s.environment.select(config.envNames),
    platform: s.environment.platform,
    read(path, maxBytes) {
      const target = location(path);
      const value = s.files.read(target.path, maxBytes, target.area);
      return value === undefined ? undefined : bytes(value);
    },
    inspect(path) {
      const target = location(path);
      return s.files.inspect(target.path, target.area);
    },
    create(path, value, options) {
      const target = location(path);
      return conditional(() =>
        s.files.write(target.path, text(value), {
          area: target.area,
          expected: null,
          executable: options.executable,
        }),
      );
    },
    remove(path, expected) {
      const target = location(path);
      return conditional(() =>
        s.files.remove(target.path, {
          area: target.area,
          expected: text(expected),
        }),
      );
    },
    lock(paths) {
      if (typeof s.files.lock !== "function")
        fail(
          "PROVIDER_MISSING",
          "The clone file provider requires invocation-scoped Git locks for guarded removal",
        );
      return s.files.lock(paths.map(location));
    },
  };
  return {
    ...args,
    config,
    services: { process: s.process, state: s.state, clone },
  };
}
function relativePath(value: string): string {
  if (
    !value ||
    value.startsWith("/") ||
    /[\\\0\r\n:]/.test(value) ||
    value.split("/").some((p) => !p || p === "." || p === "..")
  )
    fail("INPUT_INVALID", "Expected a project-relative path with no traversal");
  return value;
}
function samePath(a: string, b: string, platform: string): boolean {
  const normalize = (p: string) => p.replace(/\\/g, "/").replace(/\/$/, "");
  return platform === "win32"
    ? normalize(a).toLowerCase() === normalize(b).toLowerCase()
    : normalize(a) === normalize(b);
}
function ref(value: string): string {
  if (
    !value ||
    value.startsWith("-") ||
    /[\0\s~^:?*[\\]/.test(value) ||
    value.includes("..") ||
    value.includes("@{") ||
    value.endsWith("/") ||
    value.endsWith(".")
  )
    fail("INPUT_INVALID", "Invalid Git reference");
  return value;
}
function environment(
  base: Readonly<Record<string, string>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base))
    if (
      !/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|PREFIX|NAMESPACE|CONFIG|CONFIG_COUNT|CONFIG_PARAMETERS|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/i.test(
        key,
      )
    )
      env[key] = value;
  return {
    ...env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    LC_ALL: "C",
  };
}
function live(c: Call<unknown>): void {
  if (c.signal.aborted || Date.now() >= c.deadline)
    fail("INVOCATION_TIMEOUT", "Invocation ended before Git could start");
}
async function git(
  c: Call<unknown>,
  args: readonly string[],
  cwd = c.services.clone.root,
  accept: readonly number[] = [0],
  stdin?: string,
): Promise<ProcessResult> {
  live(c);
  const env = environment(c.services.clone.env);
  const executable = c.services.process.resolve("git", env);
  if (executable.kind === "unavailable")
    fail(
      "UNAVAILABLE",
      "Git is unavailable; install Git and expose it on the invocation PATH",
    );
  const result = await c.services.process.run(executable, args, {
    cwd,
    env,
    signal: c.signal,
    timeoutMs: Math.min(
      c.config.commandTimeoutMs,
      Math.max(1, c.deadline - Date.now()),
    ),
    maxOutputBytes: c.config.maxOutputBytes,
    ...(stdin === undefined ? {} : { stdin }),
  });
  if (
    result.timedOut ||
    result.signal ||
    result.truncated ||
    result.exitCode === null
  )
    fail(
      "EXTERNAL_UNCERTAIN",
      "Git did not return complete evidence; read repository state before retrying a mutation",
    );
  if (!accept.includes(result.exitCode))
    fail(
      "GIT_FAILED",
      `Git ${args[0] ?? "command"} failed (exit ${result.exitCode}); reconcile the repository before retrying`,
    );
  return result;
}
async function revision(
  c: Call<unknown>,
  name: string,
  cwd?: string,
): Promise<string> {
  const output = (
    await git(
      c,
      ["rev-parse", "--verify", "--end-of-options", `${ref(name)}^{commit}`],
      cwd,
    )
  ).stdout.trim();
  if (!/^[a-f0-9]{40,64}$/.test(output))
    fail("EVIDENCE_INVALID", "Git returned an invalid commit identity");
  return output;
}
function trees(output: string): Tree[] {
  const result: Tree[] = [];
  let current: Tree | undefined;
  for (const field of output.split("\0")) {
    if (field.startsWith("worktree ")) {
      current = { path: field.slice(9), head: "" };
      result.push(current);
    } else if (current && field.startsWith("HEAD "))
      current.head = field.slice(5);
    else if (current && field.startsWith("branch refs/heads/"))
      current.branch = field.slice(18);
    else if (current && (field === "locked" || field.startsWith("locked ")))
      current.locked = true;
    else if (current && field === "bare") current.bare = true;
  }
  return result;
}
async function list(c: Call<unknown>): Promise<Tree[]> {
  const result = trees(
    (await git(c, ["worktree", "list", "--porcelain", "-z"])).stdout,
  );
  if (result.length > c.config.maxWorktrees)
    fail("LIMIT_EXCEEDED", "Worktree count exceeds configured maxWorktrees");
  return result;
}
function key(path: string): string {
  return `worktree:${path}`;
}
function write(
  c: Call<unknown>,
  k: string,
  value: unknown,
  expectRevision: number,
): StateRecord {
  live(c);
  const result = c.services.state.put(k, value, { expectRevision });
  const read = c.services.state.get(k);
  if (
    !read ||
    read.revision !== result.revision ||
    JSON.stringify(read.value) !== JSON.stringify(result.value)
  )
    fail(
      "INTERNAL",
      "Accepted binding did not read back; reconcile state before retrying",
    );
  return result;
}
function records(
  c: Call<unknown>,
  from: string,
  to: string,
): readonly StateRecord[] {
  const result = c.services.state.listRange({
    from,
    to,
    limit: c.config.maxWorktrees,
  });
  const last = result.at(-1);
  if (
    result.length === c.config.maxWorktrees &&
    last &&
    c.services.state.listRange({ from: last.key + "\0", to, limit: 1 }).length
  )
    fail(
      "LIMIT_EXCEEDED",
      "Owned record count exceeds configured maxWorktrees; no partial scan is accepted",
    );
  return result;
}
async function base(
  c: Call<unknown>,
  fetch: boolean,
): Promise<{ ref: string; sha: string }> {
  const remote = ref(c.config.remote);
  if (remote.includes("/"))
    fail("INPUT_INVALID", "Remote must be a configured Git remote name");
  let branch: string;
  if (fetch) {
    const answer = (
      await git(c, ["ls-remote", "--symref", "--", remote, "HEAD"])
    ).stdout;
    const match = /^ref: refs\/heads\/(.+)\tHEAD$/m.exec(answer);
    if (!match?.[1])
      fail("EVIDENCE_INCOMPLETE", "Remote did not declare a default branch");
    branch = ref(match[1]);
    await git(c, [
      "fetch",
      "--no-tags",
      "--",
      remote,
      `refs/heads/${branch}:refs/remotes/${remote}/${branch}`,
    ]);
    await git(c, [
      "symbolic-ref",
      `refs/remotes/${remote}/HEAD`,
      `refs/remotes/${remote}/${branch}`,
    ]);
  } else {
    const target = (
      await git(c, ["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`])
    ).stdout.trim();
    const prefix = `refs/remotes/${remote}/`;
    if (!target.startsWith(prefix))
      fail(
        "EVIDENCE_INVALID",
        "Remote default ref is outside the configured remote",
      );
    branch = ref(target.slice(prefix.length));
  }
  const reference = `refs/remotes/${remote}/${branch}`;
  return { ref: reference, sha: await revision(c, reference) };
}
function managed(
  c: Call<unknown>,
  path: string,
  expectedRevision?: number,
): { record: StateRecord; binding: Binding; absolute: string } {
  relativePath(path);
  const prefix = relativePath(c.config.worktreeRoot) + "/";
  if (!path.startsWith(prefix))
    fail("INPUT_INVALID", "Worktree path is outside configured worktreeRoot");
  const record = c.services.state.get(key(path));
  if (!record)
    fail("NOT_FOUND", "No owned worktree binding exists for this path");
  if (expectedRevision !== undefined && record.revision !== expectedRevision)
    fail("REVISION_CONFLICT", "Worktree binding changed; read it again");
  const binding = record.value as Binding;
  if (binding.path !== path || binding.status !== "active")
    fail(
      "INPUT_CONFLICT",
      "Worktree is not an active owned binding; reconcile it explicitly",
    );
  return { record, binding, absolute: `${c.services.clone.root}/${path}` };
}
async function remove(c: Call<unknown>, input: Ref): Promise<Output> {
  const { record, binding, absolute } = managed(
    c,
    input.path,
    input.expectRevision,
  );
  const tree = (await list(c)).find((t) =>
    samePath(t.path, absolute, c.services.clone.platform),
  );
  if (!tree || tree.locked || tree.bare || tree.branch !== binding.branch)
    fail("INPUT_CONFLICT", "Owned worktree identity changed or is locked");
  if (tree.head !== input.expectedHead)
    fail("SUBJECT_VERSION_CONFLICT", "Worktree head moved; read it again");
  const format = await git(
    c,
    ["config", "--local", "--get", "extensions.refStorage"],
    undefined,
    [0, 1],
  );
  if (format.exitCode === 0 && format.stdout.trim() !== "files")
    fail("UNAVAILABLE", "Guarded removal requires Git's files ref storage");
  const paths = (
    await git(
      c,
      [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "HEAD",
        "--git-path",
        "index",
        "--git-path",
        `refs/heads/${ref(binding.branch)}`,
      ],
      absolute,
    )
  ).stdout
    .trim()
    .split(/\r?\n/);
  if (
    paths.length !== 3 ||
    paths.some((path) => !path || /[\0\r\n]/.test(path))
  )
    fail("EVIDENCE_INVALID", "Git did not return its three metadata paths");
  live(c);
  const exclusion = c.services.clone.lock(paths.map((path) => path + ".lock"));
  try {
    managed(c, input.path, record.revision);
    const branch = (
      await git(c, ["symbolic-ref", "--quiet", "--short", "HEAD"], absolute)
    ).stdout.trim();
    if (
      branch !== binding.branch ||
      (await revision(c, "HEAD", absolute)) !== input.expectedHead
    )
      fail(
        "SUBJECT_VERSION_CONFLICT",
        "Worktree identity changed before removal acquired its Git locks",
      );
    if (
      (
        await git(
          c,
          ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
          absolute,
        )
      ).stdout !== ""
    )
      fail("WORKTREE_DIRTY", "Worktree contains changes and was kept");
    managed(c, input.path, record.revision);
    // Git's own HEAD/index/ref locks also exclude direct commits and branch switches.
    await git(c, ["worktree", "remove", "--", absolute]);
    const accepted = write(
      c,
      key(input.path),
      { ...binding, status: "removed" },
      record.revision,
    );
    return { removed: true, path: input.path, revision: accepted.revision };
  } finally {
    exclusion.release();
  }
}
async function merged(
  c: Call<unknown>,
  target: string,
  head: string,
): Promise<boolean> {
  const ancestor = await git(
    c,
    ["merge-base", "--is-ancestor", head, target],
    undefined,
    [0, 1],
  );
  if (ancestor.exitCode === 0) return true;
  const common = (await git(c, ["merge-base", target, head])).stdout.trim();
  const tree = (await git(c, ["rev-parse", `${head}^{tree}`])).stdout.trim();
  // A synthetic single patch preserves squash equivalence without changing a ref or checkout.
  const synthetic = (
    await git(c, [
      "commit-tree",
      tree,
      "-p",
      common,
      "-m",
      "Compare worktree patch",
    ])
  ).stdout.trim();
  return (
    (await git(c, ["cherry", target, synthetic])).stdout.trim() ===
    `- ${synthetic}`
  );
}
function bytes(value: string): Uint8Array {
  const result: number[] = [];
  for (const point of value) {
    const n = point.codePointAt(0)!;
    if (n < 128) result.push(n);
    else if (n < 2048) result.push(192 | (n >> 6), 128 | (n & 63));
    else if (n < 65536)
      result.push(224 | (n >> 12), 128 | ((n >> 6) & 63), 128 | (n & 63));
    else
      result.push(
        240 | (n >> 18),
        128 | ((n >> 12) & 63),
        128 | ((n >> 6) & 63),
        128 | (n & 63),
      );
  }
  return new Uint8Array(result);
}
function text(value: Uint8Array): string {
  let encoded = "";
  for (const byte of value) encoded += "%" + byte.toString(16).padStart(2, "0");
  return decodeURIComponent(encoded);
}
function equal(a: Uint8Array | undefined, b: Uint8Array): boolean {
  return (
    a !== undefined && a.length === b.length && a.every((v, i) => v === b[i])
  );
}
function hookName(name: string): string {
  if (!/^[a-z][a-z-]*$/.test(name))
    fail("INPUT_INVALID", "Invalid Git hook name");
  return name;
}
function hookConfig(c: Call<unknown>): {
  directory: string;
  area: Area;
  command: HookCommand;
  limit: number;
} {
  if (
    !c.config.hookArea ||
    !c.config.hookDirectory ||
    !c.config.hookCommand ||
    !c.config.hookMaxBytes
  )
    fail(
      "CONFIG_INVALID",
      "Hook installation requires explicit hookDirectory, hookCommand and hookMaxBytes",
    );
  return {
    directory: relativePath(c.config.hookDirectory),
    area: c.config.hookArea,
    command: c.config.hookCommand,
    limit: c.config.hookMaxBytes,
  };
}
async function effectiveHooks(c: Call<unknown>): Promise<string> {
  return (
    await git(c, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"])
  ).stdout.trim();
}
function quote(value: string): string {
  if (/[\0\r\n]/.test(value))
    fail(
      "CONFIG_INVALID",
      "Hook arguments must contain no line breaks or NUL bytes",
    );
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}
function hookBody(command: HookCommand): Uint8Array {
  return bytes(
    `#!/bin/sh\nexec ${[command.executable, ...command.args].map(quote).join(" ")} "$@"\n`,
  );
}
function hookDependencies(
  c: Call<unknown>,
  command: HookCommand,
  limit: number,
): boolean {
  const executable = c.services.process.resolve(
    command.executable,
    environment(c.services.clone.env),
  );
  return (
    executable.kind === "resolved" &&
    command.files.every((path) => {
      const info = c.services.clone.inspect(relativePath(path));
      return (
        info?.regular === true &&
        c.services.clone.read(path, limit) !== undefined
      );
    })
  );
}
async function hookStatus(c: Call<unknown>, name: string): Promise<Output> {
  const { directory, area, command, limit } = hookConfig(c);
  const desired = `${c.services.clone.roots[area]}/${directory}`;
  const path = `${desired}/${hookName(name)}`;
  const info = c.services.clone.inspect(path);
  const effective = await effectiveHooks(c);
  const active =
    samePath(effective, desired, c.services.clone.platform) &&
    info?.regular === true &&
    (c.services.clone.platform === "win32" || info.executable) &&
    equal(c.services.clone.read(path, limit), hookBody(command)) &&
    hookDependencies(c, command, limit);
  const receipt = c.services.state.get(`hook:${name}`);
  return {
    name,
    active,
    effectivePath: effective,
    owned:
      !!receipt &&
      (receipt.value as HookReceipt).created &&
      !(receipt.value as HookReceipt).removed,
    revision: receipt?.revision ?? 0,
  };
}

const operations: Operations<Types> = {
  async "worktree.create"(args) {
    const c = call(args);
    const input = c.input;
    const path = `${relativePath(c.config.worktreeRoot)}/${relativePath(input.name)}`;
    const branch = ref(input.branch);
    await git(c, ["check-ref-format", "--branch", branch]);
    const all = await list(c);
    if (
      all.length >= c.config.maxWorktrees ||
      all.some(
        (t) =>
          samePath(
            t.path,
            `${c.services.clone.root}/${path}`,
            c.services.clone.platform,
          ) || t.branch === branch,
      )
    )
      fail(
        "INPUT_CONFLICT",
        "Worktree path or branch is already checked out, or the configured limit was reached",
      );
    const chosen =
      input.base === undefined
        ? await base(c, true)
        : { ref: ref(input.base), sha: await revision(c, input.base) };
    // An existing branch must never be reset to another base.
    const exists = await git(
      c,
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      undefined,
      [0, 1],
    );
    if (exists.exitCode === 0)
      fail("INPUT_CONFLICT", "Branch already exists; choose an unused branch");
    const binding: Binding = {
      path,
      branch,
      base: chosen.ref,
      baseSha: chosen.sha,
      status: "creating",
      ...(input.issue === undefined ? {} : { issue: input.issue }),
      ...(input.run === undefined ? {} : { run: input.run }),
    };
    const reserved = write(c, key(path), binding, input.expectRevision);
    try {
      await git(c, [
        "worktree",
        "add",
        "-b",
        branch,
        "--",
        `${c.services.clone.root}/${path}`,
        chosen.sha,
      ]);
      const head = await revision(
        c,
        "HEAD",
        `${c.services.clone.root}/${path}`,
      );
      if (head !== chosen.sha)
        fail(
          "SUBJECT_VERSION_CONFLICT",
          "Created worktree head differs from its selected base",
        );
      const accepted = write(
        c,
        key(path),
        { ...binding, status: "active" },
        reserved.revision,
      );
      return {
        path,
        branch,
        base: chosen.ref,
        baseSha: chosen.sha,
        head,
        revision: accepted.revision,
      };
    } catch (error) {
      write(
        c,
        key(path),
        { ...binding, status: "uncertain" },
        reserved.revision,
      );
      throw error;
    }
  },
  async "worktree.list"(args) {
    const c = call(args);
    const all = await list(c);
    const bindings = records(c, "worktree:", "worktree;");
    return {
      worktrees: all.map((tree) => {
        const record = bindings.find((r) =>
          samePath(
            `${c.services.clone.root}/${(r.value as Binding).path}`,
            tree.path,
            c.services.clone.platform,
          ),
        );
        return {
          ...tree,
          ...(record
            ? { binding: record.value, revision: record.revision }
            : {}),
        };
      }),
    };
  },
  async "worktree.remove"(args) {
    const c = call(args);
    return remove(c, c.input);
  },
  async "worktree.clean"(args) {
    const c = call(args);
    if (c.input.dryRun && c.config.fetchBeforeClean)
      fail(
        "INPUT_CONFLICT",
        "Dry run cannot fetch; set fetchBeforeClean=false to inspect fetched evidence",
      );
    const target = await base(c, c.config.fetchBeforeClean);
    const all = await list(c);
    const outcomes: Output[] = [];
    const bindings = records(c, "worktree:", "worktree;");
    for (const record of bindings) {
      const binding = record.value as Binding;
      if (binding.status !== "active") continue;
      const tree = all.find((t) =>
        samePath(
          t.path,
          `${c.services.clone.root}/${binding.path}`,
          c.services.clone.platform,
        ),
      );
      let reason: string | undefined;
      if (!tree || tree.bare || tree.locked || tree.branch !== binding.branch)
        reason = "identity-or-lock";
      // An unchanged creation head is unstarted work even when ancestry calls it merged.
      else if (tree.head === binding.baseSha) reason = "unstarted";
      else if (
        (
          await git(
            c,
            ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
            tree.path,
          )
        ).stdout !== ""
      )
        reason = "dirty";
      else if (!(await merged(c, target.sha, tree.head))) reason = "not-merged";
      if (reason || !tree) {
        outcomes.push({
          path: binding.path,
          removed: false,
          reason: reason ?? "missing",
        });
        continue;
      }
      if (c.input.dryRun)
        outcomes.push({
          path: binding.path,
          removed: false,
          reason: "dry-run",
          wouldRemove: true,
        });
      else
        outcomes.push(
          await remove(c, {
            path: binding.path,
            expectedHead: tree.head,
            expectRevision: record.revision,
          }),
        );
    }
    return { base: target.ref, baseSha: target.sha, outcomes };
  },
  async "branch.push"(args) {
    const c = call(args);
    const branch = ref(c.input.branch);
    const remoteBranch = ref(c.input.remoteBranch);
    const head = await revision(c, `refs/heads/${branch}`);
    if (head !== c.input.expectedHead)
      fail("SUBJECT_VERSION_CONFLICT", "Branch moved since it was read");
    await git(c, [
      "push",
      "--porcelain",
      "--",
      ref(c.config.remote),
      `${head}:refs/heads/${remoteBranch}`,
    ]);
    const read = (
      await git(c, [
        "ls-remote",
        "--refs",
        "--",
        c.config.remote,
        `refs/heads/${remoteBranch}`,
      ])
    ).stdout.trim();
    if (read !== `${head}\trefs/heads/${remoteBranch}`)
      fail(
        "EXTERNAL_UNCERTAIN",
        "Remote head did not read back; reconcile before another push",
      );
    return { branch, remoteBranch, head, pushed: true };
  },
  async "hook.status"(args) {
    const c = call(args);
    return hookStatus(c, c.input.name);
  },
  async "hook.install"(args) {
    const c = call(args);
    const name = hookName(c.input.name);
    const { directory, area, command, limit } = hookConfig(c);
    const desired = `${c.services.clone.roots[area]}/${directory}`;
    const path = `${desired}/${name}`;
    const old = c.services.state.get(`hook:${name}`);
    if ((old?.revision ?? 0) !== c.input.expectRevision)
      fail("REVISION_CONFLICT", "Hook receipt changed; read hook.status");
    const effective = await effectiveHooks(c);
    if (!samePath(effective, desired, c.services.clone.platform))
      return {
        name,
        installed: false,
        reason: "hooks-path-mismatch",
        effectivePath: effective,
      };
    if (!hookDependencies(c, command, limit))
      fail(
        "UNAVAILABLE",
        "Hook executable or a declared dependency file is unavailable",
      );
    const expected = hookBody(command);
    if (expected.length > limit)
      fail("LIMIT_EXCEEDED", "Hook exceeds hookMaxBytes");
    const current = c.services.clone.read(path, limit);
    if (
      current !== undefined &&
      (!old ||
        (old.value as HookReceipt).removed ||
        !equal(current, new Uint8Array((old.value as HookReceipt).body)))
    )
      return { name, installed: false, reason: "user-file" };
    if (current !== undefined && old) {
      const receipt = old.value as HookReceipt;
      if (!receipt.created && c.input.adoptExisting !== true)
        return {
          name,
          installed: false,
          reason: "creation-unconfirmed",
          revision: old.revision,
        };
      const accepted = receipt.created
        ? old
        : write(c, `hook:${name}`, { ...receipt, created: true }, old.revision);
      const recovered = await hookStatus(c, name);
      if (recovered.active !== true)
        fail(
          "EXTERNAL_UNCERTAIN",
          "Owned hook is not active; inspect its effective path and file mode",
        );
      return {
        ...recovered,
        installed: !receipt.created,
        reason: receipt.created ? "already-owned" : "recovered",
        revision: accepted.revision,
      };
    }
    const receipt: HookReceipt = {
      path,
      body: [...expected],
      hooksPath: desired,
      created: false,
      removed: false,
    };
    const reserved = write(c, `hook:${name}`, receipt, c.input.expectRevision);
    live(c);
    if (!c.services.clone.create(path, expected, { executable: true }))
      fail(
        "INPUT_CONFLICT",
        "Hook file appeared during installation; it was preserved",
      );
    const accepted = write(
      c,
      `hook:${name}`,
      { ...receipt, created: true },
      reserved.revision,
    );
    const result = await hookStatus(c, name);
    if (result.active !== true)
      fail(
        "EXTERNAL_UNCERTAIN",
        "Owned hook is not active; inspect hook.status before retrying",
      );
    return { ...result, installed: true, revision: accepted.revision };
  },
  "hook.remove"(args) {
    const c = call(args);
    const name = hookName(c.input.name);
    const record = c.services.state.get(`hook:${name}`);
    if (!record || record.revision !== c.input.expectRevision)
      fail("REVISION_CONFLICT", "Hook receipt changed; read hook.status");
    const receipt = record.value as HookReceipt;
    if (receipt.removed)
      return { name, removed: false, reason: "already-removed" };
    if (!receipt.created)
      return { name, removed: false, reason: "creation-unconfirmed" };
    live(c);
    if (!c.services.clone.remove(receipt.path, new Uint8Array(receipt.body)))
      return { name, removed: false, reason: "file-edited" };
    const accepted = write(
      c,
      record.key,
      { ...receipt, removed: true },
      record.revision,
    );
    return { name, removed: true, revision: accepted.revision };
  },
};
module.exports = operations;
