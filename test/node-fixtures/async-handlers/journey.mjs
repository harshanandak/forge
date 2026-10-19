import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Runtime,
  Catalog,
  TrustStore,
  captureBlock,
  nodeFileCapture,
  nodeRunIsolation,
} from "forge-workflow/runtime";
const packageUrl = import.meta.resolve("forge-workflow/package.json");
const { createProcessPort } = await import(
  new URL("dist/src/adapters/process/index.js", packageUrl)
);
const bin = fileURLToPath(new URL("dist/bin/forge.js", packageUrl));
const mode = process.argv[2] ?? "all";
const root = mkdtempSync(join(process.cwd(), "async-"));
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    ["path", "pathext", "systemroot", "windir", "home", "tmp", "temp"].includes(
      key.toLowerCase(),
    ),
  ),
);
const device = join(root, "device");
function fixture(source, timeoutMs = 3000, effects = []) {
  const directory = join(root, `block-${Math.random().toString(36).slice(2)}`);
  mkdirSync(directory);
  const manifest = {
    schemaVersion: "forge.block/1",
    id: "example.org/sample",
    version: "1.0.0",
    authorAbi: "forge.author/v2",
    profile: "trusted-action/v2",
    entry: "index.cjs",
    docs: "docs.json",
    operations: {
      "sample.run": {
        input: "input.json",
        output: "output.json",
        context: "stateless",
        effects,
        idempotent: true,
        callers: ["human", "agent"],
        stability: "stable",
        timeoutMs,
      },
    },
  };
  for (const [file, content] of Object.entries({
    "forge.block.json": JSON.stringify(manifest),
    "index.cjs": `module.exports = { 'sample.run': ${source} };`,
    "docs.json": JSON.stringify({
      operations: {
        "sample.run": { title: "Run", summary: "Run async sample." },
      },
    }),
    "input.json": '{"type":"object"}',
    "output.json": '{"type":"string"}',
  }))
    writeFileSync(join(directory, file), content);
  writeFileSync(join(directory, "block.json"), JSON.stringify(manifest));
  const block = captureBlock(directory, nodeFileCapture);
  const catalog = new Catalog(
    {
      schemaVersion: "forge.config/1",
      blocks: { sample: { source: { path: "./sample" } } },
    },
    new Map([["sample", block]]),
  );
  const trust = new TrustStore();
  trust.admit("human", block.digest);
  const request = {
    schemaVersion: "forge.invocation/1",
    requestId: "packed-async",
    op: "sample.run",
    caller: "agent",
    context: {},
    input: {},
  };
  return {
    directory,
    block,
    catalog,
    trust,
    request,
    runtime: (services) =>
      new Runtime(catalog, trust, {
        isolation: nodeRunIsolation,
        limits: { timeoutMs: 5000 },
        services: async () => ({ ownership: "borrowed", value: services }),
      }),
  };
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  if (["all", "async"].includes(mode)) {
    const f = fixture(`async ({ input, services, signal, deadline }) => {
      if (!signal || typeof deadline !== 'number') throw Error('missing runtime scope');
      const result = await services.process.run(input.executable, input.args, input.options);
      if (result.exitCode !== 0) throw Error('child failed'); return result.stdout;
    }`);
    f.request.input = {
      executable: { kind: "resolved", path: process.execPath },
      args: [
        "-e",
        "setTimeout(() => process.stdout.write('child-complete'), 30)",
      ],
      options: { cwd: root, env, timeoutMs: 2000, maxOutputBytes: 1024 },
    };
    assert.deepEqual(
      await f.runtime({ process: createProcessPort() }).invoke(f.request),
      {
        ok: true,
        op: "sample.run",
        status: "OK",
        result: "child-complete",
        warnings: [],
      },
      "async child process must complete",
    );
  }
  for (const kind of ["timeout", "cancel"])
    if (["all", kind].includes(mode)) {
      const ready = join(root, `${kind}.ready`),
        late = join(root, `${kind}.late`);
      // The root remains alive while its grandchild owns a delayed write. A live descendant
      // would create the marker even if the runtime returned a timeout successfully.
      const childSource = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const c=spawn(process.execPath,['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(late)}, 'escaped'), 800); setInterval(() => {}, 1000);`)}], {stdio:'inherit'}); setInterval(()=>{},1000);`;
      const f = fixture(
        "async ({ input, services }) => { await services.process.run(input.executable, input.args, input.options); return 'unexpected'; }",
        kind === "timeout" ? 400 : 3000,
      );
      const port = createProcessPort();
      f.request.input = {
        executable: { kind: "resolved", path: process.execPath },
        args: ["-e", childSource],
        options: { cwd: root, env, timeoutMs: 2000, maxOutputBytes: 1024 },
      };
      const controller = new AbortController();
      const pending = f
        .runtime({ process: port })
        .invoke(f.request, { signal: controller.signal });
      if (kind === "cancel") {
        for (let i = 0; i < 100 && !existsSync(ready); i++) await pause(10);
        assert.ok(
          existsSync(ready),
          "grandchild must start before cancellation",
        );
        controller.abort();
      }
      const result = await pending;
      assert.equal(
        result.error?.code,
        kind === "timeout" ? "INVOCATION_TIMEOUT" : "INVOCATION_CANCELLED",
        "typed interruption",
      );
      assert.ok(existsSync(ready), "grandchild must have started");
      await pause(900);
      assert.equal(
        existsSync(late),
        false,
        "invocation must stop its entire process tree",
      );
      const pid = Number(readFileSync(ready, "utf8"));
      // A reaped process is observable on all supported hosts; Linux may briefly retain a zombie.
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {}
      if (alive && process.platform === "linux") {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        alive = !stat.includes(") Z ");
      }
      assert.equal(alive, false, "grandchild must be stopped");
    }
  if (["all", "scope"].includes(mode)) {
    const f = fixture(
      "({ services }) => { services.retain(services); return 'saved'; }",
    );
    let retained,
      cached,
      writes = 0;
    const value = {
      state: Object.freeze({
        put() {
          writes++;
        },
      }),
      process: {
        run() {
          writes++;
        },
      },
      network: {
        send() {
          writes++;
        },
      },
      retain(services) {
        retained = services;
        cached = services.state.put;
      },
    };
    assert.equal((await f.runtime(value).invoke(f.request)).ok, true);
    for (const call of [
      () => retained.state.put(),
      () => retained.process.run(),
      () => retained.network.send(),
      () => cached(),
    ])
      assert.throws(
        call,
        (error) => error.error?.code === "SERVICE_EXPIRED",
        "settled services must refuse writes",
      );
    assert.equal(writes, 0);
  }
  if (["all", "grants"].includes(mode)) {
    const f = fixture(
      "async ({ services }) => { await Promise.resolve(); return services.write(); }",
      3000,
      ["sample:write"],
    );
    let writes = 0;
    const runtime = f.runtime({
      write() {
        writes++;
        return "written";
      },
    });
    assert.equal(
      (await runtime.invoke(f.request)).error?.code,
      "GRANT_REQUIRED",
      "async effect needs human grant",
    );
    assert.equal(writes, 0);
    f.trust.grant("human", f.block.digest, ["sample:write"]);
    assert.equal((await runtime.invoke(f.request)).result, "written");
    assert.equal(writes, 1);
  }
  if (["all", "surfaces"].includes(mode)) {
    const f = fixture(
      "async ({ input }) => { await Promise.resolve(); return input.value; }",
    );
    function cli(args, expected = 0) {
      const child = spawnSync(process.execPath, [bin, ...args], {
        cwd: root,
        env: { ...env, FORGE_DEVICE_ROOT: device },
        encoding: "utf8",
        windowsHide: true,
        timeout: 10000,
      });
      assert.equal(
        child.status,
        expected,
        `${args}: ${child.stdout} ${child.stderr}`,
      );
      return JSON.parse(child.stdout);
    }
    cli(["block", "add", `./${basename(f.directory)}`], 2);
    cli(["block", "admit", f.block.digest]);
    assert.equal(
      cli(["sample", "run", "--input", '{"value":"cli-awaited"}']).result,
      "cli-awaited",
      "CLI must await async handler",
    );
    const child = spawn(process.execPath, [bin, "--mcp"], {
      cwd: root,
      env: { ...env, FORGE_DEVICE_ROOT: device },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
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
        const at = buffer.indexOf("\n");
        const message = JSON.parse(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      }
    });
    const rpc = (method, params) =>
      new Promise((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(
          () => reject(Error(`MCP timeout: ${errors}`)),
          5000,
        );
        pending.set(id, (value) => {
          clearTimeout(timer);
          resolve(value);
        });
        child.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
        );
      });
    try {
      await rpc("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "async", version: "1.0.0" },
      });
      child.stdin.write(
        '{"jsonrpc":"2.0","method":"notifications/initialized"}\n',
      );
      const response = await rpc("tools/call", {
        name: "sample_run",
        arguments: { value: "mcp-awaited" },
      });
      assert.equal(
        response.result.structuredContent.result,
        "mcp-awaited",
        "MCP must await async handler",
      );
    } finally {
      child.stdin.end();
      await new Promise((resolve) => child.once("exit", resolve));
    }
  }
  console.log(`PASS async-handlers ${mode}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
