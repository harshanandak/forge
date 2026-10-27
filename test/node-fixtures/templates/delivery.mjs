// A user's journey with the shipped delivery template, against the npm-installed package only:
// import it by name, render its skills, and run the project's own (npm) test command through check.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const installed = process.argv[2];
const bin = join(installed, "dist/bin/forge.js");
assert.equal(process.versions.bun, undefined);

function project(files) {
  const root = realpathSync(mkdtempSync(join(process.cwd(), "delivery-")));
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(root, name), text);
  const env = { ...process.env, FORGE_DEVICE_ROOT: join(root, "device") };
  for (const name of Object.keys(env))
    if (["CLAUDECODE", "CODEX_THREAD_ID"].includes(name.toUpperCase()))
      delete env[name];
  // check runs against a clean clone of the committed tree
  for (const args of [
    ["init", "-q"],
    ["add", "--all"],
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
      "--allow-empty",
    ],
  ]) {
    const git = spawnSync("git", args, {
      cwd: root,
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
    });
    assert.equal(git.status, 0, git.stderr);
  }
  const cli = (args, expected = 0, detect = {}) => {
    const result = spawnSync(process.execPath, [bin, ...args], {
      cwd: root,
      env: { ...env, ...detect },
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
    });
    assert.equal(
      result.status,
      expected,
      `${args.slice(0, 2).join(" ")}: ${result.error?.code ?? result.signal ?? "exit"} ${result.stdout} ${result.stderr}`,
    );
    return JSON.parse(result.stdout);
  };
  // A first import needs no prior config show: the project has no config file yet.
  const importDelivery = (expected = 0) =>
    cli(["template", "import", "delivery"], expected);
  if (Object.keys(files).length === 0)
    return { root, cli, refused: importDelivery(6) };
  assert.equal(importDelivery().result.template, "harsha/delivery@0.1.2");
  for (const [detect, harness] of [
    [{ CLAUDECODE: "1" }, "claude"],
    [{ CODEX_THREAD_ID: "test" }, "codex"],
    [{}, "current"],
  ])
    assert.equal(
      cli(["route", "get", "build"], 0, detect).result.line,
      `current high standard ${harness} single-family`,
    );
  assert.equal(cli(["route", "get", "deploy"], 6).error.code, "INPUT_INVALID");
  assert.match(
    cli(["route", "get", "build", "--max"], 6).error.message,
    /~\/.forge\/routing.yaml/,
  );
  // Built-in blocks run only once admitted by digest and granted their effects.
  cpSync(join(installed, "dist/src/blocks/check"), join(root, "check-bytes"), {
    recursive: true,
  });
  const digest = cli(["block", "check", "./check-bytes"]).result.digest;
  cli(["block", "admit", digest]);
  cli([
    "config",
    "grant",
    "--input",
    JSON.stringify({
      digest,
      effects: [
        "check:write",
        "process:write",
        "external:process",
        "external:write",
        "files:read",
        "environment:read",
      ],
    }),
  ]);
  // No environment config: check's default finds the project's own npm on PATH.
  return { root, cli };
}

// An npm project: check runs the project's own test script, never a Bun command.
const npm = project({
  "package.json": JSON.stringify({
    name: "npm-project",
    version: "1.0.0",
    private: true,
    scripts: {
      test: "node -e \"require('fs').writeFileSync('ran.txt','npm test')\"",
    },
  }),
  "package-lock.json": '{"lockfileVersion":3}',
});
const synced = npm.cli(["skills", "sync"]).result;
for (const name of ["build", "forge-loop", "forge-intake", "forge-cut"])
  assert.ok(
    synced.written.includes(`.agents/skills/${name}/SKILL.md`),
    `skills sync renders ${name} from the installed package`,
  );
assert.match(
  readFileSync(join(npm.root, ".agents/skills/forge-cut/SKILL.md"), "utf8"),
  /Aim at 400 changed lines/,
);
assert.deepEqual(npm.cli(["check", "list"]).result.commands, ["test"]);
const receipt = npm.cli(["check", "run"]).result;
assert.equal(receipt.status, "PASS", JSON.stringify(receipt));
assert.equal(
  readFileSync(join(npm.root, "ran.txt"), "utf8"),
  "npm test",
  "the project's own test command ran",
);
assert.doesNotMatch(JSON.stringify(receipt), /\bbun\b/);

// Nothing detected: the import refuses, naming check's missing commands, and writes nothing.
const empty = project({});
assert.equal(empty.refused.error.code, "INPUT_INVALID");
assert.equal(
  empty.refused.error.message,
  "blocks.check needs commands, and nothing sets it: .forge/config.yaml has no value and nothing was detected in this project",
);
assert.equal(existsSync(join(empty.root, ".forge/config.yaml")), false);
console.log(
  "PASS delivery: imported by name from the package, npm test ran, nothing detected is refused plainly",
);
