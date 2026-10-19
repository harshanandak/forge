import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [installed, work] = process.argv.slice(2);
const { createAssembly } = await import(
  pathToFileURL(join(installed, "dist/src/assembly/index.js")).href
);
mkdirSync(work, { recursive: true });
const project = join(work, "project");
mkdirSync(project);
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name, value]) =>
      value !== undefined &&
      [
        "path",
        "pathext",
        "systemroot",
        "windir",
        "home",
        "userprofile",
        "tmp",
        "temp",
      ].includes(name.toLowerCase()),
  ),
);
Object.assign(env, {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: join(work, "empty-gitconfig"),
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
});
writeFileSync(env.GIT_CONFIG_GLOBAL, "");
let fixtureCommands = 0;
function git(args, cwd = project, accepted = [0]) {
  ++fixtureCommands;
  const result = spawnSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 1048576,
    windowsHide: true,
  });
  assert.ok(
    accepted.includes(result.status),
    `fixture Git ${args[0]}: ${result.stderr}`,
  );
  return result.stdout.trim();
}
const remote = join(work, "remote.git");
git(["init", "--bare", "--initial-branch=trunk", remote]);
git(["init", "--initial-branch=trunk"]);
git(["config", "user.name", "Fixture Author"]);
git(["config", "user.email", "fixture@example.invalid"]);
writeFileSync(join(project, "seed.txt"), "remote default\n");
git(["add", "--", "seed.txt"]);
git(["commit", "-m", "remote default"]);
const initial = git(["rev-parse", "HEAD"]);
git(["remote", "add", "origin", remote]);
git(["push", "origin", "trunk"]);
const root = git(["rev-parse", "--show-toplevel"]);
const dependency = join(root, "hook-command.mjs");
const log = join(work, "hook.log");
writeFileSync(
  dependency,
  'import { appendFileSync } from "node:fs"; appendFileSync(process.argv[2], "called\\n");\n',
);
const config = {
  envNames: Object.keys(env),
  remote: "origin",
  worktreeRoot: ".worktrees",
  commandTimeoutMs: 15000,
  maxOutputBytes: 1048576,
  maxWorktrees: 16,
  fetchBeforeClean: false,
  hookArea: "common",
  hookDirectory: "hooks",
  hookCommand: {
    executable: process.execPath,
    args: [dependency, log],
    files: ["hook-command.mjs"],
  },
  hookMaxBytes: 16384,
};
const assembly = await createAssembly({
  root,
  deviceRoot: join(work, "device"),
  providers: {
    env,
    supervision: {
      cleanupTimeoutMs: 5000,
      pollIntervalMs: 25,
      drainTimeoutMs: 100,
      maxConcurrent: 1,
    },
  },
});
let sequence = 0;
const context = {
  actor: { kind: "human", id: "fixture" },
  project: { id: assembly.root, root: assembly.root },
  device: { id: assembly.deviceRoot },
};
async function invoke(op, input = {}, caller = "human") {
  return assembly.catalog.invoke({
    schemaVersion: "forge.invocation/1",
    requestId: `git-host-${++sequence}`,
    op,
    input,
    caller,
    context,
  });
}
async function good(op, input = {}, caller = "human") {
  const response = await invoke(op, input, caller);
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.result;
}
try {
  cpSync(join(installed, "dist/src/blocks/git"), join(root, "blocks/git"), {
    recursive: true,
  });
  const shown = await good("config.show");
  await good("config.set", {
    path: "/blocks/git",
    value: { source: { path: "./blocks/git" }, config },
    expectRevision: shown.revision,
  });
  const added = await invoke("block.add", { path: "./blocks/git" });
  assert.equal(added.ok, false);
  assert.equal(added.error.code, "ADMISSION_REQUIRED");
  const digest = /sha256:[a-f0-9]{64}/.exec(added.error.repair)?.[0];
  assert.ok(digest);
  await good("block.admit", { digest });
  const denied = await invoke("worktree.list", {}, "agent");
  assert.equal(denied.ok, false);
  assert.equal(
    denied.error.code,
    "GRANT_REQUIRED",
    "host process/environment capability must require grants",
  );
  await good("config.grant", {
    digest,
    effects: [
      "external:process",
      "environment:read",
      "external:write",
      "worktree:write",
      "hook:write",
      "files:read",
      "files:write",
    ],
  });
  assert.equal(assembly.catalog.unavailable().length, 0);
  const created = await good(
    "worktree.create",
    { name: "actual-host", branch: "feature/actual-host", expectRevision: 0 },
    "agent",
  );
  assert.equal(
    created.head,
    initial,
    "shipped assembly must select the remote default",
  );
  assert.equal(git(["rev-parse", "HEAD"], join(root, created.path)), initial);
  const removed = await good(
    "worktree.remove",
    {
      path: created.path,
      expectedHead: created.head,
      expectRevision: created.revision,
    },
    "agent",
  );
  assert.equal(
    removed.removed,
    true,
    "actual host Git metadata locks must permit exact-head removal",
  );
  assert.equal(existsSync(join(root, created.path)), false);
  assert.equal(
    existsSync(join(root, ".git/refs/heads/feature/actual-host.lock")),
    false,
    "host must release metadata locks",
  );
  assert.equal(
    (await good("hook.status", { name: "pre-commit" }, "agent")).active,
    false,
  );
  const installedHook = await good(
    "hook.install",
    { name: "pre-commit", expectRevision: 0 },
    "agent",
  );
  assert.equal(
    installedHook.active,
    true,
    "actual file adapter must activate the native hook",
  );
  assert.equal(
    (await good("hook.status", { name: "pre-commit" }, "agent")).owned,
    true,
  );
  writeFileSync(join(root, "invoked.txt"), "execute installed hook\n");
  git(["add", "--", "invoked.txt"], root);
  git(["commit", "-m", "exercise installed hook"], root);
  assert.equal(
    readFileSync(log, "utf8"),
    "called\n",
    "Git must execute the shipped adapter's installed hook once",
  );
  assert.equal(
    (
      await good(
        "hook.remove",
        { name: "pre-commit", expectRevision: installedHook.revision },
        "agent",
      )
    ).removed,
    true,
  );
  assert.equal(existsSync(join(root, ".git/hooks/pre-commit")), false);
  assert.equal(
    (await good("hook.status", { name: "pre-commit" }, "agent")).active,
    false,
  );
  assert.equal(
    git(["config", "--local", "--get", "core.hooksPath"], root, [1]),
    "",
    "actual host hook lifecycle must preserve Git configuration",
  );
  console.log(
    `PASS Git assembly: actual supervised host create/remove with metadata locks; native hook install/run/status/remove; ${sequence} catalog calls, ${fixtureCommands} fixture Git commands`,
  );
} finally {
  await assembly.close();
}
