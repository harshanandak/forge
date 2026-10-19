import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const [installed, workspace, mode = "all"] = process.argv.slice(2);
const load = (file) =>
  import(pathToFileURL(join(installed, "dist/src", file)).href);
const { StateOwner } = await load("core/state/index.js");
const { sqliteStore } = await load("adapters/store-sqlite/index.js");
const { createStateClient } = await load("assembly/state-client.js");
const { nodeRunIsolation } = await load("adapters/node-runtime/isolation.js");
const { createProcessPort } = await load("adapters/process/index.js");
const { ForgeFailure } = await load("contract/failure.js");
const source = readFileSync(
  join(installed, "dist/src/blocks/git/entry.cjs"),
  "utf8",
);
mkdirSync(workspace, { recursive: true });
const repo = join(workspace, "repo");
const remote = join(workspace, "remote.git");
mkdirSync(repo);
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key, value]) => value !== undefined && !/^GIT_/i.test(key),
  ),
);
Object.assign(env, {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: join(workspace, "empty-gitconfig"),
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
});
writeFileSync(env.GIT_CONFIG_GLOBAL, "");
function git(args, cwd = repo, accepted = [0]) {
  const result = spawnSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 1048576,
  });
  assert.ok(
    accepted.includes(result.status),
    `fixture git ${args[0]} failed: ${result.stderr}`,
  );
  return result.stdout.trim();
}
git(["init", "--bare", "--initial-branch=trunk", remote]);
git(["init", "--initial-branch=trunk"]);
git(["config", "user.name", "Fixture Author"]);
git(["config", "user.email", "fixture@example.invalid"]);
git(["config", "core.autocrlf", "false"]);
function commit(cwd, file, body) {
  writeFileSync(join(cwd, file), body);
  git(["add", "--", file], cwd);
  git(["commit", "-m", `fixture ${file}`], cwd);
  return git(["rev-parse", "HEAD"], cwd);
}
const initial = commit(repo, "seed.txt", "remote default\n");
git(["remote", "add", "origin", remote]);
git(["push", "origin", "trunk"]);
git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"]);
const parentWip = commit(repo, "parent-wip.txt", "local work only\n");
const calls = [];
const costs = new Map();
const realProcess = createProcessPort({
  supervision: {
    cleanupTimeoutMs: 3000,
    pollIntervalMs: 10,
    drainTimeoutMs: 100,
    maxConcurrent: 1,
  },
});
let beforePush;
let supervised = false;
let executableMode;
let platform = process.platform;
let beforeLock;
let afterLock;
let abortAfterCreate = false;
let invocationController;
let namespace = "forge/git";
let beforeBatch;
let failNextWorktreeAdd = false;
const processPort = {
  capability: "forge.process/v1",
  get cwd() {
    return clone.root;
  },
  resolve: (executable, selectedEnv) =>
    realProcess.resolve(executable, selectedEnv),
  async run(executable, args, options) {
    const started = performance.now();
    const record = (result) => {
      const key = args[0];
      const current = costs.get(key) ?? { count: 0, durationMs: 0 };
      costs.set(key, {
        count: current.count + 1,
        durationMs: current.durationMs + performance.now() - started,
      });
      return result;
    };
    calls.push([...args]);
    assert.ok(
      options.signal instanceof AbortSignal,
      "Git must receive invocation cancellation",
    );
    assert.equal(
      options.env.GIT_DIR,
      undefined,
      "host Git location overrides must be removed",
    );
    assert.ok(options.timeoutMs <= 15000 && options.timeoutMs > 0);
    if (args[0] === "push" && beforePush) {
      const effect = beforePush;
      beforePush = undefined;
      effect();
    }
    if (args[0] === "worktree" && args[1] === "add" && failNextWorktreeAdd) {
      failNextWorktreeAdd = false;
      return record({
        exitCode: 1,
        signal: null,
        stdout: "",
        stderr: "controlled add failure",
        timedOut: false,
        truncated: false,
        durationMs: 0,
      });
    }
    if (supervised) {
      const result = await realProcess.run(executable, args, options);
      assert.equal(
        result.supervision?.confirmed,
        true,
        "supervised Git call must confirm descendant cleanup",
      );
      return record(result);
    }
    // Block acceptance uses real Git with bounded argv execution. The push journey
    // additionally exercises the installed adapter's process-tree supervision.
    const result = spawnSync(executable.path, args, {
      cwd: options.cwd,
      env: options.env,
      input: options.stdin,
      encoding: "utf8",
      windowsHide: true,
      timeout: options.timeoutMs,
      maxBuffer: options.maxOutputBytes,
    });
    return record({
      exitCode: result.status,
      signal: result.signal,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      timedOut: result.error?.code === "ETIMEDOUT",
      truncated: result.error?.code === "ENOBUFS",
      durationMs: performance.now() - started,
    });
  },
};
function filePath(path) {
  assert.ok(
    !isAbsolute(path) &&
      !path.includes("\\") &&
      !path.split("/").some((part) => ["", ".", ".."].includes(part)),
    "clone path must stay relative",
  );
  const absolute = resolve(repo, path);
  assert.ok(
    relative(repo, absolute) &&
      !relative(repo, absolute).startsWith(`..${sep}`),
  );
  let current = repo;
  for (const part of path.split("/")) {
    current = join(current, part);
    if (existsSync(current))
      assert.ok(
        !lstatSync(current).isSymbolicLink(),
        "clone paths must not follow symlinks",
      );
  }
  return absolute;
}
const clone = {
  root: git(["rev-parse", "--show-toplevel"]),
  env: { ...env, GIT_DIR: join(workspace, "hostile-git-dir") },
  get platform() {
    return platform;
  },
  lock(paths) {
    const pending = beforeLock;
    beforeLock = undefined;
    pending?.();
    assert.ok(paths.length > 0 && paths.length <= 3);
    const held = [];
    const release = () => {
      for (const [path, bytes] of held) {
        if (existsSync(path) && readFileSync(path).equals(bytes))
          unlinkSync(path);
      }
    };
    try {
      for (const path of paths) {
        assert.ok(
          resolve(path).startsWith(resolve(clone.root, ".git") + sep) &&
            path.endsWith(".lock"),
          "fixture locks must stay within verified Git metadata",
        );
        mkdirSync(dirname(path), { recursive: true });
        const bytes = Buffer.from(`owned fixture lock ${sequence}`);
        writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
        held.push([path, bytes]);
      }
      const inspect = afterLock;
      afterLock = undefined;
      inspect?.();
      return { release };
    } catch (failure) {
      release();
      throw failure;
    }
  },
  list(path, maxEntries) {
    const target = filePath(path);
    if (!existsSync(target)) return [];
    const entries = readdirSync(target);
    assert.ok(
      entries.length <= maxEntries,
      "clone directory listing must be bounded",
    );
    return entries;
  },
  read(path, maxBytes) {
    const target = filePath(path);
    if (!existsSync(target)) return undefined;
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.size > maxBytes) return undefined;
    return new Uint8Array(readFileSync(target));
  },
  create(path, bytes, options) {
    const target = filePath(path);
    mkdirSync(dirname(target), { recursive: true });
    try {
      writeFileSync(target, bytes, {
        flag: "wx",
        mode: options.executable ? 0o700 : 0o600,
      });
    } catch (error) {
      if (error.code === "EEXIST") return false;
      throw error;
    }
    if (options.executable && process.platform !== "win32")
      chmodSync(target, 0o700);
    if (abortAfterCreate) {
      abortAfterCreate = false;
      invocationController.abort(new Error("controlled create interruption"));
    }
    return true;
  },
  remove(path, expected) {
    const current = this.read(path, expected.length + 1);
    if (
      current === undefined ||
      !Buffer.from(current).equals(Buffer.from(expected))
    )
      return false;
    unlinkSync(filePath(path));
    return true;
  },
  inspect(path) {
    const target = filePath(path);
    if (!existsSync(target)) return undefined;
    const stat = lstatSync(target);
    return {
      regular: stat.isFile(),
      executable: executableMode ?? Boolean(stat.mode & 0o111),
    };
  },
};
const opened = await sqliteStore.open({
  path: join(workspace, "state.sqlite"),
  readOnly: false,
});
assert.ok(opened.ok);
const owner = new StateOwner(opened.handle.value, { now: () => Date.now() });
owner.initialize();
const isolation = await nodeRunIsolation.open();
assert.ok(isolation.ok);
let sequence = 0;
const script = join(repo, "hook-command.mjs");
writeFileSync(
  script,
  'import { appendFileSync } from "node:fs"; appendFileSync(process.argv[2], "called\\n");\n',
);
const hookLog = join(workspace, "hook-calls.txt");
const config = {
  remote: "origin",
  worktreeRoot: ".worktrees",
  commandTimeoutMs: 15000,
  maxOutputBytes: 1048576,
  maxWorktrees: 64,
  fetchBeforeClean: true,
  hookArea: "common",
  hookDirectory: "hooks",
  hookCommand: {
    executable: process.execPath,
    args: [script, hookLog],
    files: ["hook-command.mjs"],
  },
  hookMaxBytes: 16384,
  envNames: [
    ...new Set([
      Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH",
      "PATHEXT",
      "SystemRoot",
      "SYSTEMROOT",
      "WINDIR",
      "HOME",
      "USERPROFILE",
      "TEMP",
      "TMP",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_CONFIG_GLOBAL",
      "GIT_TERMINAL_PROMPT",
      "GIT_PAGER",
      "GIT_DIR",
    ]),
  ],
};
const roots = {
  project: clone.root,
  git: git(["rev-parse", "--absolute-git-dir"]),
  common: git(["rev-parse", "--path-format=absolute", "--git-common-dir"]),
};
function areaPath(path, area = "project") {
  const target = resolve(roots[area], path);
  return relative(resolve(clone.root), target).split(sep).join("/");
}
const files = {
  root: clone.root,
  roots,
  read(path, maxBytes, area) {
    const bytes = clone.read(areaPath(path, area), maxBytes);
    return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
  },
  inspect(path, area) {
    const selected = areaPath(path, area);
    const info = clone.inspect(selected);
    return info === undefined
      ? undefined
      : { ...info, size: lstatSync(filePath(selected)).size };
  },
  list(path, maxEntries, area) {
    return clone.list(areaPath(path, area), maxEntries);
  },
  lock(paths) {
    return clone.lock(paths);
  },
  write(path, text, options = {}) {
    assert.equal(
      options.expected,
      null,
      "fixture hook writes must be exclusive creates",
    );
    if (
      !clone.create(
        areaPath(path, options.area),
        new TextEncoder().encode(text),
        { executable: options.executable === true },
      )
    )
      throw new ForgeFailure({
        code: "INPUT_CONFLICT",
        message: "fixture file already exists",
        retry: "never",
      });
  },
  remove(path, options = {}) {
    assert.equal(
      typeof options.expected,
      "string",
      "fixture hook removal must check expected bytes",
    );
    if (
      !clone.remove(
        areaPath(path, options.area),
        new TextEncoder().encode(options.expected),
      )
    )
      throw new ForgeFailure({
        code: "INPUT_CONFLICT",
        message: "fixture file contents changed",
        retry: "never",
      });
  },
};
const environment = {
  get platform() {
    return platform;
  },
  select(names) {
    return Object.fromEntries(
      names
        .filter((name) => clone.env[name] !== undefined)
        .map((name) => [name, clone.env[name]]),
    );
  },
};
async function call(operation, input = {}, overrides = {}) {
  invocationController = new AbortController();
  const signal = invocationController.signal;
  const context = {
    variant: "project",
    actor: { kind: "agent", id: "fixture" },
    project: { id: repo },
  };
  const client = createStateClient({
    owner,
    namespace,
    context,
    write: !["worktree.list", "hook.status"].includes(operation),
    requestId: `git-${++sequence}`,
  });
  const encoded = await isolation.handle.value.run({
    source,
    filename: "git-entry.cjs",
    operation,
    args: {
      input,
      config: { ...config, ...overrides },
      services: {
        process: processPort,
        files,
        environment,
        state: {
          ...client,
          putMany(entries, options) {
            const effect = beforeBatch;
            beforeBatch = undefined;
            effect?.();
            return client.putMany(entries, options);
          },
        },
      },
      signal,
      deadline: Date.now() + 15000,
    },
    encode: JSON.stringify,
    fail: (code, message) => {
      throw new ForgeFailure({ code, message, retry: "never" });
    },
    timeoutMs: 15000,
    deadline: Date.now() + 15000,
    signal,
    settled() {},
  });
  return JSON.parse(encoded);
}
async function error(code, action) {
  await assert.rejects(
    action,
    (failure) => failure instanceof ForgeFailure && failure.error.code === code,
    `expected ${code}`,
  );
}
const create = (name, extra = {}, overrides = {}) =>
  call(
    "worktree.create",
    {
      name,
      branch: `feature/${name}`,
      expectRevision: 0,
      ...extra,
    },
    overrides,
  );
const head = (tree) => git(["rev-parse", "HEAD"], join(repo, tree.path));
function safeCommands() {
  for (const args of calls) {
    assert.ok(
      !args.some((arg) =>
        ["--force", "--force-with-lease", "--no-verify", "-f"].includes(arg),
      ),
      "block commands must never pass force or hook-bypass flags",
    );
    assert.ok(
      !args.some((arg) => /(?:core\.hooksPath|commit\.gpgsign)=/.test(arg)),
      "block must never inject a hook bypass",
    );
    if (args[0] === "fetch")
      assert.match(
        args.at(-1),
        /^\+refs\/heads\/[^:]+:refs\/remotes\/[^:]+$/,
        "fetch refresh must allow rewrites only in remote-tracking refs",
      );
  }
}
try {
  if (["all", "failed-create", "failed-create-process"].includes(mode)) {
    const variants =
      mode === "all"
        ? ["existing", "process"]
        : [mode === "failed-create" ? "existing" : "process"];
    for (const variant of variants) {
      namespace = `forge/git-failed-create-${variant}`;
      for (let index = 0; index < 5; ++index) {
        const name = `failed-${variant}-${index}`;
        const target = join(repo, ".worktrees", name);
        if (variant === "existing") {
          mkdirSync(target, { recursive: true });
          writeFileSync(join(target, "user.txt"), "keep user files\n");
        } else failNextWorktreeAdd = true;
        await error("GIT_FAILED", () =>
          create(name, { base: initial }, { maxWorktrees: 3 }),
        );
        assert.equal(
          owner.get(namespace, `worktree:.worktrees/${name}`),
          undefined,
          "failed creation with no Git registration must retire its reservation",
        );
        if (variant === "existing")
          assert.equal(
            readFileSync(join(target, "user.txt"), "utf8"),
            "keep user files\n",
            "reconciliation must preserve files at an unregistered path",
          );
      }
      await call(
        "worktree.clean",
        { dryRun: false },
        { maxWorktrees: 3, fetchBeforeClean: false },
      );
      await call("worktree.list", {}, { maxWorktrees: 3 });
      assert.equal(
        owner.list(namespace, "worktree:").length,
        0,
        "failed add churn must not exhaust bounded reservation capacity",
      );
    }
    namespace = "forge/git";
    console.log(
      `PASS ${mode === "failed-create-process" ? "failed-create-process" : "failed-create"}: repeated failed adds retire absent registrations without deleting user files`,
    );
    if (mode === "all")
      console.log(
        "PASS failed-create-process: injected Git failures leave no exhausted reservations",
      );
  }
  if (["all", "reconcile-absent", "reconcile-adopt"].includes(mode)) {
    namespace = "forge/git-reconcile";
    const binding = (name, status) => ({
      path: `.worktrees/${name}`,
      branch: `feature/${name}`,
      base: initial,
      baseSha: initial,
      status,
    });
    const seed = (name, status) =>
      owner.put(
        namespace,
        `worktree:.worktrees/${name}`,
        binding(name, status),
        { kind: "agent", id: "crashed-creator" },
        { expectRevision: 0 },
      );
    if (mode !== "reconcile-adopt") {
      for (const status of ["creating", "uncertain"]) {
        const name = `orphan-${status}`;
        const target = join(repo, ".worktrees", name);
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, "user.txt"), "unregistered user files\n");
        seed(name, status);
        const before = owner.get(namespace, `worktree:.worktrees/${name}`);
        const events = owner.events(namespace).length;
        await call(
          "worktree.clean",
          { dryRun: true },
          { fetchBeforeClean: false },
        );
        assert.deepEqual(
          owner.get(namespace, `worktree:.worktrees/${name}`),
          before,
          "dry run must not retire an interrupted creation",
        );
        assert.equal(
          owner.events(namespace).length,
          events,
          "dry run reconciliation must not emit state events",
        );
        await call(
          "worktree.clean",
          { dryRun: false },
          { fetchBeforeClean: false },
        );
        assert.equal(
          owner.get(namespace, `worktree:.worktrees/${name}`),
          undefined,
          "absent Git registration must retire crashed creation binding",
        );
        assert.equal(
          readFileSync(join(target, "user.txt"), "utf8"),
          "unregistered user files\n",
        );
      }
      console.log(
        "PASS reconcile-absent: creating and uncertain absent registrations retire without deleting user content",
      );
    }
    if (mode !== "reconcile-absent") {
      for (const status of ["creating", "uncertain"]) {
        const name = `adopt-${status}`;
        const target = join(repo, ".worktrees", name);
        git(["worktree", "add", "-b", `feature/${name}`, target, initial]);
        seed(name, status);
        if (status === "uncertain")
          writeFileSync(
            join(target, "user.txt"),
            "dirty interrupted work survives\n",
          );
        const before = owner.get(namespace, `worktree:.worktrees/${name}`);
        await call(
          "worktree.clean",
          { dryRun: true },
          { fetchBeforeClean: false },
        );
        assert.deepEqual(
          owner.get(namespace, `worktree:.worktrees/${name}`),
          before,
          "dry run must not adopt a registered interrupted creation",
        );
        await call(
          "worktree.clean",
          { dryRun: false },
          { fetchBeforeClean: false },
        );
        const accepted = owner.get(namespace, `worktree:.worktrees/${name}`);
        assert.equal(
          accepted?.value.status,
          "active",
          "matching registered creation must be adopted into active binding",
        );
        assert.equal(accepted.value.baseSha, initial);
        assert.equal(git(["rev-parse", "HEAD"], target), initial);
        assert.ok(
          existsSync(target),
          "adopted unstarted worktree must never be reaped",
        );
        if (status === "uncertain") {
          assert.equal(
            readFileSync(join(target, "user.txt"), "utf8"),
            "dirty interrupted work survives\n",
          );
          unlinkSync(join(target, "user.txt"));
        }
        await call("worktree.remove", {
          path: `.worktrees/${name}`,
          expectedHead: initial,
          expectRevision: accepted.revision,
        });
      }
      const name = "adopt-mismatch";
      const target = join(repo, ".worktrees", name);
      git(["worktree", "add", "-b", `feature/${name}`, target, parentWip]);
      seed(name, "creating");
      writeFileSync(join(target, "user.txt"), "dirty mismatch survives\n");
      await call(
        "worktree.clean",
        { dryRun: false },
        { fetchBeforeClean: false },
      );
      assert.notEqual(
        owner.get(namespace, `worktree:.worktrees/${name}`)?.value.status,
        "active",
        "mismatched creation head must not be adopted",
      );
      assert.equal(
        readFileSync(join(target, "user.txt"), "utf8"),
        "dirty mismatch survives\n",
      );
      unlinkSync(join(target, "user.txt"));
      git(["reset", "--hard", initial], target);
      await call(
        "worktree.clean",
        { dryRun: false },
        { fetchBeforeClean: false },
      );
      const fixed = owner.get(namespace, `worktree:.worktrees/${name}`);
      assert.equal(
        fixed?.value.status,
        "active",
        "uncertain creation must reconcile after external identity is repaired",
      );
      await call("worktree.remove", {
        path: `.worktrees/${name}`,
        expectedHead: initial,
        expectRevision: fixed.revision,
      });
      const branchName = "adopt-branch-mismatch";
      const branchTarget = join(repo, ".worktrees", branchName);
      git([
        "worktree",
        "add",
        "-b",
        "feature/other-owner",
        branchTarget,
        initial,
      ]);
      seed(branchName, "uncertain");
      await call(
        "worktree.clean",
        { dryRun: false },
        { fetchBeforeClean: false },
      );
      assert.notEqual(
        owner.get(namespace, `worktree:.worktrees/${branchName}`)?.value.status,
        "active",
        "matching head with a different branch must not be adopted",
      );
      assert.equal(
        git(["symbolic-ref", "--short", "HEAD"], branchTarget),
        "feature/other-owner",
      );
      git(["branch", "-m", `feature/${branchName}`], branchTarget);
      await call(
        "worktree.clean",
        { dryRun: false },
        { fetchBeforeClean: false },
      );
      const corrected = owner.get(
        namespace,
        `worktree:.worktrees/${branchName}`,
      );
      assert.equal(
        corrected?.value.status,
        "active",
        "corrected branch identity must permit explicit reconciliation",
      );
      await call("worktree.remove", {
        path: `.worktrees/${branchName}`,
        expectedHead: initial,
        expectRevision: corrected.revision,
      });
      console.log(
        "PASS reconcile-adopt: matching creation adopts; mismatched dirty work survives and reconciles after repair",
      );
    }
    namespace = "forge/git";
  }
  if (["all", "reconcile-live"].includes(mode)) {
    namespace = "forge/git-live-create";
    const path = ".worktrees/live-creating";
    owner.put(
      namespace,
      `worktree:${path}`,
      {
        path,
        branch: "feature/live-creating",
        base: initial,
        baseSha: initial,
        status: "creating",
      },
      { kind: "agent", id: "live-creator" },
      { expectRevision: 0 },
    );
    const record = owner.get(namespace, `worktree:${path}`);
    const lock = join(repo, ".git/forge-worktree-create.lock");
    const held = "another invocation owns creation\n";
    writeFileSync(lock, held, { flag: "wx" });
    try {
      await assert.rejects(
        () =>
          call(
            "worktree.clean",
            { dryRun: false },
            { fetchBeforeClean: false },
          ),
        "reconciliation must refuse another invocation's live creation lock",
      );
      assert.deepEqual(
        owner.get(namespace, `worktree:${path}`),
        record,
        "live creation reservation must not be retired",
      );
      assert.equal(
        readFileSync(lock, "utf8"),
        held,
        "reconciliation must not reap another invocation's lock",
      );
      await assert.rejects(
        () => create("live-competing", { base: initial }),
        "create must share the reconciliation exclusion lock",
      );
      assert.equal(existsSync(join(repo, ".worktrees/live-competing")), false);
    } finally {
      unlinkSync(lock);
    }
    await call(
      "worktree.clean",
      { dryRun: false },
      { fetchBeforeClean: false },
    );
    assert.equal(
      owner.get(namespace, `worktree:${path}`),
      undefined,
      "released creation lock must permit explicit reconciliation",
    );
    namespace = "forge/git";
    console.log(
      "PASS reconcile-live: held clone creation lock excludes cleanup and creation without stealing ownership",
    );
  }
  if (["all", "squash-dryrun", "squash-no-author"].includes(mode)) {
    namespace = "forge/git-squash-readonly";
    const tree = await create("squash-readonly");
    commit(
      join(repo, tree.path),
      "readonly-first.txt",
      "first readonly change\n",
    );
    const sha = commit(
      join(repo, tree.path),
      "readonly-second.txt",
      "second readonly change\n",
    );
    git(["merge", "--squash", tree.branch]);
    git(["commit", "-m", "actual combined readonly patch"]);
    git(["push", "origin", "trunk"]);
    git(["merge-base", "--is-ancestor", sha, "trunk"], repo, [1]);
    const check = async (withoutAuthor) => {
      if (withoutAuthor) {
        git(["config", "--local", "--unset", "user.name"]);
        git(["config", "--local", "--unset", "user.email"]);
        git(["config", "--local", "user.useConfigOnly", "true"]);
      }
      const before = git(["count-objects", "-v"]);
      let preview;
      try {
        await assert.doesNotReject(async () => {
          preview = await call(
            "worktree.clean",
            { dryRun: true },
            { fetchBeforeClean: false },
          );
        }, "squash dry run must not require an author identity");
        assert.equal(
          git(["count-objects", "-v"]),
          before,
          "squash dry run must not create Git objects",
        );
        assert.equal(
          preview.outcomes.find((row) => row.path === tree.path)?.wouldRemove,
          true,
          "read-only squash detection must preserve multi-commit eligibility",
        );
        assert.ok(
          existsSync(join(repo, tree.path)),
          "dry run must preserve squash merged worktree",
        );
      } finally {
        if (withoutAuthor) {
          git(["config", "--local", "user.name", "Fixture Author"]);
          git(["config", "--local", "user.email", "fixture@example.invalid"]);
          git(["config", "--local", "--unset", "user.useConfigOnly"]);
        }
      }
    };
    if (mode !== "squash-no-author") await check(false);
    if (mode !== "squash-dryrun") await check(true);
    const cleaned = await call(
      "worktree.clean",
      { dryRun: false },
      { fetchBeforeClean: false },
    );
    assert.equal(
      cleaned.outcomes.find((row) => row.path === tree.path)?.removed,
      true,
      "actual cleanup must agree with read-only squash eligibility",
    );
    namespace = "forge/git";
    if (mode !== "squash-no-author")
      console.log(
        "PASS squash-dryrun: multi-commit squash eligibility leaves object count unchanged",
      );
    if (mode !== "squash-dryrun")
      console.log(
        "PASS squash-no-author: squash preview needs no author and agrees with cleanup",
      );
  }
  if (["all", "churn"].includes(mode)) {
    namespace = "forge/git-churn";
    for (let index = 0; index < 5; ++index) {
      const tree = await create(
        `churn-${index}`,
        { base: initial },
        { maxWorktrees: 3 },
      );
      await call(
        "worktree.remove",
        {
          path: tree.path,
          expectedHead: tree.head,
          expectRevision: tree.revision,
        },
        { maxWorktrees: 3 },
      );
    }
    await assert.doesNotReject(
      () => call("worktree.list", {}, { maxWorktrees: 3 }),
      "removed bindings must not exhaust bounded worktree scans",
    );
    assert.equal(
      owner.list(namespace, "worktree:").length,
      0,
      "successful removal must retire active binding storage",
    );
    await assert.doesNotReject(
      () =>
        call(
          "worktree.clean",
          { dryRun: false },
          { maxWorktrees: 3, fetchBeforeClean: false },
        ),
      "cleanup must remain usable after churn beyond maxWorktrees",
    );
    for (let index = 0; index < 5; ++index)
      owner.put(
        namespace,
        `worktree:.worktrees/legacy-${index}`,
        {
          path: `.worktrees/legacy-${index}`,
          branch: `feature/legacy-${index}`,
          base: initial,
          baseSha: initial,
          status: "removed",
        },
        { kind: "agent", id: "legacy-fixture" },
        { expectRevision: 0 },
      );
    const legacyEvents = owner.events(namespace).length;
    await assert.doesNotReject(
      () => call("worktree.list", {}, { maxWorktrees: 3 }),
      "read-only listing must skip overflowing legacy removed bindings",
    );
    assert.equal(
      owner.list(namespace, "worktree:").length,
      5,
      "read-only listing must preserve legacy records",
    );
    assert.equal(
      owner.events(namespace).length,
      legacyEvents,
      "read-only legacy scans must emit no state mutations",
    );
    await call(
      "worktree.clean",
      { dryRun: false },
      { maxWorktrees: 3, fetchBeforeClean: false },
    );
    assert.equal(
      owner.list(namespace, "worktree:").length,
      0,
      "non-dry cleanup must retire all legacy removed records",
    );
    await call("worktree.list", {}, { maxWorktrees: 3 });
    assert.equal(
      git(["worktree", "list", "--porcelain"]).split("worktree ").length - 1,
      1,
    );
    namespace = "forge/git";
    console.log(
      "PASS churn: five distinct create/remove paths keep bounded list/clean usable and retire bindings",
    );
  }
  if (["all", "capacity", "capacity-race"].includes(mode)) {
    namespace = "forge/git-capacity";
    const binding = (name, status) => ({
      path: `.worktrees/${name}`,
      branch: `feature/${name}`,
      base: initial,
      baseSha: initial,
      status,
    });
    const actor = { kind: "agent", id: "competing-fixture" };
    if (mode !== "capacity-race") {
      for (let index = 0; index < 3; ++index)
        owner.put(
          namespace,
          `worktree:.worktrees/reserved-${index}`,
          binding(`reserved-${index}`, index % 2 ? "uncertain" : "creating"),
          actor,
          { expectRevision: 0 },
        );
      await error("LIMIT_EXCEEDED", () =>
        create("over-capacity", { base: initial }, { maxWorktrees: 3 }),
      );
      assert.equal(
        existsSync(join(repo, ".worktrees/over-capacity")),
        false,
        "full reservation capacity must launch no worktree mutation",
      );
      git(
        ["show-ref", "--verify", "--quiet", "refs/heads/feature/over-capacity"],
        repo,
        [1],
      );
      assert.equal(
        owner.list(namespace, "worktree:").length,
        3,
        "denied reservation must leave bounded state unchanged",
      );
    }
    namespace = "forge/git-capacity-race";
    for (let index = 0; index < 2; ++index)
      owner.put(
        namespace,
        `worktree:.worktrees/race-${index}`,
        binding(`race-${index}`, "creating"),
        actor,
        { expectRevision: 0 },
      );
    beforeBatch = () => {
      const sentinel = owner.get(namespace, "capacity:worktree");
      owner.putMany(
        namespace,
        [
          {
            key: "worktree:.worktrees/race-winner",
            value: binding("race-winner", "uncertain"),
            expectRevision: 0,
          },
          {
            key: "capacity:worktree",
            value: null,
            expectRevision: sentinel?.revision ?? 0,
          },
        ],
        actor,
      );
    };
    await error("REVISION_CONFLICT", () =>
      create("race-loser", { base: initial }, { maxWorktrees: 3 }),
    );
    assert.equal(
      beforeBatch,
      undefined,
      "reservation must atomically batch the binding with capacity evidence",
    );
    assert.equal(
      owner.list(namespace, "worktree:").length,
      3,
      "competing distinct reservations must not exceed configured capacity",
    );
    assert.equal(
      owner.get(namespace, "worktree:.worktrees/race-loser"),
      undefined,
    );
    assert.equal(existsSync(join(repo, ".worktrees/race-loser")), false);
    namespace = "forge/git";
    console.log(
      "PASS capacity: creating/uncertain reservations fill the limit; competing distinct reservation loses atomically",
    );
  }
  if (["all", "rewritten-default"].includes(mode)) {
    namespace = "forge/git-rewritten";
    const localTrunk = git(["rev-parse", "refs/heads/trunk"]);
    const tree = git(["rev-parse", `${initial}^{tree}`]);
    const rewrite = (message) =>
      git(
        [
          "-c",
          "user.name=Fixture Author",
          "-c",
          "user.email=fixture@example.invalid",
          "commit-tree",
          tree,
          "-m",
          message,
        ],
        remote,
      );
    const first = rewrite("rewritten remote root");
    git(["update-ref", "refs/heads/trunk", first, initial], remote);
    let created;
    await assert.doesNotReject(async () => {
      created = await create("rewritten-default");
    }, "no-base create must follow a rewritten remote default");
    assert.equal(
      created.head,
      first,
      "created worktree must use rewritten remote SHA",
    );
    const second = rewrite("rewritten remote root again");
    git(["update-ref", "refs/heads/trunk", second, first], remote);
    let cleaned;
    await assert.doesNotReject(async () => {
      cleaned = await call(
        "worktree.clean",
        { dryRun: false },
        { fetchBeforeClean: true },
      );
    }, "fetch-before-clean must follow a rewritten remote default");
    assert.equal(cleaned.baseSha, second);
    assert.equal(git(["rev-parse", "refs/remotes/origin/trunk"]), second);
    assert.equal(
      git(["rev-parse", "refs/heads/trunk"]),
      localTrunk,
      "refreshing tracking evidence must not move local trunk",
    );
    assert.equal(
      git(["rev-parse", `refs/heads/${created.branch}`]),
      first,
      "refreshing tracking evidence must not move feature branches",
    );
    for (const args of calls.filter((args) => args[0] === "fetch"))
      assert.match(
        args.at(-1),
        /^\+refs\/heads\/[^:]+:refs\/remotes\/[^:]+$/,
        "fetch refresh must allow rewrites only in remote-tracking refs",
      );
    await call("worktree.remove", {
      path: created.path,
      expectedHead: created.head,
      expectRevision: created.revision,
    });
    git(["update-ref", "refs/heads/trunk", initial, second], remote);
    namespace = "forge/git";
    console.log(
      "PASS rewritten-default: no-base creation and fetch cleanup follow rewritten tracking refs without moving local branches",
    );
  }
  if (["all", "base"].includes(mode)) {
    const tree = await create("base");
    assert.equal(
      tree.head,
      initial,
      "default base must be remote default, not parent WIP",
    );
    assert.notEqual(tree.head, parentWip);
    assert.equal(tree.base, "refs/remotes/origin/trunk");
    assert.equal(head(tree), initial);
    assert.equal(
      owner.get("forge/git", `worktree:${tree.path}`).value.status,
      "active",
    );
    await error("GIT_FAILED", () =>
      create("invalid", { base: "missing-base" }),
    );
    assert.equal(
      existsSync(join(repo, ".worktrees/invalid")),
      false,
      "invalid base must leave no worktree",
    );
    assert.equal(
      git(
        ["show-ref", "--verify", "--quiet", "refs/heads/feature/invalid"],
        repo,
        [1],
      ),
      "",
    );
    assert.equal(
      owner.get("forge/git", "worktree:.worktrees/invalid"),
      undefined,
      "invalid base must leave no reservation",
    );
    console.log(
      "PASS base: remote default despite parent WIP; invalid base leaves no branch/worktree/reservation",
    );
  }
  if (["all", "unstarted"].includes(mode)) {
    const trees = [];
    for (const name of ["untouched", "dirty", "untracked"])
      trees.push(await create(name));
    writeFileSync(join(repo, trees[1].path, "seed.txt"), "uncommitted work\n");
    writeFileSync(join(repo, trees[2].path, "new.txt"), "untracked work\n");
    const listed = await call("worktree.list");
    for (const tree of trees)
      assert.ok(
        listed.worktrees.some(
          (item) => item.branch === tree.branch && item.head === tree.head,
        ),
        `listed worktree identity must match binding: ${JSON.stringify(listed)}`,
      );
    const result = await call("worktree.clean", { dryRun: false });
    for (const tree of trees) {
      assert.ok(
        existsSync(join(repo, tree.path)),
        "unstarted worktree must survive cleanup",
      );
      assert.equal(
        result.outcomes.find((outcome) => outcome.path === tree.path)?.reason,
        "unstarted",
        "unstarted classification must precede ancestry and dirt checks",
      );
    }
    assert.equal(
      readFileSync(join(repo, trees[1].path, "seed.txt"), "utf8"),
      "uncommitted work\n",
    );
    assert.equal(
      readFileSync(join(repo, trees[2].path, "new.txt"), "utf8"),
      "untracked work\n",
    );
    console.log("PASS unstarted: pristine, dirty and untracked work kept");
  }
  if (["all", "merge"].includes(mode)) {
    const tree = await create("merged");
    const sha = commit(join(repo, tree.path), "merged.txt", "normal merge\n");
    git(["merge", "--no-edit", tree.branch]);
    git(["push", "origin", "trunk"]);
    const preview = await call(
      "worktree.clean",
      { dryRun: true },
      { fetchBeforeClean: false },
    );
    assert.equal(
      preview.outcomes.find((row) => row.path === tree.path)?.wouldRemove,
      true,
      "normal merge must be eligible",
    );
    assert.ok(
      existsSync(join(repo, tree.path)),
      "dry run must preserve eligible work",
    );
    const result = await call("worktree.clean", { dryRun: false });
    assert.equal(
      result.outcomes.find((row) => row.path === tree.path)?.removed,
      true,
      "normal merged worktree must be removed",
    );
    assert.equal(existsSync(join(repo, tree.path)), false);
    assert.equal(
      owner.get("forge/git", `worktree:${tree.path}`),
      undefined,
      "merged cleanup must retire its binding",
    );
    assert.equal(
      git(["rev-parse", `refs/heads/${tree.branch}`]),
      sha,
      "cleanup must preserve branch",
    );
    console.log(
      "PASS merge: dry run, removal, binding readback and branch preservation",
    );
  }
  if (["all", "squash"].includes(mode)) {
    const tree = await create("squashed");
    commit(join(repo, tree.path), "first.txt", "first change\n");
    const sha = commit(join(repo, tree.path), "second.txt", "second change\n");
    git(["merge", "--squash", tree.branch]);
    git(["commit", "-m", "combined feature patch"]);
    git(["push", "origin", "trunk"]);
    git(["merge-base", "--is-ancestor", sha, "trunk"], repo, [1]);
    const result = await call("worktree.clean", { dryRun: false });
    assert.equal(
      result.outcomes.find((row) => row.path === tree.path)?.removed,
      true,
      "combined patch from multiple commits must count as squash merged",
    );
    assert.equal(existsSync(join(repo, tree.path)), false);
    console.log(
      "PASS squash: read-only combined patch detects multi-commit squash merge",
    );
  }
  if (["all", "removal-race"].includes(mode)) {
    const moving = await create("moving");
    const movingRoot = join(repo, moving.path);
    beforeLock = () =>
      git(
        ["commit", "--allow-empty", "-m", "started while removal waited"],
        movingRoot,
      );
    await error("SUBJECT_VERSION_CONFLICT", () =>
      call("worktree.remove", {
        path: moving.path,
        expectedHead: moving.head,
        expectRevision: moving.revision,
      }),
    );
    assert.ok(
      existsSync(movingRoot),
      "work started before Git exclusion must survive removal",
    );
    assert.notEqual(head(moving), moving.head);
    assert.equal(
      owner.get("forge/git", `worktree:${moving.path}`).value.status,
      "active",
    );
    const protectedTree = await create("protected");
    const protectedRoot = join(repo, protectedTree.path);
    let checked = false;
    afterLock = () => {
      for (const args of [
        ["commit", "--allow-empty", "-m", "must remain excluded"],
        ["switch", "--detach", "HEAD"],
        ["update-ref", `refs/heads/${protectedTree.branch}`, parentWip],
      ]) {
        const result = spawnSync("git", args, {
          cwd: protectedRoot,
          env,
          encoding: "utf8",
          windowsHide: true,
          timeout: 15000,
          maxBuffer: 1048576,
        });
        assert.notEqual(
          result.status,
          0,
          "direct Git mutations must fail under removal exclusion",
        );
        assert.match(
          result.stderr,
          /\.lock/,
          "Git exclusion failure must come from held locks",
        );
      }
      checked = true;
    };
    const removed = await call("worktree.remove", {
      path: protectedTree.path,
      expectedHead: protectedTree.head,
      expectRevision: protectedTree.revision,
    });
    assert.equal(checked, true, "removal must acquire Git exclusion");
    assert.equal(removed.removed, true);
    assert.equal(existsSync(protectedRoot), false);
    assert.equal(
      existsSync(join(repo, ".git/refs/heads", `${protectedTree.branch}.lock`)),
      false,
      "removal must release surviving branch lock",
    );
    console.log(
      "PASS removal-race: moved head survives; direct commit/switch/ref updates excluded; locks released",
    );
  }
  if (["all", "push"].includes(mode)) {
    git(["branch", "feature/push", initial]);
    const count = calls.filter((args) => args[0] === "push").length;
    await error("SUBJECT_VERSION_CONFLICT", () =>
      call("branch.push", {
        branch: "feature/push",
        remoteBranch: "review/pinned",
        expectedHead: parentWip,
      }),
    );
    assert.equal(
      calls.filter((args) => args[0] === "push").length,
      count,
      "stale expected head must never push",
    );
    beforePush = () =>
      git(["update-ref", "refs/heads/feature/push", parentWip]);
    supervised = true;
    const result = await call("branch.push", {
      branch: "feature/push",
      remoteBranch: "review/pinned",
      expectedHead: initial,
    });
    supervised = false;
    assert.equal(result.head, initial);
    assert.equal(
      git(["ls-remote", "--refs", "origin", "refs/heads/review/pinned"]),
      `${initial}\trefs/heads/review/pinned`,
      "push must pin checked head despite local branch movement",
    );
    console.log(
      "PASS push: supervised exact SHA push, moved-head rejection and remote readback",
    );
  }
  if (["all", "hook-recovery"].includes(mode)) {
    abortAfterCreate = true;
    await assert.rejects(
      () => call("hook.install", { name: "post-commit", expectRevision: 0 }),
      /controlled create interruption/,
      "interrupted hook create must report cancellation",
    );
    assert.equal(
      owner.get("forge/git", "hook:post-commit").revision,
      1,
      "interrupted create must retain the reservation revision",
    );
    assert.equal(
      owner.get("forge/git", "hook:post-commit").value.created,
      false,
    );
    assert.ok(existsSync(join(repo, ".git/hooks/post-commit")));
    assert.equal(
      (await call("hook.status", { name: "post-commit" })).owned,
      false,
      "interrupted install must remain unowned until explicit recovery",
    );
    const accepted = await call("hook.install", {
      name: "post-commit",
      expectRevision: 1,
      adoptExisting: true,
    });
    assert.equal(
      accepted.active,
      true,
      "explicit recovery must adopt exact reserved hook bytes",
    );
    assert.equal(
      (
        await call("hook.remove", {
          name: "post-commit",
          expectRevision: accepted.revision,
        })
      ).removed,
      true,
    );
    assert.equal(existsSync(join(repo, ".git/hooks/post-commit")), false);
    assert.equal(
      git(["config", "--local", "--get", "core.hooksPath"], repo, [1]),
      "",
    );
    console.log(
      "PASS hook-recovery: interrupted create stays unowned; explicit exact-byte adoption records ownership and removes cleanly",
    );
  }
  if (["hook-path", "hook-mode", "hook-dependency"].includes(mode)) {
    if (mode === "hook-path") {
      git(["config", "--local", "core.hooksPath", ".custom-hooks"]);
      let installedHook;
      try {
        installedHook = await call("hook.install", {
          name: "pre-commit",
          expectRevision: 0,
        });
      } catch (failure) {
        if (
          !(failure instanceof ForgeFailure) ||
          failure.error.code !== "EXTERNAL_UNCERTAIN"
        )
          throw failure;
      }
      assert.equal(
        existsSync(join(repo, ".git/hooks/pre-commit")),
        false,
        "mismatched effective hook path must create no file",
      );
      assert.equal(
        installedHook?.installed,
        false,
        "custom effective hooks path must win",
      );
    } else {
      assert.equal(
        (await call("hook.install", { name: "pre-commit", expectRevision: 0 }))
          .active,
        true,
      );
      if (mode === "hook-mode") {
        executableMode = false;
        platform = "linux";
        assert.equal(
          (await call("hook.status", { name: "pre-commit" })).active,
          false,
          "POSIX non-executable hook must be inactive",
        );
      } else {
        unlinkSync(script);
        assert.equal(
          (await call("hook.status", { name: "pre-commit" })).active,
          false,
          "missing dependency must deactivate hook",
        );
      }
    }
  }
  if (["all", "hooks"].includes(mode)) {
    assert.equal(
      (await call("hook.status", { name: "pre-commit" })).active,
      false,
      "hooks must be opt-in",
    );
    const native = join(repo, ".git/hooks/pre-commit");
    writeFileSync(native, "#!/bin/sh\n# user hook\nexit 0\n");
    assert.equal(
      (await call("hook.install", { name: "pre-commit", expectRevision: 0 }))
        .installed,
      false,
      "requested native user hook must be preserved",
    );
    assert.equal(
      readFileSync(native, "utf8"),
      "#!/bin/sh\n# user hook\nexit 0\n",
    );
    unlinkSync(native);
    const unrelated = join(repo, ".git/hooks/pre-push");
    writeFileSync(unrelated, "#!/bin/sh\n# unrelated user hook\nexit 0\n");
    if (process.platform !== "win32") chmodSync(unrelated, 0o700);
    const installedHook = await call("hook.install", {
      name: "pre-commit",
      expectRevision: 0,
    });
    assert.equal(
      installedHook.active,
      true,
      "explicit install must activate hook in effective directory",
    );
    assert.equal(
      readFileSync(unrelated, "utf8"),
      "#!/bin/sh\n# unrelated user hook\nexit 0\n",
      "unrelated native hooks must remain intact",
    );
    assert.equal(
      git(["config", "--local", "--get", "core.hooksPath"], repo, [1]),
      "",
      "install must not change hooksPath",
    );
    const original = readFileSync(native, "utf8");
    assert.equal(
      (
        await call("hook.install", {
          name: "pre-commit",
          expectRevision: installedHook.revision,
        })
      ).reason,
      "already-owned",
      "install must not stack wrappers",
    );
    assert.equal(readFileSync(native, "utf8"), original);
    commit(repo, "hook-invocation.txt", "exercise installed hook\n");
    assert.equal(
      readFileSync(hookLog, "utf8"),
      "called\n",
      "installed hook must run exactly once through Git",
    );
    executableMode = false;
    platform = "linux";
    assert.equal(
      (await call("hook.status", { name: "pre-commit" })).active,
      false,
      "POSIX non-executable hook must be inactive",
    );
    platform = "win32";
    assert.equal(
      (await call("hook.status", { name: "pre-commit" })).active,
      true,
      "Windows ignores executable mode",
    );
    executableMode = undefined;
    platform = process.platform;
    unlinkSync(script);
    assert.equal(
      (await call("hook.status", { name: "pre-commit" })).active,
      false,
      "missing dependency must deactivate hook",
    );
    writeFileSync(
      script,
      'import { appendFileSync } from "node:fs"; appendFileSync(process.argv[2], "called\\n");\n',
    );
    git(["config", "--local", "core.hooksPath", ".custom-hooks"]);
    assert.equal(
      (await call("hook.status", { name: "pre-commit" })).active,
      false,
      "custom effective path must deactivate owned hook",
    );
    assert.equal(
      (
        await call("hook.install", {
          name: "pre-commit",
          expectRevision: installedHook.revision,
        })
      ).reason,
      "hooks-path-mismatch",
      "custom effective hooks path must win",
    );
    assert.equal(
      (
        await call("hook.remove", {
          name: "pre-commit",
          expectRevision: installedHook.revision,
        })
      ).removed,
      true,
    );
    assert.equal(
      git(["config", "--local", "--get", "core.hooksPath"]),
      ".custom-hooks",
      "remove must preserve user's changed hooksPath",
    );
    assert.equal(
      readFileSync(unrelated, "utf8"),
      "#!/bin/sh\n# unrelated user hook\nexit 0\n",
    );
    git(["config", "--local", "--unset", "core.hooksPath"]);
    unlinkSync(unrelated);
    const firstAgain = await call("hook.install", {
      name: "pre-commit",
      expectRevision: installedHook.revision + 1,
    });
    const second = await call("hook.install", {
      name: "pre-push",
      expectRevision: 0,
    });
    assert.equal(
      (
        await call("hook.remove", {
          name: "pre-commit",
          expectRevision: firstAgain.revision,
        })
      ).removed,
      true,
    );
    assert.equal(
      (await call("hook.status", { name: "pre-push" })).active,
      true,
      "removing one hook must keep other active hooks",
    );
    assert.equal(
      (
        await call("hook.remove", {
          name: "pre-push",
          expectRevision: second.revision,
        })
      ).removed,
      true,
    );
    assert.equal(
      git(["config", "--local", "--get", "core.hooksPath"], repo, [1]),
      "",
      "uninstall must leave hook configuration untouched",
    );
    const again = await call("hook.install", {
      name: "pre-commit",
      expectRevision: firstAgain.revision + 1,
    });
    writeFileSync(native, "#!/bin/sh\n# replacement user hook\nexit 0\n");
    assert.equal(
      (
        await call("hook.remove", {
          name: "pre-commit",
          expectRevision: again.revision,
        })
      ).reason,
      "file-edited",
      "uninstall must preserve user's replacement",
    );
    assert.equal(
      readFileSync(native, "utf8"),
      "#!/bin/sh\n# replacement user hook\nexit 0\n",
    );
    console.log(
      "PASS hooks: opt-in, effective-directory ownership, native/custom preservation, no stacking, dependency/platform health, multi-hook removal and replacement preservation",
    );
  }
  safeCommands();
  const measured = Object.fromEntries(
    [...costs].map(([name, cost]) => [
      name,
      { count: cost.count, milliseconds: Math.round(cost.durationMs) },
    ]),
  );
  console.log(`Git process cost (${mode}): ${JSON.stringify(measured)}`);
} finally {
  await isolation.handle.close();
  await opened.handle.close();
}
