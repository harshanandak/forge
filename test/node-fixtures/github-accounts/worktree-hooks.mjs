import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { createAssemblyProviders } from "../../../src/assembly/providers.ts";

const temporary = realpathSync.native(
  mkdtempSync(join(tmpdir(), "forge-worktree-hooks-")),
);
const root = join(temporary, "clone"),
  linked = join(temporary, "linked");
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key, value]) =>
      value !== undefined &&
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
      !/^GIT_/i.test(key) &&
      !/^(?:GH|GITHUB)_/i.test(key),
  ),
);
Object.assign(env, {
  HOME: temporary,
  USERPROFILE: temporary,
  GIT_CONFIG_GLOBAL: join(temporary, "global"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
});
const leases = [];
function git(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10000,
    maxBuffer: 1048576,
  });
  assert.equal(
    result.status,
    0,
    `git ${args[0]}: ${result.error?.message ?? ""} ${result.stderr}`,
  );
  return result.stdout.trimEnd();
}
function tree(directory) {
  if (!existsSync(directory)) return null;
  return Object.fromEntries(
    readdirSync(directory, { withFileTypes: true })
      .map((entry) => [
        entry.name,
        entry.isDirectory()
          ? tree(join(directory, entry.name))
          : readFileSync(join(directory, entry.name)).toString("base64"),
      ])
      .filter(
        ([, value]) =>
          typeof value === "string" || Object.keys(value).length > 0,
      ),
  );
}
const common = join(root, ".git"),
  managed = join(common, ".forge-github-accounts");
const custom = join(temporary, "custom-hooks");
let linkedGit;
function snapshot() {
  return {
    config: readFileSync(join(common, "config")).toString("base64"),
    worktree: existsSync(join(linkedGit, "config.worktree"))
      ? readFileSync(join(linkedGit, "config.worktree")).toString("base64")
      : null,
    managed: tree(managed),
    custom: tree(custom),
  };
}
const module = { exports: {} };
runInNewContext(
  stripTypeScriptTypes(
    readFileSync(
      new URL("../../../src/blocks/github-accounts/entry.cts", import.meta.url),
      "utf8",
    ),
  ),
  {
    module,
    fail(code, message) {
      throw Object.assign(new Error(message), { code });
    },
  },
);
async function services(cwd) {
  const scope = {
    op: "github-account.hook",
    effects: [
      "external:process",
      "files:read",
      "files:write",
      "environment:read",
    ],
    signal: new AbortController().signal,
    deadline: Date.now() + 60000,
    processContainment: "supervised",
  };
  const providers = createAssemblyProviders(cwd, { env });
  const files = await providers.openFiles(scope);
  leases.push(files);
  const repository = await providers.repository(scope);
  leases.push(repository);
  const account = await providers.account(scope);
  leases.push(account);
  return {
    files: files.value,
    repository: repository.value,
    account: account.value,
    process: providers.process(scope),
    environment: providers.environment(scope),
    crypto: providers.crypto(scope),
  };
}
async function conflict(s, config, override) {
  const before = snapshot();
  await assert.rejects(
    module.exports["github-account.hook"]({
      input: { enabled: true },
      services: s,
      config,
    }),
    (error) => {
      assert.equal(
        error.code,
        "ACCOUNT_HOOKS_CONFLICT",
        `worktree overrides must produce the typed hook conflict: ${error.message}`,
      );
      assert.ok(
        error.message.replace(/\\/g, "/").includes(linked.replace(/\\/g, "/")),
        `conflict must identify its worktree path: ${error.message}`,
      );
      assert.ok(
        error.message.includes(JSON.stringify(override)),
        "conflict must identify the configured override, including empty values",
      );
      return true;
    },
    "linked-worktree hook override must refuse guard installation or retry",
  );
  assert.deepEqual(
    snapshot(),
    before,
    "refusal must preserve common config, worktree config, metadata and scripts byte-for-byte",
  );
}
try {
  mkdirSync(root);
  git(root, "init");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@example.com");
  git(root, "commit", "--allow-empty", "-m", "fixture");
  git(root, "worktree", "add", "-b", "linked", linked);
  git(root, "config", "extensions.worktreeConfig", "true");
  linkedGit = git(linked, "rev-parse", "--path-format=absolute", "--git-dir");
  const gitExec = git(root, "--exec-path");
  const gitBase = dirname(dirname(dirname(gitExec)));
  const shellProgram =
    process.platform === "win32"
      ? [join(gitBase, "usr/bin/sh.exe"), join(gitBase, "bin/bash.exe")].find(
          existsSync,
        )
      : "/bin/sh";
  assert.ok(shellProgram, "configured POSIX shell is available");
  const envProgram =
    process.platform === "win32"
      ? join(dirname(shellProgram), "env.exe")
      : "/usr/bin/env";
  const config = {
    environmentNames: Object.keys(env),
    gitProgram: "git",
    ghProgram: process.execPath,
    ghArgs: [],
    commandTimeoutMs: 10000,
    maxOutputBytes: 65536,
    maxFileBytes: 1048576,
    maxCommits: 100,
    coauthorPolicy: "allow",
    aiCoauthorPatterns: [],
    forgeCommand: [process.execPath, "fixture-forge"],
    shellProgram,
    envProgram,
    allowedGhCommands: [],
    identityName: "profile",
    identityEmail: "noreply",
  };
  mkdirSync(managed);
  writeFileSync(
    join(managed, "metadata.json"),
    JSON.stringify({
      version: 1,
      account: "fixture",
      name: "Fixture",
      email: "fixture@example.com",
      emails: ["fixture@example.com"],
      automatic: false,
      previous: {},
      installed: {},
      artifacts: {},
      hooks: false,
    }),
  );
  const s = await services(root);
  mkdirSync(custom);
  writeFileSync(join(custom, "pre-push"), "#!/bin/sh\nexit 0\n");
  git(linked, "config", "--worktree", "core.hooksPath", custom);
  await conflict(s, config, custom);
  git(linked, "config", "--worktree", "core.hooksPath", "");
  await conflict(s, config, "");
  git(linked, "config", "--worktree", "--unset", "core.hooksPath");
  const beforeLateOverride = snapshot();
  let injected = false;
  const interleaved = {
    ...s,
    repository: {
      ...s.repository,
      run(program, args, options) {
        if (
          !injected &&
          args[0] === "worktree" &&
          args[1] === "list" &&
          JSON.parse(readFileSync(join(managed, "metadata.json"), "utf8")).hooks
        ) {
          git(linked, "config", "--worktree", "core.hooksPath", custom);
          injected = true;
        }
        return s.repository.run(program, args, options);
      },
    },
  };
  await assert.rejects(
    module.exports["github-account.hook"]({
      input: { enabled: true },
      services: interleaved,
      config,
    }),
    { code: "ACCOUNT_HOOKS_CONFLICT" },
    "a worktree override appearing after publication must refuse installation",
  );
  assert.equal(
    injected,
    true,
    "the interleaving must run after hook publication",
  );
  const afterLateOverride = snapshot();
  assert.equal(
    git(linked, "config", "--worktree", "--get", "core.hooksPath"),
    custom,
    "rollback must preserve the independently introduced worktree override",
  );
  assert.deepEqual(
    { ...afterLateOverride, worktree: beforeLateOverride.worktree },
    beforeLateOverride,
    "late refusal must restore common config, metadata and managed script bytes",
  );
  git(linked, "config", "--worktree", "--unset", "core.hooksPath");
  const enabled = await module.exports["github-account.hook"]({
    input: { enabled: true },
    services: s,
    config,
  });
  assert.equal(enabled.enabled, true);
  const owned = resolve(managed, "hooks");
  for (const cwd of [root, linked])
    assert.equal(
      resolve(
        git(cwd, "rev-parse", "--path-format=absolute", "--git-path", "hooks"),
      ),
      owned,
      "Git must actually select the owned hooks directory in every worktree",
    );
  git(linked, "config", "--worktree", "core.hooksPath", custom);
  await conflict(s, config, custom);
  git(linked, "config", "--worktree", "core.hooksPath", "");
  await conflict(s, config, "");
  git(linked, "config", "--worktree", "core.hooksPath", owned);
  assert.equal(
    (
      await module.exports["github-account.hook"]({
        input: { enabled: false },
        services: s,
        config,
      })
    ).enabled,
    false,
  );
  const linkedServices = await services(linked);
  assert.equal(
    (
      await module.exports["github-account.hook"]({
        input: { enabled: true },
        services: linkedServices,
        config,
      })
    ).enabled,
    true,
  );
  for (const cwd of [root, linked])
    assert.equal(
      resolve(
        git(cwd, "rev-parse", "--path-format=absolute", "--git-path", "hooks"),
      ),
      owned,
    );
  console.log("PASS worktree-hooks");
} finally {
  const closed = await Promise.allSettled(leases.map((lease) => lease.close()));
  rmSync(temporary, { recursive: true, force: true });
  const failed = closed.filter((result) => result.status === "rejected");
  assert.equal(
    failed.length,
    0,
    "all invocation-owned service leases must close",
  );
}
