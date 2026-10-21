import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { StateOwner } from "forge-workflow/state";
import { sqliteStore } from "forge-workflow/adapters/sqlite";

const consumer = process.cwd();
const mode = process.argv[2] ?? "all";
const bin = fileURLToPath(
  new URL(
    "dist/bin/forge.js",
    import.meta.resolve("forge-workflow/package.json"),
  ),
);
const root = mkdtempSync(join(consumer, "project-"));
const deviceRoot = join(root, "device");
const env = { ...process.env, FORGE_DEVICE_ROOT: deviceRoot };
assert.equal(process.versions.bun, undefined);
const bun = spawnSync("bun", ["--version"], { env, windowsHide: true });
assert.ok(bun.error, "Bun must not resolve on PATH");
function cli(args, expected = 0) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true,
  });
  assert.equal(
    result.status,
    expected,
    `${args.join(" ")}: ${result.stderr}\n${result.stdout}`,
  );
  return JSON.parse(result.stdout);
}
function mcp() {
  const child = spawn(process.execPath, [bin, "--mcp"], {
    cwd: root,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let next = 0,
    buffer = "",
    errors = "";
  const pending = new Map();
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.id !== undefined) {
        const request = pending.get(message.id);
        pending.delete(message.id);
        request?.resolve(message);
      }
    }
  });
  child.once("exit", (code) => {
    for (const request of pending.values())
      request.reject(new Error(`MCP exited ${code}: ${errors}`));
  });
  const rpc = async (method, params) => {
    const id = ++next;
    const response = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
    );
    const message = await response;
    assert.equal(message.error, undefined, JSON.stringify(message));
    return message.result;
  };
  return {
    async initialize() {
      await rpc("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "integration", version: "1.0.0" },
      });
      child.stdin.write(
        '{"jsonrpc":"2.0","method":"notifications/initialized"}\n',
      );
    },
    rpc,
    async call(name, args) {
      const result = await rpc("tools/call", { name, arguments: args });
      const text = JSON.parse(result.content[0].text);
      assert.deepEqual(text, result.structuredContent);
      return text;
    },
    async close() {
      if (child.exitCode !== null) return;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 3000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
function makeBlock() {
  const block = join(root, "semver");
  mkdirSync(block);
  const operation = (input, output, context, effects, args) => ({
    input,
    output,
    context,
    timeoutMs: 15000,
    effects,
    args,
    idempotent: effects.length === 0,
    callers: ["agent", "human"],
    stability: "stable",
  });
  writeFileSync(
    join(block, "forge.block.json"),
    JSON.stringify({
      schemaVersion: "forge.block/1",
      id: "io.github.alice/semver",
      version: "0.1.0",
      authorAbi: "forge.author/v1",
      profile: "trusted-action-sync/v1",
      entry: "index.cjs",
      docs: "docs.json",
      requires: [{ slot: "state", interface: "forge.state@1" }],
      operations: {
        "semver.bump": operation(
          "bump.input.json",
          "bump.output.json",
          "stateless",
          [],
          ["current", "part"],
        ),
        "semver.mark": operation(
          "mark.input.json",
          "mark.output.json",
          "project",
          ["semver:write"],
          ["version", "expectRevision"],
        ),
      },
    }),
  );
  const schema = (properties, required = Object.keys(properties)) => ({
    type: "object",
    properties,
    required,
    additionalProperties: false,
  });
  for (const [name, value] of Object.entries({
    "bump.input": schema({
      current: { type: "string", pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+$" },
      part: { enum: ["major", "minor", "patch"] },
    }),
    "bump.output": schema({ next: { type: "string" } }),
    "mark.input": schema({
      version: { type: "string" },
      expectRevision: { type: "integer", minimum: 0 },
    }),
    "mark.output": schema({
      writeDurationMs: { type: "integer", minimum: 0 },
      version: { type: "string" },
      revision: { type: "integer", minimum: 1 },
    }),
    docs: {
      operations: {
        "semver.bump": { title: "Bump", summary: "Bump a semantic version." },
        "semver.mark": {
          title: "Mark",
          summary: "Record a version at the expected revision.",
        },
      },
    },
  }))
    writeFileSync(join(block, `${name}.json`), JSON.stringify(value));
  writeFileSync(
    join(block, "index.cjs"),
    `module.exports = {
    "semver.bump": ({input}) => { const [a,b,c] = input.current.split('.').map(Number); return {next: input.part === 'major' ? (a+1)+'.0.0' : input.part === 'minor' ? a+'.'+(b+1)+'.0' : a+'.'+b+'.'+(c+1)}; },
    "semver.mark": ({input,services}) => { const started = Date.now(); const record = services.state.put('released', {version: input.version}, {expectRevision: input.expectRevision}); return {version: input.version, revision: record.revision, writeDurationMs: Date.now() - started}; }
  };`,
  );
}
async function race() {
  const writers = [0, 1].map(() => {
    const child = spawn(
      process.execPath,
      [join(consumer, "writer.mjs"), root, deviceRoot],
      {
        cwd: root,
        env,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        windowsHide: true,
      },
    );
    let resolveReady, resolveResult, rejectReady, rejectResult;
    const ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const result = new Promise((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    let errors = "";
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    child.on("message", (message) => {
      if (message.ready) resolveReady(message.revision);
      if (message.result) resolveResult(message.result);
    });
    child.on("exit", (code) => {
      if (code !== 0) {
        const error = new Error(`writer ${code}: ${errors}`);
        rejectReady(error);
        rejectResult(error);
      }
    });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    return { child, ready, result, exited };
  });
  try {
    const revisions = await Promise.all(writers.map((writer) => writer.ready));
    assert.deepEqual(
      revisions,
      [1, 1],
      "both writers must read the same revision before either can write",
    );
    // Both observed revision 1 above. Commit the first writer before releasing
    // the second, so a faulty re-read cannot accidentally reuse revision 1.
    writers[0].child.send("go");
    const first = await writers[0].result;
    writers[1].child.send("go");
    const results = [first, await writers[1].result];
    await Promise.all(writers.map((writer) => writer.exited));
    assert.equal(
      results.filter((result) => result.ok).length,
      1,
      "one writer wins",
    );
    assert.equal(
      results.filter((result) => result.error?.code === "REVISION_CONFLICT")
        .length,
      1,
      "one writer receives REVISION_CONFLICT",
    );
  } finally {
    for (const writer of writers)
      if (writer.child.exitCode === null) writer.child.kill();
    await Promise.all(writers.map((writer) => writer.exited));
  }
}
let server;
const deadline = setTimeout(() => {
  console.error("journey deadline exceeded");
  process.exit(1);
}, 30000);
try {
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "npm-vitest-fixture",
      version: "1.0.0",
      scripts: { test: "vitest run" },
      devDependencies: { vitest: "^2.1.0" },
    }),
  );
  writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3}');
  const before = readFileSync(join(root, "package.json"));
  const show = cli(["config", "show"]);
  const test = show.result.values.find(
    (entry) => entry.pointer === "/blocks/check/config/commands/test",
  );
  assert.equal(test?.value, "npm test", "derived npm command");
  assert.equal(test.layer, "derived");
  assert.equal(test.origin.file, "package.json");
  assert.equal(test.origin.pointer, "/scripts/test");
  assert.equal(show.result.configured, false);
  assert.deepEqual(show.result.instances, []);
  assert.equal(
    existsSync(join(root, ".forge")),
    false,
    "detection must not create state/config",
  );
  assert.equal(
    existsSync(deviceRoot),
    false,
    "detection must not create device state",
  );
  assert.deepEqual(readFileSync(join(root, "package.json")), before);
  if (mode === "detection") {
    console.log("PASS detection");
  } else {
    makeBlock();
    const added = cli(["block", "add", "./semver"]);
    assert.equal(added.ok, true);
    assert.equal(added.result.admitted, false);
    const digest = added.result.digest;
    assert.equal(added.result.next, `npx forge block admit ${digest}`);
    assert.equal(
      cli(["config", "show"]).result.instances[0].name,
      "semver",
      "add persists through config",
    );
    server = mcp();
    await server.initialize();
    const unadmitted = await server.call("semver_bump", {
      current: "1.4.2",
      part: "minor",
    });
    assert.equal(
      unadmitted.error?.code,
      "ADMISSION_REQUIRED",
      "unadmitted agent call",
    );
    const tools = await server.rpc("tools/list", {});
    assert.ok(
      !tools.tools.some((tool) =>
        ["block_admit", "config_grant", "semver_bump"].includes(tool.name),
      ),
    );
    if (mode === "admission") console.log("PASS admission");
    else {
      assert.equal(cli(["block", "admit", digest]).result.admitted, true);
      const cliBump = cli(["semver", "bump", "1.4.2", "minor"]);
      const mcpBump = await server.call("semver_bump", {
        current: "1.4.2",
        part: "minor",
      });
      assert.deepEqual(cliBump.result, { next: "1.5.0" });
      assert.deepEqual(mcpBump.result, cliBump.result);
      assert.deepEqual(
        (await server.call("semver_bump", { current: "1.4.2", part: "minor" }))
          .result,
        cliBump.result,
        "same MCP session sees human admission",
      );
      const denied = await server.call("semver_mark", {
        version: "1.5.0",
        expectRevision: 0,
      });
      assert.equal(
        denied.error?.code,
        "GRANT_REQUIRED",
        "admission does not grant effects",
      );
      await server.close();
      server = undefined;
      cli([
        "config",
        "grant",
        "--input",
        JSON.stringify({ digest, effects: ["semver:write"] }),
      ]);
      server = mcp();
      await server.initialize();
      const markStarted = performance.now();
      const marked = await server.call("semver_mark", {
        version: "1.5.0",
        expectRevision: 0,
      });

      const { writeDurationMs, ...markedValue } = marked.result ?? {};
      assert.deepEqual(
        markedValue,
        { version: "1.5.0", revision: 1 },
        JSON.stringify(marked),
      );
      assert.ok(
        Number.isInteger(writeDurationMs) && writeDurationMs >= 0,
        "durable write timing must be measured",
      );
      console.log(
        `DEADLINE_MEASUREMENT platform=${process.platform} operation=semver.mark durationMs=${writeDurationMs} roundTripMs=${Math.ceil(performance.now() - markStarted)} declaredMs=15000 scope=durable-state-put`,
      );
      if (mode === "race") await race();
      else {
        const stale = cli(["semver", "mark", "1.6.0", "0"], 4);
        assert.equal(stale.error.code, "REVISION_CONFLICT");
        assert.equal(stale.error.currentRevision, 1);
        await race();
      }
      const opened = await sqliteStore.open({
        path: join(root, ".forge/state.sqlite"),
        readOnly: true,
      });
      assert.ok(opened.ok);
      try {
        const owner = new StateOwner(opened.handle.value, {
          now: () => Date.now(),
        });
        assert.equal(
          owner.get("io.github.alice/semver", "released").revision,
          2,
        );
        assert.equal(
          owner.events("io.github.alice/semver", "released").length,
          2,
          "loser writes no record or event",
        );
      } finally {
        await opened.handle.close();
      }
      if (mode === "all") {
        const current = cli(["config", "show"]);
        cli([
          "config",
          "set",
          "--input",
          JSON.stringify({
            path: "semver.label",
            value: "keep",
            expectRevision: current.result.revision,
          }),
        ]);
        assert.equal(cli(["block", "add", "./semver"]).result.admitted, true);
        assert.equal(
          cli(["config", "show"]).result.effective.blocks.semver.config.label,
          "keep",
          "re-add preserves the user's settings",
        );
      }
      console.log(
        `PASS ${mode}: detection, admission, CLI/MCP parity, grant, revisions and two-writer barrier`,
      );
    }
  }
} finally {
  clearTimeout(deadline);
  await server?.close();
  rmSync(root, { recursive: true, force: true });
}
