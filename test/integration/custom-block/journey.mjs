import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

assert.equal(process.versions.bun, undefined);
const consumer = process.argv[2];
const installed = join(consumer, "node_modules/forge-workflow");
const root = join(process.cwd(), "project");
mkdirSync(root);
const npmRoot = process.env.FORGE_AUTHOR_NPM_ROOT ?? dirname(process.execPath);
const npx = [
  join(npmRoot, "node_modules/npm/bin/npx-cli.js"),
  join(npmRoot, "../lib/node_modules/npm/bin/npx-cli.js"),
].find(existsSync);
assert.ok(npx, "npx shipped with Node is required");
const env = { ...process.env, FORGE_DEVICE_ROOT: join(root, ".device") };
function run(executable, args, expected = 0) {
  const result = spawnSync(executable, args, {
    cwd: root,
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(
    result.status,
    expected,
    `${args.join(" ")}\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout;
}
run("git", ["init", "-q"]);
writeFileSync(
  join(root, "package.json"),
  '{"name":"author-demo","private":true}',
);
if (process.env.FORGE_AUTHOR_TARBALL) {
  run(process.execPath, [
    join(dirname(npx), "npm-cli.js"),
    "install",
    process.env.FORGE_AUTHOR_TARBALL,
    "--no-audit",
    "--no-fund",
    "--prefer-offline",
  ]);
} else {
  // The pack smoke owns one npm install; each journey mutates only its private copy.
  cpSync(join(consumer, "node_modules"), join(root, "node_modules"), {
    recursive: true,
  });
}
cpSync(join(installed, "examples/hello-block"), join(root, "hello-block"), {
  recursive: true,
});
const guide = readFileSync(join(installed, "docs/writing-a-block.md"), "utf8");
const commands = guide
  .match(/```sh\n([\s\S]*?)```/)[1]
  .trim()
  .split("\n");
assert.equal(commands.length, 4);
let digest;
for (const command of commands) {
  assert.ok(command.startsWith("npx forge "));
  const args = command
    .replace("<digest>", digest ?? "")
    .split(" ")
    .slice(1);
  const adding = args[2] === "add";
  const envelope = JSON.parse(
    run(process.execPath, [npx, ...args], adding ? 2 : 0),
  );
  assert.equal(envelope.ok, !adding);
  if (args[2] === "check") {
    assert.equal(envelope.result.admitted, false);
    digest = envelope.result.digest;
  } else if (args[2] === "add") {
    assert.equal(envelope.status, "INCOMPLETE");
    assert.equal(envelope.error.code, "ADMISSION_REQUIRED");
    assert.equal(envelope.error.repair, `forge block admit ${digest}`);
  } else if (args[2] === "admit") {
    assert.equal(envelope.result.admitted, true);
  } else {
    assert.deepEqual(envelope.result, { message: "Hello, World!" });
  }
}
const manifestPath = join(root, "hello-block/forge.block.json");
const original = readFileSync(manifestPath, "utf8");
for (const [label, mutate, sentences] of [
  [
    "missing field",
    (m) => {
      delete m.entry;
    },
    ["entry is required"],
  ],
  [
    "misspelled key",
    (m) => {
      m.entyr = m.entry;
      delete m.entry;
    },
    ["entry is required", 'Unknown field "entyr"; did you mean "entry"?'],
  ],
  [
    "wrong type",
    (m) => {
      m.operations["hello.say"].timeoutMs = "1000";
    },
    ['operations.hello.say.timeoutMs must be integer; received "1000"'],
  ],
]) {
  const manifest = JSON.parse(original);
  mutate(manifest);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  for (const verb of ["check", "add"]) {
    const envelope = JSON.parse(
      run(process.execPath, [npx, "forge", "block", verb, "./hello-block"], 6),
    );
    assert.equal(envelope.error.code, "INPUT_INVALID");
    const message = envelope.error.message;
    assert.ok(message.includes(manifestPath.replaceAll("\\", "/")));
    assert.deepEqual(message.split("\n").slice(1), sentences);
    console.log(`${label} (${verb}): ${message}`);
  }
}
writeFileSync(manifestPath, original);
console.log(
  "CUSTOM_BLOCK_JOURNEY_PASS: check → add → admit → hello say; three mistakes exit 6",
);
