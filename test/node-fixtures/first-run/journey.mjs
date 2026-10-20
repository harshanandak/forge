// A first run of the installed package under Node only: detect, check, read a PR, merge it.
// Usage: node journey.mjs <installed forge-workflow dir>
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const installed = process.argv[2];
assert.ok(installed, "usage: journey.mjs <installed package dir>");
const bin = join(installed, "dist/bin/forge.js");
const fakeGh = join(import.meta.dirname, "../pr-thin/gh.cjs");
const work = realpathSync(mkdtempSync(join(tmpdir(), "forge-first-run-")));
const repo = join(work, "repo");
const head = "a".repeat(40);
const pathKey =
  Object.keys(process.env).find((key) => key.toLowerCase() === "path") ??
  "PATH";
const baseEnv = { ...process.env, FORGE_DEVICE_ROOT: join(work, "device") };

// Async so independent PR scenarios can run side by side; each call is a fresh CLI process.
function cli(args, env = baseEnv) {
  const label = args.slice(0, 2).join(" ");
  return new Promise((resolve, reject) =>
    execFile(
      process.execPath,
      [bin, ...args],
      { cwd: repo, env, encoding: "utf8", windowsHide: true, timeout: 30000 },
      (error, stdout, stderr) => {
        if (error?.killed) return reject(new Error(`${label} timed out`));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error([label, error?.message, stdout, stderr].join("
")));
        }
      },
    ),
  );
}
const input = (op, value, env) =>
  cli([...op, "--input", JSON.stringify(value)], env);
async function ok(pending, label) {
  const envelope = await pending;
  assert.equal(envelope.ok, true, `${label}: ${JSON.stringify(envelope)}`);
  return envelope.result;
}
function git(...args) {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      ...args,
    ],
    { cwd: repo, encoding: "utf8", windowsHide: true, timeout: 10000 },
  );
  assert.equal(result.status, 0, result.stderr);
}
// A project whose test runner prints a Jest-style summary with the count in tests.txt.
function commitTests(count) {
  writeFileSync(join(repo, "tests.txt"), String(count));
  git("add", "-A");
  git("commit", "-qm", `${count} tests`);
}
// A `gh` on PATH that answers as GitHub would for one scenario of the shared fake.
function ghOnPath(scenario) {
  const dir = join(work, `gh-${scenario}`);
  mkdirSync(dir);
  // The shared fake also checks that gh sees only the environment it was given.
  const fixed = { PR_CASE: scenario };
  for (const name of "APPDATA XDG_CONFIG_HOME DBUS_SESSION_BUS_ADDRESS".split(" "))
    fixed[name] = `fixture-${name}`;
  for (const name of "HTTPS_PROXY HTTP_PROXY NO_PROXY".split(" "))
    fixed[name] = fixed[name.toLowerCase()] = "fixture-proxy";
  if (process.platform === "win32") {
    const sets = Object.entries(fixed).map(([k, v]) => `@set "${k}=${v}"`);
    writeFileSync(
      join(dir, "gh.cmd"),
      [...sets, `@"${process.execPath}" "${fakeGh}" %*`, ""].join("\r\n"),
    );
  } else {
    const sets = Object.entries(fixed).map(([k, v]) => `export ${k}='${v}'`);
    writeFileSync(
      join(dir, "gh"),
      [
        "#!/bin/sh",
        ...sets,
        `exec '${process.execPath}' '${fakeGh}' "$@"`,
        "",
      ].join("\n"),
    );
    chmodSync(join(dir, "gh"), 0o755);
  }
  return {
    ...baseEnv,
    [pathKey]: `${dir}${delimiter}${baseEnv[pathKey] ?? ""}`,
  };
}
// Admission is by digest of the block's bytes, read from a copy inside the project.
async function admit(name, effects) {
  const copy = join(repo, ".blocks", name);
  cpSync(join(installed, "dist/src/blocks", name), copy, { recursive: true });
  const { digest } = await ok(
    cli(["block", "check", `./.blocks/${name}`]),
    `check ${name}`,
  );
  await ok(cli(["block", "admit", digest]), `admit ${name}`);
  await ok(input(["config", "grant"], { digest, effects }), `grant ${name}`);
}

try {
  mkdirSync(repo);
  git("init", "-q");
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({
      name: "first-run-fixture",
      version: "1.0.0",
      private: true,
      scripts: { test: "node runner.mjs", lint: "node runner.mjs" },
    }),
  );
  writeFileSync(join(repo, "package-lock.json"), '{"lockfileVersion":3}');
  writeFileSync(
    join(repo, "runner.mjs"),
    `import { readFileSync } from "node:fs";
const n = Number(readFileSync("tests.txt", "utf8"));
console.log(n === 0 ? "No tests found" : \`Tests:       \${n} passed, \${n} total\`);
`,
  );
  commitTests(1);

  // 1. config show lists what the project already runs, and writes nothing.
  const shown = await ok(cli(["config", "show"]), "config show");
  const detected = shown.values
    .filter((entry) => entry.layer === "derived")
    .map((e) => `${e.pointer}: ${e.value} from ${e.origin.file}#${e.origin.pointer}`);
  assert.deepEqual(detected, [
    "/blocks/check/config/commands/lint: npm run lint from package.json#/scripts/lint",
    "/blocks/check/config/commands/test: npm test from package.json#/scripts/test",
  ]);
  assert.equal(
    existsSync(join(repo, ".forge")),
    false,
    "config show wrote nothing",
  );
  console.log(
    "PASS config show: detected npm test and npm run lint from package.json",
  );

  // Turn on check and pr; the detected commands fill check's command list.
  await ok(
    input(["config", "apply"], {
      expectRevision: shown.revision,
      patch: [
        {
          op: "set",
          path: "/blocks/check",
          value: {
            source: { builtin: "forge/check" },
            config: {
              timeoutMs: 20000,
              maxOutputBytes: 65536,
              report: "auto",
              stopOnFailure: true,
              inputs: [],
              maxInputBytes: 1048576,
              environment: "PATH PATHEXT SystemRoot TEMP TMP HOME USERPROFILE".split(" "),
              outputHeadBytes: 1024,
              outputTailBytes: 1024,
              maxMetadataBytes: 65536,
              maxReceiptBytes: 262144,
            },
          },
        },
        {
          op: "set",
          path: "/blocks/pr",
          value: { source: { builtin: "forge/pr" }, config: {} },
        },
      ],
    }),
    "config apply",
  );
  const io =
    "process:write external:process external:write files:read environment:read".split(
      " ",
    );
  await admit("check", ["check:write", ...io]);
  await admit("pr", io);

  // 2. check run: PASS with a recognised test, FAIL when the runner finds zero tests.
  const passed = await ok(
    input(["check", "run"], { checks: ["test"] }),
    "check run",
  );
  assert.equal(passed.status, "PASS", JSON.stringify(passed));
  assert.equal(passed.runs[0].testCount, 1);
  commitTests(0);
  const zero = (await input(["check", "run"], { checks: ["test"] })).result;
  assert.equal(
    zero?.status,
    "FAIL",
    `zero tests must FAIL: ${JSON.stringify(zero)}`,
  );
  console.log("PASS check run: PASS with 1 test, FAIL with 0 tests");

  // 3-4. pr status reads GitHub's verdict through gh; pr merge pins the head.
  // The scenarios are separate fake PRs, so the reads and the refusal run together.
  const pr = { repo: "owner/repo", number: 1 };
  const mergeEnv = ghOnPath("merge");
  const [ready, blocked, wrong] = await Promise.all([
    ok(input(["pr", "status"], pr, ghOnPath("ready")), "pr status ready"),
    ok(input(["pr", "status"], pr, ghOnPath("threads")), "pr status threads"),
    input(["pr", "merge"], { ...pr, expectHead: "c".repeat(40) }, mergeEnv),
  ]);
  assert.equal(ready.verdict, "READY", JSON.stringify(ready));
  assert.equal(ready.head, head);
  assert.equal(blocked.verdict, "BLOCKED", JSON.stringify(blocked));
  assert.equal(blocked.reasons[0].message, "1 unresolved review threads");
  console.log(
    "PASS pr status: READY when clean, BLOCKED with the unresolved-thread reason",
  );
  assert.equal(wrong.result?.merged, false, JSON.stringify(wrong));
  assert.deepEqual(wrong.result?.reasons, [
    { code: "HOST_BLOCKED", message: "Head does not match expectHead" },
  ]);
  const merged = await ok(
    input(["pr", "merge"], { ...pr, expectHead: head }, mergeEnv),
    "pr merge",
  );
  assert.equal(merged.merged, true, JSON.stringify(merged));
  assert.equal(merged.mergeCommit, "b".repeat(40));
  console.log("PASS pr merge: wrong head refused, exact head merged");
} finally {
  rmSync(work, { recursive: true, force: true });
}
