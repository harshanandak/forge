import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
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
let acquiredLeases = 0,
  closedLeases = 0;
function trackLease(lease) {
  acquiredLeases++;
  return {
    ...lease,
    async close() {
      try {
        await lease.close();
      } finally {
        closedLeases++;
      }
    },
  };
}
function assertInvocationClosed() {
  assert.equal(
    closedLeases,
    acquiredLeases,
    "all acquired service leases must close immediately when the invocation settles",
  );
}
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
const manifest = JSON.parse(
  readFileSync(
    new URL(
      "../../../src/blocks/github-accounts/forge.block.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
async function invoke(
  config,
  input,
  {
    cwd = root,
    transform = (services) => services,
    providersFactory = createAssemblyProviders,
    handler = module.exports["github-account.hook"],
  } = {},
) {
  const leases = [];
  const own = (lease) => {
    const tracked = trackLease(lease);
    leases.push(tracked);
    return tracked.value;
  };
  const scope = {
    op: "github-account.hook",
    effects: manifest.operations["github-account.hook"].effects,
    signal: new AbortController().signal,
    deadline: Date.now() + 60000,
    processContainment: "supervised",
  };
  let result,
    failure,
    failed = false;
  const cleanupErrors = [];
  try {
    const providers = providersFactory(cwd, { env });
    const files = own(await providers.openFiles(scope));
    const repository = own(await providers.repository(scope));
    const account = own(await providers.account(scope));
    result = await handler({
      input,
      config,
      services: transform({
        files,
        repository,
        account,
        process: providers.process(scope),
        environment: providers.environment(scope),
        crypto: providers.crypto(scope),
      }),
    });
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    const closed = await Promise.allSettled(
      leases.map((lease) => Promise.resolve().then(() => lease.close())),
    );
    cleanupErrors.push(
      ...closed.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      ),
    );
    try {
      assertInvocationClosed();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      failed ? [failure, ...cleanupErrors] : cleanupErrors,
      "Invocation service cleanup failed",
      { cause: failed ? failure : cleanupErrors[0] },
    );
  if (failed) throw failure;
  return result;
}
async function cleanupProbe() {
  const primary = new Error("fixture handler refusal");
  const partial = new Error("fixture partial open failure");
  const closeOne = new Error("fixture files close failure");
  const closeTwo = new Error("fixture repository close failure");
  const closed = [];
  const factory =
    ({ openFailure, closeFailures = {} } = {}) =>
    () => {
      const lease = (name) => ({
        ownership: "owned",
        value: {},
        close() {
          closed.push(name);
          if (closeFailures[name]) throw closeFailures[name];
          return Promise.resolve();
        },
      });
      return {
        openFiles: () => Promise.resolve(lease("files")),
        repository: () => Promise.resolve(lease("repository")),
        account: () => {
          if (openFailure) throw openFailure;
          return Promise.resolve(lease("account"));
        },
        process: () => ({}),
        environment: () => ({}),
        crypto: () => ({}),
      };
    };
  const settle = async (options) => {
    closed.length = 0;
    try {
      return { result: await invoke({}, {}, options) };
    } catch (error) {
      return { error };
    }
  };
  const success = await settle({
    providersFactory: factory(),
    handler: () => "success",
  });
  assert.equal(success.result, "success");
  assert.deepEqual(closed, ["files", "repository", "account"]);
  const refused = await settle({
    providersFactory: factory(),
    handler: () => {
      throw primary;
    },
  });
  assert.equal(
    refused.error,
    primary,
    "successful cleanup preserves the original refusal",
  );
  assert.deepEqual(closed, ["files", "repository", "account"]);
  const unopened = await settle({
    providersFactory: factory({ openFailure: partial }),
    handler: () => assert.fail("partial open cannot run the handler"),
  });
  assert.equal(unopened.error, partial);
  assert.deepEqual(
    closed,
    ["files", "repository"],
    "partial opens close every acquired lease before returning",
  );
  const combined = await settle({
    providersFactory: factory({
      closeFailures: { files: closeOne, repository: closeTwo },
    }),
    handler: () => {
      throw primary;
    },
  });
  assert.ok(combined.error instanceof AggregateError);
  assert.equal(combined.error.cause, primary);
  assert.deepEqual(combined.error.errors, [primary, closeOne, closeTwo]);
  assert.deepEqual(
    closed,
    ["files", "repository", "account"],
    "one close failure cannot skip another owned lease",
  );
  const partialCleanup = await settle({
    providersFactory: factory({
      openFailure: partial,
      closeFailures: { files: closeOne },
    }),
    handler: () => assert.fail("partial open cannot run the handler"),
  });
  assert.ok(partialCleanup.error instanceof AggregateError);
  assert.equal(partialCleanup.error.cause, partial);
  assert.deepEqual(partialCleanup.error.errors, [partial, closeOne]);
  assert.deepEqual(closed, ["files", "repository"]);
  console.log(
    "PASS invocation cleanup probe (success, refusal, partial open, aggregate causes)",
  );
}
async function conflict(config, override) {
  const before = snapshot();
  await assert.rejects(
    invoke(config, { enabled: true }),
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
  assertInvocationClosed();
  assert.deepEqual(
    snapshot(),
    before,
    "refusal must preserve common config, worktree config, metadata and scripts byte-for-byte",
  );
}
let fixtureFailure,
  fixtureFailed = false,
  removalFailure;
try {
  await cleanupProbe();
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
  const bindingOverlay = {
    kind: "binding",
    text: "# forge/github-accounts config binding begin v1\n# forge/github-accounts config binding end v1\n",
    separator: false,
    values: {},
  };
  writeFileSync(
    join(common, "config"),
    readFileSync(join(common, "config"), "utf8") + bindingOverlay.text,
  );
  mkdirSync(managed);
  writeFileSync(
    join(managed, "metadata.json"),
    JSON.stringify({
      version: 2,
      account: "fixture",
      name: "Fixture",
      email: "fixture@example.com",
      emails: ["fixture@example.com"],
      automatic: false,
      previous: {},
      installed: {},
      artifacts: {},
      overlays: [bindingOverlay],
      hooks: false,
    }),
  );
  mkdirSync(custom);
  writeFileSync(join(custom, "pre-push"), "#!/bin/sh\nexit 0\n");
  git(linked, "config", "--worktree", "core.hooksPath", custom);
  await conflict(config, custom);
  git(linked, "config", "--worktree", "core.hooksPath", "");
  await conflict(config, "");
  const unresolved = ".git/foreign-worktree-hooks";
  git(linked, "config", "--worktree", "core.hooksPath", unresolved);
  await conflict(config, unresolved);
  git(linked, "config", "--worktree", "--unset", "core.hooksPath");
  const beforeLateOverride = snapshot();
  let injected = false;
  const interleaved = (s) => ({
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
  });
  await assert.rejects(
    invoke(config, { enabled: true }, { transform: interleaved }),
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
  const beforeLateDeletion = snapshot();
  let deletedAfterPublication = false;
  const deleting = (s) => ({
    ...s,
    repository: {
      ...s.repository,
      run(program, args, options) {
        if (
          !deletedAfterPublication &&
          args[0] === "worktree" &&
          args[1] === "list" &&
          JSON.parse(readFileSync(join(managed, "metadata.json"), "utf8")).hooks
        ) {
          rmSync(join(managed, "hooks/pre-push"));
          deletedAfterPublication = true;
        }
        return s.repository.run(program, args, options);
      },
    },
  });
  await assert.rejects(
    invoke(config, { enabled: true }, { transform: deleting }),
    { code: "ACCOUNT_HOOK_ARTIFACT_INVALID" },
    "first activation must refuse a hook deleted after publication",
  );
  assert.equal(
    deletedAfterPublication,
    true,
    "the deletion must occur after hook publication",
  );
  assert.deepEqual(
    snapshot(),
    beforeLateDeletion,
    "late hook deletion must roll back common config, metadata and script bytes",
  );
  const enabled = await invoke(config, { enabled: true });
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
  const hookFile = join(owned, "pre-push");
  const hookText = readFileSync(hookFile, "utf8");
  const hookMode = statSync(hookFile).mode & 0o777;
  rmSync(hookFile);
  const missingState = snapshot();
  await assert.rejects(
    invoke(config, { enabled: true }),
    { code: "ACCOUNT_HOOK_ARTIFACT_INVALID" },
    "enabling an already enabled guard must refuse when its generated pre-push file is missing",
  );
  assert.deepEqual(
    snapshot(),
    missingState,
    "missing-hook refusal must leave configuration and metadata untouched",
  );
  writeFileSync(hookFile, hookText, { mode: hookMode });
  writeFileSync(hookFile, hookText + "# Independent hook edit\n");
  const modifiedState = snapshot();
  await assert.rejects(
    invoke(config, { enabled: true }),
    { code: "ACCOUNT_HOOK_ARTIFACT_INVALID" },
    "enabling an already enabled guard must refuse modified hook bytes",
  );
  assert.deepEqual(
    snapshot(),
    modifiedState,
    "modified-hook refusal must preserve foreign edits",
  );
  writeFileSync(hookFile, hookText);
  if (process.platform !== "win32") {
    chmodSync(hookFile, 0o600);
    const nonExecutableState = snapshot();
    await assert.rejects(
      invoke(config, { enabled: true }),
      { code: "ACCOUNT_HOOK_ARTIFACT_INVALID" },
      "enabling an already enabled guard must refuse a non-executable hook",
    );
    assert.deepEqual(snapshot(), nonExecutableState);
    assert.equal(
      statSync(hookFile).mode & 0o777,
      0o600,
      "refusal must preserve mode-only foreign edits",
    );
    chmodSync(hookFile, hookMode);
  }
  assert.equal((await invoke(config, { enabled: true })).enabled, true);
  git(linked, "config", "--worktree", "core.hooksPath", custom);
  await conflict(config, custom);
  git(linked, "config", "--worktree", "core.hooksPath", "");
  await conflict(config, "");
  git(linked, "config", "--worktree", "core.hooksPath", owned);
  assert.equal((await invoke(config, { enabled: false })).enabled, false);
  assert.equal(
    (await invoke(config, { enabled: true }, { cwd: linked })).enabled,
    true,
  );
  for (const cwd of [root, linked])
    assert.equal(
      resolve(
        git(cwd, "rev-parse", "--path-format=absolute", "--git-path", "hooks"),
      ),
      owned,
    );
} catch (error) {
  fixtureFailed = true;
  fixtureFailure = error;
} finally {
  try {
    rmSync(temporary, { recursive: true, force: true });
  } catch (error) {
    removalFailure = error;
  }
}
if (removalFailure !== undefined)
  throw new AggregateError(
    fixtureFailed ? [fixtureFailure, removalFailure] : [removalFailure],
    "Fixture directory cleanup failed",
    { cause: fixtureFailed ? fixtureFailure : removalFailure },
  );
if (fixtureFailed) throw fixtureFailure;
console.log("PASS worktree-hooks");
