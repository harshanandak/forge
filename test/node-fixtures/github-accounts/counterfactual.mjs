import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  command,
  credentialFor,
  git,
  good,
  identitySnapshot,
  ok,
  plantedEnvironment,
  reuseFixture,
} from "./harness.mjs";

const [mode, preparedPath] = process.argv.slice(2);
const prepared = JSON.parse(readFileSync(preparedPath, "utf8"));
const descriptor = ["auth-order", "route", "environment"].includes(mode)
  ? prepared.alpha
  : prepared.beta;
const configPath = join(descriptor.root, ".git/config");
const managed = join(descriptor.root, ".git/.forge-github-accounts");
const originalConfig = readFileSync(configPath);
const files = [];
function capture(directory, relative = "") {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) capture(path, name);
    else
      files.push({
        name,
        bytes: readFileSync(path),
        mode: statSync(path).mode & 0o777,
      });
  }
}
capture(managed);
const failures = [];
const started = performance.now();
let clone;
try {
  clone = await reuseFixture(
    descriptor,
    mode === "auth-order" ? "login-mismatch" : "ready",
  );
  console.log(
    `Accounts prepared ${mode}: ${Math.round(performance.now() - started)} ms`,
  );
  if (mode === "auth-order") {
    const result = await clone.call("bind", {
      login: clone.login,
      auto: true,
      repository: "fixture/project",
    });
    assert.equal(
      result.ok,
      false,
      "failed login-mismatch preflight must refuse account binding",
    );
  } else if (mode === "author" || mode === "committer") {
    const base = git(clone.root, clone.env, "rev-parse", "HEAD");
    const env = {
      ...clone.env,
      GIT_AUTHOR_NAME: clone.account.name,
      GIT_AUTHOR_EMAIL: clone.account.email,
      GIT_COMMITTER_NAME: clone.account.name,
      GIT_COMMITTER_EMAIL: clone.account.email,
      [mode === "author" ? "GIT_AUTHOR_EMAIL" : "GIT_COMMITTER_EMAIL"]:
        "wrong@example.invalid",
    };
    git(
      clone.root,
      env,
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      `wrong ${mode}`,
    );
    const tip = git(clone.root, clone.env, "rev-parse", "HEAD");
    for (const trigger of ["push", "merge"])
      assert.equal(
        (await clone.call("check", { base, tip, trigger })).error?.code,
        "ACCOUNT_IDENTITY_MISMATCH",
        `wrong ${mode} email must be refused before ${trigger}`,
      );
  } else if (mode === "trailers") {
    const result = await clone.call("message", {
      text: "Fixture\n\nCo-Authored-By: Codex <codex@openai.com>\n",
    });
    assert.equal(
      result.error?.code,
      "AI_COAUTHOR_REFUSED",
      "refuse policy must reject AI co-author trailers",
    );
  } else if (mode === "route" || mode === "environment") {
    const selected = ok(
      await clone.call("bind", {
        login: clone.login,
        auto: true,
        repository: "fixture/project",
      }),
      "bind prepared router clone",
    );
    const planted = plantedEnvironment(clone);
    const routed = command(
      clone.config.shellProgram,
      [join(selected.routerPath, "gh"), "pr", "create", "--title", "fixture"],
      clone.root,
      planted.env,
    );
    assert.equal(
      JSON.parse(good(routed, "marked clone router")).account,
      clone.login,
    );
    assert.equal(
      existsSync(planted.marker),
      false,
      "configured environment launcher must stay pinned when PATH changes",
    );
    const credentials = command(
      "git",
      ["-C", clone.root, "credential", "fill"],
      clone.root,
      planted.startupEnv,
      "protocol=https\nhost=github.com\n\n",
    );
    assert.equal(
      credentials.status,
      0,
      "clone-local Git credential lookup must succeed",
    );
    assert.equal(
      credentials.stdout.includes(`password=${credentialFor(clone.login)}`),
      true,
      "push credentials must match the clone-bound account",
    );
    assert.equal(
      existsSync(planted.marker),
      false,
      "credential helper must use the pinned environment launcher",
    );
    assert.equal(
      existsSync(planted.startupMarker),
      false,
      "credential helper must isolate shell startup carriers before the configured interpreter starts",
    );
  } else if (mode === "restore") {
    ok(await clone.call("unbind"), "unbind prepared account");
    assert.deepEqual(
      identitySnapshot(clone),
      descriptor.original,
      "unbind must restore every prior identity, helper and hook configuration value",
    );
  } else throw new Error("Unknown counterfactual mode");
} catch (error) {
  failures.push(error);
}
const primaryFailures = failures.length;
if (clone) {
  try {
    await clone.close();
  } catch (error) {
    failures.push(error);
  }
}
try {
  // Restore only this serial, fixture-owned clone. Admission is left intact so
  // every subsequent case must still capture and admit its own changed digest.
  writeFileSync(configPath, originalConfig);
  rmSync(managed, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
  for (const file of files) {
    const path = join(managed, file.name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, file.bytes, { mode: file.mode });
  }
} catch (error) {
  failures.push(error);
}
if (failures.length === primaryFailures)
  console.log(
    `Accounts restored ${mode}: ${Math.round(performance.now() - started)} ms`,
  );
if (failures.length === 1) throw failures[0];
if (failures.length > 1)
  throw new AggregateError(
    failures,
    "counterfactual and fixture restoration failed",
  );
console.log(`PASS github-accounts ${mode}`);
