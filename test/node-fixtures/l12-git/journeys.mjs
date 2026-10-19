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
    return clone.lock(
      paths.map(({ path, area }) => resolve(roots[area ?? "project"], path)),
    );
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
    namespace: "forge/git",
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
      services: { process: processPort, files, environment, state: client },
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
const create = (name, extra = {}) =>
  call("worktree.create", {
    name,
    branch: `feature/${name}`,
    expectRevision: 0,
    ...extra,
  });
const head = (tree) => git(["rev-parse", "HEAD"], join(repo, tree.path));
function safeCommands() {
  for (const args of calls) {
    assert.ok(
      !args.some((arg) =>
        ["--force", "--force-with-lease", "--no-verify", "-f"].includes(arg),
      ),
      "block commands must never force or bypass hooks",
    );
    assert.ok(
      !args.some((arg) => /(?:core\.hooksPath|commit\.gpgsign)=/.test(arg)),
      "block must never inject a hook bypass",
    );
  }
}
try {
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
      owner.get("forge/git", `worktree:${tree.path}`).value.status,
      "removed",
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
      "PASS squash: combined synthetic patch detects multi-commit squash merge",
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
