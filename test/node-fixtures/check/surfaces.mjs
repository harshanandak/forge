import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const installed = process.argv[2];
const mcpOnly = process.argv[3] === "mcp";
const bindingsOnly = process.argv[3] === "bindings";
const reviewOnly = process.argv[3] === "review";
const root = realpathSync(mkdtempSync(join(tmpdir(), "check-surfaces-")));
const bin = join(installed, "dist/bin/forge.js");
const env = {
  ...process.env,
  FORGE_DEVICE_ROOT: join(root, "device"),
  CHECK_PARENT_ONLY: "excluded",
};
const envNames = Object.keys(env).filter((name) =>
  /^(?:path|pathext|systemroot|windir|temp|tmp|home)$/i.test(name),
);
function cli(args, expected = 0, input, label = "") {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
    input,
  });
  assert.equal(
    result.status,
    expected,
    `${label} ${args.slice(0, 2).join(" ")}: ${result.error?.code ?? result.signal ?? "exit"} ${result.stdout} ${result.stderr}`,
  );
  return JSON.parse(result.stdout);
}
function git(args) {
  const result = spawnSync("git", args, {
    cwd: root,
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
const config = {
  commands: { test: { argv: [process.execPath, "command.mjs", "unknown"] } },
  timeoutMs: 5000,
  maxOutputBytes: 8192,
  outputHeadBytes: 1024,
  outputTailBytes: 1024,
  maxMetadataBytes: 32768,
  maxReceiptBytes: 262144,
  report: "auto",
  stopOnFailure: true,
  inputs: ["input.txt", "command.mjs"],
  maxInputBytes: 1048576,
  environment: envNames,
};
const effects = [
  "check:write",
  "process:write",
  "external:process",
  "external:write",
  "files:read",
  "environment:read",
];
let revision;
function configure(changes) {
  const applied = cli(
    ["--hook", "config.apply"],
    0,
    JSON.stringify({
      expectRevision: revision,
      patch: Object.entries(changes).map(([key, value]) => ({
        op: "set",
        path: `/blocks/check/config/${key}`,
        value,
      })),
    }),
  );
  revision = applied.result.revision;
}
function maximumReceipt(receipt) {
  assert.equal(
    receipt.runs.length,
    2,
    "two maximum-output commands return a receipt",
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify(receipt)) <= config.maxReceiptBytes,
  );
  const expected =
    "sha256:" +
    createHash("sha256")
      .update("H" + "x".repeat(262142) + "T")
      .digest("hex");
  for (const run of receipt.runs)
    for (const stream of [run.stdoutEvidence, run.stderrEvidence]) {
      assert.equal(stream.totalBytes, 262144, "full streaming length");
      assert.equal(
        stream.digest,
        expected,
        "full streaming digest includes discarded middle",
      );
      assert.equal(stream.complete, true);
    }
}
function bindings() {
  configure({
    commands: Object.fromEntries(
      Array.from({ length: 128 }, (_, index) => [
        "check" + index,
        { argv: ["unavailable-declaration", "x".repeat(4200)] },
      ]),
    ),
    outputHeadBytes: 1,
    outputTailBytes: 1,
    maxMetadataBytes: 850000,
    maxReceiptBytes: 1048576,
    stopOnFailure: false,
  });
  const receipt = cli(["check", "run"]).result;
  assert.equal(
    receipt.runs.length,
    128,
    "large declaration binding returns a receipt",
  );
  assert.equal(receipt.status, "INCOMPLETE");
  assert.match(receipt.inputsDigest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(cli(["check", "show", receipt.id]).result, receipt);
}
async function mcp(expectedStatus = "PASS", expectedCommands = ["test"]) {
  const child = spawn(process.execPath, [bin, "--mcp"], {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "",
    errors = "",
    seq = 0;
  const pending = new Map();
  child.stderr.on("data", (data) => (errors += data));
  child.stdout.on("data", (data) => {
    buffer += data;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error(`MCP timeout: ${errors}`));
      }, 10000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  try {
    await rpc("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "check-packed", version: "1" },
    });
    child.stdin.write(
      '{"jsonrpc":"2.0","method":"notifications/initialized"}\n',
    );
    const listed = await rpc("tools/list", {});
    for (const name of ["check_run", "check_list", "check_show"])
      assert.ok(
        listed.result.tools.some((tool) => tool.name === name),
        `generated MCP exposes ${name}`,
      );
    const commands = await rpc("tools/call", {
      name: "check_list",
      arguments: {},
    });
    assert.deepEqual(
      commands.result.structuredContent.result.commands,
      expectedCommands,
    );
    const run = await rpc("tools/call", { name: "check_run", arguments: {} });
    assert.equal(
      run.result?.structuredContent?.result?.status,
      expectedStatus,
      `MCP awaits the declared command: ${JSON.stringify(run.error ?? run.result?.structuredContent?.error ?? null)}`,
    );
    const receipt = run.result.structuredContent.result;
    const read = await rpc("tools/call", {
      name: "check_show",
      arguments: { id: receipt.id },
    });
    assert.deepEqual(
      read.result.structuredContent.result,
      receipt,
      "MCP receipt readback matches",
    );
    return receipt;
  } finally {
    child.stdin.end();
    let timer;
    try {
      await Promise.race([
        exited,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            child.kill();
            reject(Error("MCP did not shut down"));
          }, 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
async function review() {
  configure({
    ...config,
    maxOutputBytes: 1,
    outputHeadBytes: 1,
    outputTailBytes: 0,
  });
  const first = cli(["check", "run"]).result;
  assert.equal(
    first.runs.length,
    1,
    "one-byte command budget returns a receipt",
  );
  assert.equal(
    first.runs[0].stdoutEvidence.head,
    "cA==",
    "command retention stays at one byte",
  );
  const second = cli(["check", "run"]).result;
  assert.equal(
    first.inputsDigest,
    second.inputsDigest,
    "repeated CLI input binding is stable",
  );
  const wire = await mcp("INCOMPLETE");
  assert.equal(
    first.inputsDigest,
    wire.inputsDigest,
    "CLI and MCP input binding is stable",
  );
  for (const command of ["tool && other", 'tool "unterminated']) {
    configure({ commands: { test: command } });
    assert.equal(
      cli(
        ["check", "run"],
        6,
        undefined,
        "invalid command string has a typed error",
      ).error.code,
      "INPUT_INVALID",
      "invalid command string has a typed error",
    );
  }
  console.log(
    "PASS packed final review: one-byte command cap, stable CLI/MCP bindings, typed parser errors",
  );
}
try {
  git(["init", "-q"]);
  writeFileSync(join(root, "input.txt"), "exact input\n");
  writeFileSync(
    join(root, "command.mjs"),
    `const mode=process.argv[2];if(mode==="maximum"){const text="H"+"x".repeat(262142)+"T";process.stdout.write(text);process.stderr.write(text);}else if(mode==="zero")console.log("Tests: 0 total");else if(mode==="malformed")console.log('{"numTotalTests":');else if(mode==="environment"){if(process.env.CHECK_PARENT_ONLY)process.exitCode=9;else console.log("isolated");}else console.log("project command");`,
  );
  git(["add", "input.txt", "command.mjs"]);
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture",
  ]);
  const initial = cli(["config", "show"]);
  const applied = cli([
    "config",
    "apply",
    "--input",
    JSON.stringify({
      expectRevision: initial.result.revision,
      patch: [
        { op: "set", path: "/mcp", value: { expose: ["check"] } },
        {
          op: "set",
          path: "/blocks/check",
          value: { source: { builtin: "forge/check" }, config },
        },
      ],
    }),
  ]);
  revision = applied.result.revision;
  assert.equal(
    cli(["check", "run"], 2).error.code,
    "ADMISSION_REQUIRED",
    "generated CLI enforces admission",
  );
  cpSync(join(installed, "dist/src/blocks/check"), join(root, "check-bytes"), {
    recursive: true,
  });
  const checked = cli(["block", "check", "./check-bytes"]);
  const digest = checked.result.digest;
  cli(["block", "admit", digest]);
  cli(["config", "grant", "--input", JSON.stringify({ digest, effects })]);
  if (reviewOnly) {
    await review();
  } else if (mcpOnly) {
    await mcp();
    console.log(
      "PASS packed generated MCP: list, awaited run, receipt readback",
    );
  } else if (bindingsOnly) {
    bindings();
    console.log("PASS packed large declaration input binding");
  } else {
    assert.deepEqual(cli(["check", "list"]).result.commands, ["test"]);
    const first = cli(["check", "run"]).result;
    assert.equal(first.status, "PASS", "installed CLI awaits command");
    assert.equal(
      first.runs[0].testCount,
      null,
      "CLI unknown count stays unknown",
    );
    assert.deepEqual(
      cli(["check", "show", first.id]).result,
      first,
      "CLI readback matches receipt",
    );
    for (const [mode, status] of [
      ["zero", "FAIL"],
      ["malformed", "INCOMPLETE"],
      ["environment", "PASS"],
    ]) {
      configure({
        commands: { test: { argv: [process.execPath, "command.mjs", mode] } },
      });
      assert.equal(
        cli(["check", "run"]).result.status,
        status,
        `CLI ${mode} outcome`,
      );
    }
    configure({ commands: {} });
    assert.equal(
      cli(["check", "run"]).result.status,
      "NOT_EXECUTED",
      "CLI nothing declared",
    );
    configure({ commands: config.commands });
    writeFileSync(join(root, "input.txt"), "changed bytes\n");
    const changed = cli(["check", "run"]).result;
    assert.notEqual(
      first.inputsDigest,
      changed.inputsDigest,
      "dirty file bytes bind CLI receipts",
    );
    const wire = await mcp();
    assert.equal(wire.status, changed.status, "CLI and MCP outcomes agree");
    configure({
      commands: {
        first: { argv: [process.execPath, "command.mjs", "maximum"] },
        second: { argv: [process.execPath, "command.mjs", "maximum"] },
      },
      maxOutputBytes: 262144,
      stopOnFailure: false,
    });
    maximumReceipt(cli(["check", "run"]).result);
    maximumReceipt(await mcp("INCOMPLETE", ["first", "second"]));
    bindings();
    await review();
    console.log(
      "PASS packed generated CLI/MCP: admission, list, outcomes, env, input binding, receipt readback",
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
