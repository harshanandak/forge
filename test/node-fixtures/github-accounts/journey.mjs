import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  accounts,
  bin,
  cloneFixture,
  command,
  credentialFor,
  fixture,
  git,
  good,
  hashTree,
  identitySnapshot,
  localState,
  localValues,
  mcp,
  ok,
  parallelCommand,
  plantedEnvironment,
} from "./harness.mjs";

const mode = process.argv[2] ?? "all";
const root = mkdtempSync(join(process.cwd(), "ga-"));
const opened = [];
const failures = [];
let preparedState;
let checkpointAt = performance.now();
function checkpoint(label) {
  const now = performance.now();
  console.log(`Accounts ${label}: ${Math.round(now - checkpointAt)} ms`);
  checkpointAt = now;
}
const make = async (...args) => {
  const clone = await cloneFixture(root, ...args);
  opened.push(clone);
  return clone;
};
async function settled(tasks) {
  const results = await Promise.allSettled(tasks);
  const errors = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length)
    throw new AggregateError(errors, "parallel account sessions failed");
  return results.map((result) => result.value);
}
function assertNoStoredCredentials(clone) {
  const data = [readFileSync(join(clone.root, ".git/config"), "utf8")];
  const metadata = join(
    clone.root,
    ".git/.forge-github-accounts/metadata.json",
  );
  if (existsSync(metadata)) {
    const text = readFileSync(metadata, "utf8");
    data.push(text);
    const saved = JSON.parse(text);
    data.push(...Object.values(saved.artifacts));
  }
  for (const login of Object.keys(accounts))
    assert.equal(
      data.some((text) => text.includes(credentialFor(login))),
      false,
      "stored account artifacts must never contain credentials",
    );
}
async function changePolicy(clone, policy) {
  const shown = ok(await clone.call("config.show"), "read policy revision");
  ok(
    await clone.call("config.apply", {
      expectRevision: shown.revision,
      patch: [
        {
          op: "set",
          path: "/blocks/github-accounts/config/coauthorPolicy",
          value: policy,
        },
      ],
    }),
    "select trailer policy",
  );
}
function commit(clone, message, overrides = {}) {
  git(
    clone.root,
    { ...clone.env, ...overrides },
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    message,
  );
  return git(clone.root, clone.env, "rev-parse", "HEAD");
}
try {
  const alpha = await make("a", "alpha-user");
  const original = identitySnapshot(alpha);
  let beta;
  let betaOriginal;
  if (["all", "auth-order"].includes(mode)) {
    for (const scenario of ["auth-failure", "login-mismatch", "repo-denied"]) {
      const failed = alpha;
      await failed.reopen(scenario);
      const before = localState(failed);
      const global = hashTree(join(root, "home"));
      const result = await failed.call("bind", {
        login: "alpha-user",
        auto: true,
        repository: "fixture/project",
      });
      assert.equal(
        result.ok,
        false,
        `failed ${scenario} preflight must refuse account binding`,
      );
      assert.deepEqual(
        localState(failed),
        before,
        "failed authentication, account verification or repository access must preserve config and artifacts",
      );
      assert.deepEqual(
        hashTree(join(root, "home")),
        global,
        "failed binding must not change global configuration",
      );
    }
  }
  await alpha.reopen("ready");
  checkpoint("failure preflights");
  const outsideBefore = hashTree(alpha.root, new Set([".git"]));
  const globalBefore = hashTree(join(root, "home"));
  const selected = await alpha.bind();
  assert.equal(selected.account, "alpha-user");
  assert.deepEqual(
    selected.identity,
    { name: alpha.account.name, email: alpha.account.email },
    "binding must select clone-local commit identity",
  );
  assert.deepEqual(
    hashTree(alpha.root, new Set([".git"])),
    outsideBefore,
    "binding must write only in clone Git metadata",
  );
  assert.deepEqual(
    hashTree(join(root, "home")),
    globalBefore,
    "binding must not switch global accounts or identity",
  );
  assertNoStoredCredentials(alpha);
  checkpoint("clone binding");

  if (["all", "route"].includes(mode)) {
    beta = await make("b", "beta-user");
    betaOriginal = identitySnapshot(beta);
    const betaSelected = await beta.bind();
    const planted = [alpha, beta].map(plantedEnvironment);
    const routed = await settled(
      [alpha, beta].map(async (clone) => {
        const child = await parallelCommand(
          process.execPath,
          [
            bin,
            "github-account",
            "run",
            "--input",
            JSON.stringify({ args: ["pr", "create", "--title", "fixture"] }),
          ],
          clone.root,
          clone.env,
        );
        const result = ok(
          JSON.parse(good(child, "parallel generated account command")),
          "routed account command",
        );
        return JSON.parse(result.stdout).account;
      }),
    );
    assert.deepEqual(
      routed,
      ["alpha-user", "beta-user"],
      "parallel clones must route provider commands to their own bound account",
    );
    const routedScripts = await settled(
      [alpha, beta].map(async (clone, index) => {
        const status = [selected, betaSelected][index];
        const path = join(status.routerPath, "gh");
        assert.ok(
          readFileSync(path, "utf8").includes("forge/github-accounts"),
          "managed router must carry its ownership marker",
        );
        const result = await parallelCommand(
          clone.config.shellProgram,
          [path, "pr", "create", "--title", "fixture"],
          clone.root,
          planted[index].env,
        );
        if (result.status !== 0) {
          const log = readFileSync(
            join(clone.root, ".git/fake-gh.jsonl"),
            "utf8",
          );
          result.stderr += `\nSafe provider stages: ${log}`;
        }
        const output = JSON.parse(good(result, "marked clone router"));
        assert.equal(
          existsSync(planted[index].marker),
          false,
          "configured environment launcher must stay pinned when PATH changes",
        );
        return output.account;
      }),
    );
    assert.deepEqual(
      routedScripts,
      ["alpha-user", "beta-user"],
      "marked routers must preserve account selection across parallel sessions",
    );
    for (const [index, clone] of [alpha, beta].entries()) {
      const credentials = command(
        "git",
        ["-C", clone.root, "credential", "fill"],
        clone.root,
        planted[index].startupEnv,
        "protocol=https\nhost=github.com\n\n",
      );
      assert.equal(
        credentials.status,
        0,
        "clone-local Git credential lookup must succeed",
      );
      const fields = Object.fromEntries(
        credentials.stdout
          .trim()
          .split(/\r?\n/)
          .map((line) => {
            const at = line.indexOf("=");
            return [line.slice(0, at), line.slice(at + 1)];
          }),
      );
      assert.equal(
        fields.username === clone.login &&
          fields.password === credentialFor(clone.login),
        true,
        "push credentials must match the clone-bound account",
      );
      assert.equal(
        existsSync(planted[index].marker),
        false,
        "credential helper must use the pinned environment launcher",
      );
      assert.equal(
        existsSync(planted[index].startupMarker),
        false,
        "credential helper must isolate shell startup carriers before the configured interpreter starts",
      );
      assertNoStoredCredentials(clone);
      const log = readFileSync(join(clone.root, ".git/fake-gh.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(
        log.some((entry) => entry.command === "forbidden-switch"),
        false,
        "account routing must never call gh auth switch",
      );
    }
    const beforeStatus = localState(alpha);
    const cli = ok(alpha.cli("status"), "generated CLI account status");
    const wire = ok(await mcp(alpha, "status"), "generated MCP account status");
    assert.deepEqual(
      wire,
      cli,
      "generated CLI and MCP account status must agree",
    );
    assert.deepEqual(
      localState(alpha),
      beforeStatus,
      "status must remain read only",
    );
  }
  checkpoint("parallel routing and surfaces");
  if (["all", "author", "committer"].includes(mode)) {
    const checks = mode === "all" ? ["author", "committer"] : [mode];
    let base = alpha.baseline;
    for (const field of checks) {
      const wrong = {
        GIT_AUTHOR_NAME: alpha.account.name,
        GIT_AUTHOR_EMAIL: alpha.account.email,
        GIT_COMMITTER_NAME: alpha.account.name,
        GIT_COMMITTER_EMAIL: alpha.account.email,
      };
      wrong[field === "author" ? "GIT_AUTHOR_EMAIL" : "GIT_COMMITTER_EMAIL"] =
        "wrong@example.invalid";
      const tip = commit(alpha, `wrong ${field}`, wrong);
      for (const trigger of ["push", "merge"]) {
        const result = await alpha.call("check", { base, tip, trigger });
        assert.equal(
          result.error?.code,
          "ACCOUNT_IDENTITY_MISMATCH",
          `wrong ${field} email must be refused before ${trigger}`,
        );
      }
      base = tip;
    }
    if (mode === "all") {
      const wire = await mcp(alpha, "check", {
        base: alpha.baseline,
        tip: "HEAD",
        trigger: "merge",
      });
      assert.equal(
        wire.error?.code,
        "ACCOUNT_IDENTITY_MISMATCH",
        "generated MCP guard must refuse wrong identity",
      );
    }
  }
  checkpoint("commit guards");
  if (["all", "trailers"].includes(mode)) {
    const text =
      "Fixture message\n\nCo-Authored-By: Codex <codex@openai.com>\nCo-Authored-By: Human <human@example.invalid>\n";
    const refused = await alpha.call("message", { text });
    assert.equal(
      refused.error?.code,
      "AI_COAUTHOR_REFUSED",
      "refuse policy must reject AI co-author trailers",
    );
    await changePolicy(alpha, "allow");
    assert.deepEqual(
      ok(await alpha.call("message", { text }), "allow policy"),
      { text, changed: false },
    );
    await changePolicy(alpha, "strip");
    const stripped = ok(await alpha.call("message", { text }), "strip policy");
    assert.equal(
      stripped.changed,
      true,
      "strip policy must remove selected AI co-author trailers",
    );
    assert.equal(stripped.text.includes("codex@openai.com"), false);
    assert.equal(
      stripped.text.includes("human@example.invalid"),
      true,
      "strip policy must retain human co-authors",
    );
  }
  checkpoint("trailer policy");
  if (mode === "all") {
    const conflictBefore = localState(alpha);
    assert.equal(
      (await alpha.call("hook", { enabled: true })).error?.code,
      "INPUT_CONFLICT",
      "guard installation must preserve existing hook configuration",
    );
    assert.deepEqual(localState(alpha), conflictBefore);
    const linked = join(root, "w");
    git(
      alpha.root,
      alpha.env,
      "worktree",
      "add",
      "--quiet",
      "--detach",
      linked,
      "HEAD",
    );
    git(alpha.root, alpha.env, "config", "extensions.worktreeConfig", "true");
    git(
      linked,
      alpha.env,
      "config",
      "--worktree",
      "user.email",
      "worktree-wrong@example.invalid",
    );
    const diagnosed = ok(await alpha.call("doctor"), "worktree doctor");
    const row = diagnosed.worktrees.find((worktree) =>
      worktree.path.replace(/\\/g, "/").endsWith("/w"),
    );
    assert.equal(row?.email, "worktree-wrong@example.invalid");
    assert.equal(
      row?.matches,
      false,
      "doctor must report linked-worktree identity mismatch",
    );
    assert.ok(
      diagnosed.mismatches.some((value) => value.startsWith("worktree:")),
    );
    git(linked, alpha.env, "config", "--worktree", "--unset-all", "user.email");
    git(alpha.root, alpha.env, "worktree", "remove", linked);
  }
  checkpoint("worktree diagnosis");
  if (["all", "hook"].includes(mode)) {
    const guarded = await make("guard", "alpha-user", "refuse", "ready", false);
    const validShell = guarded.config.shellProgram;
    await guarded.configure({
      shellProgram: join(guarded.root, "missing-shell"),
    });
    const missingShellBefore = localState(guarded);
    assert.equal(
      (
        await guarded.call("bind", {
          login: guarded.login,
          auto: true,
          repository: "fixture/project",
        })
      ).error?.code,
      "ACCOUNT_SHELL_UNAVAILABLE",
      "automatic binding must refuse a missing configured shell before writing",
    );
    assert.deepEqual(localState(guarded), missingShellBefore);
    const manual = await guarded.bind({ auto: false });
    assert.equal(
      manual.automatic,
      false,
      "explicit binding without automatic routing must not require a shell",
    );
    const beforeMissingHook = localState(guarded);
    assert.equal(
      (await guarded.call("hook", { enabled: true })).error?.code,
      "ACCOUNT_SHELL_UNAVAILABLE",
      "guard installation must refuse a missing configured shell before writing",
    );
    assert.deepEqual(localState(guarded), beforeMissingHook);
    await guarded.configure({ shellProgram: validShell });
    const nativeHook = join(guarded.root, ".git/hooks/pre-push");
    writeFileSync(nativeHook, "#!/bin/sh\nexit 0\n");
    chmodSync(nativeHook, 0o755);
    const nativeBefore = localState(guarded);
    assert.equal(
      (await guarded.call("hook", { enabled: true })).error?.code,
      "INPUT_CONFLICT",
      "guard installation must preserve a native Git hook",
    );
    assert.deepEqual(localState(guarded), nativeBefore);
    assert.equal(readFileSync(nativeHook, "utf8"), "#!/bin/sh\nexit 0\n");
    rmSync(nativeHook);
    const hookWorktree = join(root, "guard-linked");
    git(
      guarded.root,
      guarded.env,
      "worktree",
      "add",
      "--quiet",
      "--detach",
      hookWorktree,
      "HEAD",
    );
    git(
      guarded.root,
      guarded.env,
      "config",
      "extensions.worktreeConfig",
      "true",
    );
    const override = ".git/foreign-worktree-hooks";
    git(
      hookWorktree,
      guarded.env,
      "config",
      "--worktree",
      "core.hooksPath",
      override,
    );
    const worktreeConfig = git(
      hookWorktree,
      guarded.env,
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "config.worktree",
    );
    const overrideBytes = readFileSync(worktreeConfig);
    const beforeWorktreeConflict = localState(guarded);
    const conflicted = await guarded.call("hook", { enabled: true });
    assert.equal(conflicted.error?.code, "ACCOUNT_HOOKS_CONFLICT");
    assert.ok(conflicted.error.message.includes("guard-linked"));
    assert.ok(conflicted.error.message.includes(JSON.stringify(override)));
    assert.deepEqual(
      readFileSync(worktreeConfig),
      overrideBytes,
      "guard activation must preserve conflicting worktree configuration",
    );
    assert.deepEqual(
      localState(guarded),
      beforeWorktreeConflict,
      "worktree hook conflicts must refuse before clone-local writes",
    );
    git(guarded.root, guarded.env, "worktree", "remove", hookWorktree);
    ok(
      await guarded.call("hook", { enabled: true }),
      "install opt-in pre-push guard",
    );
    const remote = join(root, "sink.git");
    mkdirSync(remote);
    git(remote, guarded.env, "init", "--bare", "--quiet");
    git(guarded.root, guarded.env, "remote", "add", "sink", remote);
    git(
      guarded.root,
      guarded.env,
      "push",
      "--quiet",
      "sink",
      "HEAD:refs/heads/allowed",
    );
    const bad = commit(guarded, "wrong author for push", {
      GIT_AUTHOR_EMAIL: "wrong@example.invalid",
    });
    const pushed = command(
      "git",
      [
        "-C",
        guarded.root,
        "push",
        "--quiet",
        "sink",
        "HEAD:refs/heads/allowed",
      ],
      guarded.root,
      guarded.env,
    );
    assert.equal(
      pushed.error,
      undefined,
      "native push must complete; a child timeout is not an identity refusal",
    );
    assert.notEqual(
      pushed.status,
      null,
      "native push must return an exit code",
    );
    assert.match(
      pushed.stderr,
      /ACCOUNT_IDENTITY_MISMATCH/,
      "native push must report the bound-account identity refusal",
    );
    assert.notEqual(
      pushed.status,
      0,
      "installed pre-push hook must refuse an actual Git push with wrong commit email",
    );
    assert.notEqual(
      git(remote, guarded.env, "rev-parse", "refs/heads/allowed"),
      bad,
      "refused commit must not reach the remote",
    );
    ok(await guarded.call("unbind"), "unbind guarded clone");
    assert.deepEqual(
      localValues(guarded, "core.hooksPath"),
      [],
      "unbinding must restore native hook resolution",
    );
    git(
      guarded.root,
      guarded.env,
      "push",
      "--quiet",
      "sink",
      "HEAD:refs/heads/allowed",
    );
    assert.equal(
      git(remote, guarded.env, "rev-parse", "refs/heads/allowed"),
      bad,
      "unbound clone must regain native push behavior",
    );
  }
  checkpoint("actual Git hook");
  if (["all", "restore"].includes(mode)) {
    ok(await alpha.call("unbind"), "unbind account");
    assert.deepEqual(
      identitySnapshot(alpha),
      original,
      "unbind must restore every prior identity, helper and hook configuration value",
    );
    const native = command(
      process.execPath,
      [join(fixture, "fake-gh.mjs"), "pr", "create"],
      alpha.root,
      { ...alpha.env, GH_TOKEN: "" },
    );
    assert.equal(
      native.status,
      0,
      "native provider remains available after unbinding",
    );
    assert.equal(JSON.parse(native.stdout).account, "native");
    assert.equal(
      existsSync(join(alpha.root, ".git/.forge-github-accounts/metadata.json")),
      false,
    );
    assert.equal(
      existsSync(join(alpha.root, ".git/.forge-github-accounts/bin/gh")),
      false,
    );
    assertNoStoredCredentials(alpha);
  }
  checkpoint("native restoration");
  if (mode === "all")
    preparedState = {
      alpha: {
        root: alpha.root,
        login: alpha.login,
        baseline: alpha.baseline,
        original,
      },
      beta: {
        root: beta.root,
        login: beta.login,
        baseline: beta.baseline,
        original: betaOriginal,
      },
    };
  console.log(`PASS github-accounts ${mode}`);
} catch (error) {
  failures.push(error);
}
const closed = await Promise.allSettled(opened.map((clone) => clone.close()));
for (const result of closed)
  if (result.status === "rejected") failures.push(result.reason);
try {
  if (
    process.env.FORGE_ACCOUNTS_PREPARED &&
    preparedState &&
    failures.length === 0
  )
    writeFileSync(
      process.env.FORGE_ACCOUNTS_PREPARED,
      JSON.stringify(preparedState),
    );
  else
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
} catch (error) {
  failures.push(error);
}
if (failures.length === 1) throw failures[0];
if (failures.length > 1)
  throw new AggregateError(failures, "accounts fixture and cleanup failed");
