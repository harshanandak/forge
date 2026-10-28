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
const { pathToFileURL } = await import("node:url");
const { createAssembly, localContext } = await import(
  pathToFileURL(join(installed, "dist/src/assembly/index.js")).href
);
assert.equal(process.versions.bun, undefined);

function hookPath(command) {
  assert.ok(command.startsWith("node "));
  const quoted = command.slice(5);
  if (quoted.startsWith('"')) {
    assert.match(quoted, /^"[^"]+"$/);
    return quoted.slice(1, -1);
  }
  const path = quoted.slice(1, -1).replaceAll("'\\''", "'");
  assert.equal(quoted, `'${path.replaceAll("'", "'\\''")}'`);
  return path;
}

async function project(files) {
  const root = realpathSync(mkdtempSync(join(process.cwd(), "delivery-")));
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(root, name), text);
  const env = { ...process.env, FORGE_DEVICE_ROOT: join(root, "device") };
  for (const name of Object.keys(env))
    if (
      [
        "CLAUDECODE",
        "CODEX_THREAD_ID",
        "T3CODE_CLI_PATH",
        "T3CODE_THREAD_ID",
      ].includes(name.toUpperCase())
    )
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
    [{ CLAUDECODE: "1", CODEX_THREAD_ID: "test" }, "codex"],
    [{ CLAUDECODE: "1", T3CODE_CLI_PATH: "fixture" }, "t3"],
    [{ CODEX_THREAD_ID: "test", T3CODE_CLI_PATH: "fixture" }, "t3"],
    [{ CLAUDECODE: "1", T3CODE_THREAD_ID: "fixture" }, "t3"],
    [{ CODEX_THREAD_ID: "test", T3CODE_THREAD_ID: "fixture" }, "t3"],
    [
      { CLAUDECODE: "1", CODEX_THREAD_ID: "test", T3CODE_CLI_PATH: "fixture" },
      "t3",
    ],
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
  const assembly = await createAssembly({
    root,
    deviceRoot: env.FORGE_DEVICE_ROOT,
  });
  try {
    for (const [op, input] of [
      ["block.admit", { digest }],
      [
        "config.grant",
        {
          digest,
          effects: [
            "check:write",
            "process:write",
            "external:process",
            "external:write",
            "files:read",
            "environment:read",
          ],
        },
      ],
    ]) {
      const result = await assembly.catalog.invoke({
        schemaVersion: "forge.invocation/1",
        requestId: `owner-${op}`,
        op,
        input,
        caller: "human",
        context: localContext(assembly, { kind: "human", id: "fixture-owner" }),
      });
      assert.equal(result.ok, true, JSON.stringify(result));
    }
  } finally {
    await assembly.close();
  }
  // No environment config: check's default finds the project's own npm on PATH.
  return { root, cli };
}

// An npm project: check runs the project's own test script, never a Bun command.
const npm = await project({
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
for (const name of [
  "forge-build",
  "forge-review",
  "forge-land",
  "forge-loop",
  "forge-intake",
  "forge-cut",
])
  assert.ok(
    synced.written.includes(`.agents/skills/${name}/SKILL.md`),
    `skills sync renders ${name} from the installed package`,
  );
const review = ".agents/skills/forge-review/";
for (const file of ["list-threads.mjs", "reply-and-resolve.mjs"]) {
  assert.ok(
    synced.written.includes(review + file),
    `skills sync copies ${file} from the installed package`,
  );
  assert.equal(
    readFileSync(join(npm.root, review, file), "utf8"),
    readFileSync(
      join(installed, "templates/delivery/skills/forge-review", file),
      "utf8",
    ),
  );
}
assert.match(
  readFileSync(join(npm.root, review, "SKILL.md"), "utf8"),
  /forge companions: list-threads.mjs, reply-and-resolve.mjs/,
);
assert.match(
  readFileSync(join(npm.root, ".agents/skills/forge-cut/SKILL.md"), "utf8"),
  /Aim at 400 changed lines/,
);
assert.deepEqual(npm.cli(["check", "list"]).result.commands, ["test"]);
const receipt = npm.cli(["check", "run"]).result;
assert.equal(receipt.status, "PASS", JSON.stringify(receipt));
for (const [detect, kind] of [
  [{}, "gh-checks"],
  [{ CLAUDECODE: "1" }, "monitor"],
  [{ CODEX_THREAD_ID: "test" }, "gh-checks"],
]) {
  const wait = npm.cli(["agent", "wait", "7"], 0, detect).result;
  assert.equal(wait.kind, kind);
  if (kind === "monitor") {
    assert.equal(wait.steps.length, 1);
    assert.match(wait.steps[0], /^Start Monitor with /);
    const monitor = JSON.parse(
      wait.steps[0].slice("Start Monitor with ".length),
    );
    assert.equal(monitor.timeout_ms, 1_800_000);
    assert.equal(monitor.description, "PR #7: checks, threads, conflicts");
    assert.match(monitor.command, /forge pr state/);
  } else {
    assert.deepEqual(wait.steps, [
      "gh pr checks 7 --watch --fail-fast --interval 60",
    ]);
  }
  assert.deepEqual(
    npm.cli(["agent", "wait", "7", "--done"], 0, detect).result.steps,
    [],
  );
}
for (const [provider, file] of [
  [{ CLAUDECODE: "1" }, "~/.claude/settings.json"],
  [{ CODEX_THREAD_ID: "test" }, "~/.codex/hooks.json"],
  [{ CLAUDECODE: "1", CODEX_THREAD_ID: "test" }, "~/.codex/hooks.json"],
]) {
  for (const signal of ["T3CODE_CLI_PATH", "T3CODE_THREAD_ID"]) {
    const detect = { ...provider, [signal]: "fixture" };
    assert.equal(
      npm.cli(["agent", "wait", "7"], 0, detect).result.kind,
      "t3-tool",
    );
    assert.equal(npm.cli(["agent", "guard"], 0, detect).result.file, file);
    assert.equal(
      npm.cli(["agent", "wait", "7", "--fallback"], 0, detect).result.kind,
      "gh-checks",
    );
  }
}
const guard = npm.cli(["agent", "guard", "codex"]).result;
const hook = hookPath(guard.config.hooks.Stop[0].hooks[0].command);
assert.equal(
  realpathSync(hook),
  realpathSync(
    join(installed, "templates/delivery/skills/forge-build/done-claim.mjs"),
  ),
);
const hookEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) =>
    /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE)$/i.test(name),
  ),
);
hookEnv.FORGE_DEVICE_ROOT = join(npm.root, "device");
for (const [message, blocked] of [
  ["Done", true],
  [`Verified ${receipt.id}\nNot covered: live hooks`, false],
]) {
  const result = spawnSync(process.execPath, [hook], {
    cwd: process.cwd(),
    env: hookEnv,
    input: JSON.stringify({
      cwd: npm.root,
      last_assistant_message: message,
      stop_hook_active: false,
    }),
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  if (blocked) assert.equal(JSON.parse(result.stdout).decision, "block");
  else assert.equal(result.stdout, "");
}
assert.equal(
  readFileSync(join(npm.root, "ran.txt"), "utf8"),
  "npm test",
  "the project's own test command ran",
);
assert.doesNotMatch(JSON.stringify(receipt), /\bbun\b/);

// Nothing detected: the import refuses, naming check's missing commands, and writes nothing.
const empty = await project({});
assert.equal(empty.refused.error.code, "INPUT_INVALID");
assert.equal(
  empty.refused.error.message,
  "blocks.check needs commands, and nothing sets it: .forge/config.yaml has no value and nothing was detected in this project",
);
assert.equal(existsSync(join(empty.root, ".forge/config.yaml")), false);
console.log(
  "PASS delivery: imported by name from the package, npm test ran, nothing detected is refused plainly",
);
