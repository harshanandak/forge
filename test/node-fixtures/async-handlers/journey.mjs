import assert from "node:assert/strict";
import { closeChild } from "./deadline.mjs";
import { isRunning as alive } from "./liveness.mjs";
import { spawn, spawnSync } from "node:child_process";
import {
  readdirSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join, basename, win32 } from "node:path";
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
if (process.platform === "win32") {
  const { windowsPrivateFiles } = await import(
    new URL("dist/src/adapters/process/windows-acl.js", packageUrl)
  );
  const native = windowsPrivateFiles();
  native.protect(root, `D:P(A;OICI;FA;;;${native.sid})`);
}
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    ["path", "pathext", "systemroot", "windir", "home", "tmp", "temp"].includes(
      key.toLowerCase(),
    ),
  ),
);
const device = join(root, "device");
const supervision = {
  cleanupTimeoutMs: 5000,
  pollIntervalMs: 25,
  drainTimeoutMs: 250,
  maxConcurrent: 1,
};
const processPort = (options = {}) =>
  createProcessPort({ supervision, ...options });
function fixture(source, timeoutMs = 3000, effects = [], processContainment) {
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
        ...(processContainment === undefined ? {} : { processContainment }),
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
    runtime: (services, isolation = nodeRunIsolation) =>
      new Runtime(catalog, trust, {
        isolation,
        limits: { timeoutMs: 10000 },
        services: async () => ({ ownership: "borrowed", value: services }),
      }),
  };
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function report(result, containment, descendantPid) {
  const warnings = result.warnings.filter(
    (warning) => warning.code === "PROCESS_SUPERVISION",
  );
  assert.equal(warnings.length, 1, "process outcome must report supervision");
  const value = JSON.parse(warnings[0].message);
  assert.equal(value.mode, containment);
  assert.equal(value.confirmed, true, "supervised cleanup must be confirmed");
  assert.ok(value.stoppedCount > 0, "supervision must report what stopped");
  assert.ok(value.stoppedCount >= value.stoppedPids.length);
  assert.equal(alive(value.supervisorPid), false, "supervisor must be stopped");
  if (process.platform === "win32")
    assert.equal(value.backend, "windows-job", "Windows keeps Job Objects");
  else if (containment === "supervised")
    assert.equal(value.backend, "process-group", "the OS owns the tree");
  if (descendantPid !== undefined) {
    assert.equal(alive(descendantPid), false, "grandchild must be stopped");
    if (value.backend !== "process-group")
      assert.ok(
        value.stoppedPids.includes(descendantPid),
        "containment report must include the stopped grandchild",
      );
  }
  console.log(
    `SUPERVISION ${containment} ${value.backend}: stopped=${value.stoppedCount}, confirmed=${value.confirmed}`,
  );
}
async function refusal(port, label) {
  let activations = 0,
    spawns = 0,
    opens = 0;
  const f = fixture(
    "({ services }) => { services.activate(); return 'unexpected'; }",
    5000,
    [],
    "strict",
  );
  const tracked = {
    capability: port.capability,
    resolve: port.resolve,
    ...(port.containment ? { containment: () => port.containment() } : {}),
    run(...args) {
      spawns++;
      return port.run(...args);
    },
  };
  const result = await f
    .runtime(
      {
        process: tracked,
        activate() {
          activations++;
        },
      },
      {
        open() {
          opens++;
          return nodeRunIsolation.open();
        },
      },
    )
    .invoke(f.request);
  assert.equal(
    result.error?.code,
    "CONTAINMENT_UNAVAILABLE",
    "strict containment must refuse before activation",
  );
  assert.equal(result.status, "INCOMPLETE", label);
  assert.equal(opens, 0, "unavailable containment must not open isolation");
  assert.equal(
    activations,
    0,
    "unavailable containment must not activate handler",
  );
  assert.equal(spawns, 0, "unavailable containment must not spawn a command");
}
async function tree(kind, containment = "supervised") {
  const strict = containment === "strict";
  const ready = join(root, `${containment}-${kind}.ready`);
  // On Windows libuv already ends a non-detached grandchild with its parent; detaching it leaves
  // only the Job Object to stop it, including after its root has exited.
  const late = join(root, `${containment}-${kind}.late`);
  const grandchild = `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(ready)},String(process.pid)); setTimeout(()=>fs.writeFileSync(${JSON.stringify(late)},'escaped'),6000); setInterval(()=>{},1000);`;
  const childSource = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const c=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{detached:${strict || process.platform === "win32"},stdio:${JSON.stringify(strict ? "ignore" : "inherit")},env:${JSON.stringify(env)}}); c.unref(); ${kind === "rootexit" ? `const check=setInterval(()=>{if(fs.existsSync(${JSON.stringify(ready)})){clearInterval(check);process.exit(0);}},5);` : "setInterval(()=>{},1000);"}`;
  const f = fixture(
    "async ({ input, services }) => { const result = await services.process.run(input.executable, input.args, input.options); if (result.exitCode !== 0) throw Error('child failed'); return 'root-exited'; }",
    kind === "timeout" ? 2000 : 6000,
    [],
    strict ? "strict" : undefined,
  );
  f.request.input = {
    executable: { kind: "resolved", path: process.execPath },
    args: ["-e", childSource],
    options: { cwd: root, env, timeoutMs: 8000, maxOutputBytes: 1024 },
  };
  const controller = new AbortController();
  const pending = f
    .runtime({ process: processPort() })
    .invoke(f.request, { signal: controller.signal });
  if (kind === "cancel") {
    const deadline = Date.now() + 4000;
    while (!existsSync(ready) && Date.now() < deadline) await pause(10);
    assert.ok(existsSync(ready), "grandchild must start before cancellation");
    controller.abort();
  }
  const result = await pending;
  if (kind === "rootexit") {
    assert.equal(result.ok, true, "root exit must complete after tree cleanup");
    assert.equal(result.result, "root-exited");
  } else {
    assert.equal(
      result.error?.code,
      kind === "timeout" ? "INVOCATION_TIMEOUT" : "INVOCATION_CANCELLED",
      "typed interruption",
    );
  }
  assert.ok(existsSync(ready), "grandchild must have started");
  const pid = Number(readFileSync(ready, "utf8"));
  const survived = alive(pid);
  // A counterfactual leaves a real orphan; stop it so it cannot outlive the journey.
  if (survived)
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  assert.equal(
    survived,
    false,
    `invocation must stop its entire process tree (pid=${pid})`,
  );
  assert.equal(
    existsSync(late),
    false,
    "invocation must stop its entire process tree",
  );
  report(result, containment, pid);
}
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
    const result = await f
      .runtime({ process: processPort() })
      .invoke(f.request);
    assert.equal(result.ok, true, "async child process must complete");
    assert.equal(
      result.result,
      "child-complete",
      "async child process must complete",
    );
    report(result, "supervised");
  }
  if (["all", "cpu"].includes(mode)) {
    const f = fixture(
      "async ({services}) => { await services.delay(); while(true) {} }",
      50,
    );
    const result = await f
      .runtime({ delay: () => pause(10) })
      .invoke(f.request);
    assert.equal(
      result.error?.code,
      "INVOCATION_TIMEOUT",
      "CPU after a native Promise must remain under deadline",
    );
  }
  for (const kind of ["timeout", "cancel", "rootexit"])
    if (
      ["all", kind, kind === "rootexit" ? "default-cleanup" : ""].includes(mode)
    )
      await tree(kind);
  if (mode === "job-termination") await tree("cancel", "strict");
  if (["all", "strict-refusal"].includes(mode)) {
    await refusal(processPort({ strictContainment: false }), "host disabled");
    const actual = processPort();
    await refusal(
      { resolve: actual.resolve, run: actual.run },
      "legacy provider",
    );
    if (process.platform === "darwin")
      await refusal(actual, "macOS capability");
  }
  if (["all", "strict"].includes(mode)) {
    const actual = processPort();
    const capability = await actual.containment();
    if (process.platform === "win32")
      assert.equal(
        capability.available,
        true,
        "Windows Job Object capability must be available",
      );
    if (capability.available) {
      for (const kind of ["rootexit", "timeout", "cancel"])
        await tree(kind, "strict");
    } else {
      await refusal(actual, "host capability unavailable");
      console.log(
        `NOT_EXERCISED strict process containment: ${capability.reason}`,
      );
    }
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
        // Cold Windows starts share the runner's finite 60 s process budget.
        timeout: 60000,
      });
      assert.equal(
        child.status,
        expected,
        `${args}: ${child.stdout} ${child.stderr}`,
      );
      return JSON.parse(child.stdout);
    }
    cli(["block", "add", `./${basename(f.directory)}`]);
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
    const exited = new Promise((resolve) => child.once("exit", resolve));
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
          60000,
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
      await closeChild(
        child,
        exited,
        supervision.cleanupTimeoutMs,
        "MCP shutdown",
        () => errors,
      );
    }
  }
  if (["all", "leased"].includes(mode)) {
    const { createAssembly } = await import("forge-workflow/runtime");
    const { createStateClient } = await import(
      new URL("dist/src/assembly/state-client.js", packageUrl)
    );
    const { StateOwner } = await import("forge-workflow/state");
    const { sqliteStore } = await import("forge-workflow/adapters/sqlite");
    const database = await sqliteStore.open({
      path: join(root, "leased.sqlite"),
      readOnly: false,
    });
    assert.equal(database.ok, true);
    const owner = new StateOwner(database.handle.value, {
      now: () => Date.now(),
    });
    owner.initialize();
    const context = {
      variant: "leased",
      leaseMode: "held",
      actor: { kind: "agent", id: "a" },
      session: { id: "session" },
      project: { id: root, root },
      leaseGeneration: 1,
    };
    owner.acquire(
      "example.org/sample",
      "subject",
      { actor: context.actor, session: context.session },
      60000,
      "claim",
    );
    const state = createStateClient({
      owner,
      namespace: "example.org/sample",
      context,
      write: true,
      requestId: "leased-write",
    });
    const f = fixture(
      "async ({ services }) => { services.retain(services.state); await Promise.resolve(); services.state.put('count', {count:1}, {expectRevision:0, subject:'subject'}); return 'leased'; }",
      3000,
      ["sample:write"],
    );
    f.trust.grant("human", f.block.digest, ["sample:write"]);
    let retained, cached;
    try {
      const result = await f
        .runtime({
          state,
          retain(client) {
            retained = client;
            cached = client.put;
          },
        })
        .invoke(f.request);
      assert.equal(result.result, "leased", JSON.stringify(result));
      assert.equal(owner.get("example.org/sample", "count").revision, 1);
      for (const call of [
        () =>
          retained.put(
            "escaped",
            {},
            { expectRevision: 0, subject: "subject" },
          ),
        () => cached("escaped", {}, { expectRevision: 0, subject: "subject" }),
        () => retained.renew("subject", 60000),
        () => retained.release("subject"),
      ])
        assert.throws(
          call,
          (error) => error.error?.code === "SERVICE_EXPIRED",
          "settled leased client must not write",
        );
      assert.equal(owner.get("example.org/sample", "escaped"), undefined);
      assert.equal(owner.lease("example.org/sample", "subject").generation, 1);
    } finally {
      await database.handle.close();
    }
    // Run through the assembled held-context binding too. Cancellation of the settled
    // signal tries a delayed write while the SQLite invocation lease is still open.
    const assemblyRoot = join(root, "assembled");
    mkdirSync(assemblyRoot);
    const b = join(assemblyRoot, "counter");
    mkdirSync(b);
    const declarations = Object.fromEntries(
      ["claim", "put", "show"].map((verb) => [
        `counter.${verb}`,
        {
          input: "input.json",
          output: "output.json",
          context: verb === "show" ? "project" : "leased",
          ...(verb === "show"
            ? {}
            : { leaseMode: verb === "claim" ? "acquire" : "held" }),
          effects: verb === "show" ? [] : ["counter:write"],
          idempotent: false,
          callers: ["human", "agent"],
          stability: "stable",
          timeoutMs: 15000,
        },
      ]),
    );
    const manifest = {
      schemaVersion: "forge.block/1",
      id: "example.org/counter",
      version: "1.0.0",
      authorAbi: "forge.author/v2",
      profile: "trusted-action/v2",
      entry: "index.cjs",
      docs: "docs.json",
      requires: [{ slot: "state", interface: "forge.state@1" }],
      operations: declarations,
    };
    const source = `module.exports = {
      'counter.claim': async ({services:s}) => { await Promise.resolve(); return s.state.acquire('subject',60000); },
      'counter.put': async ({services:s,signal}) => { const put=s.state.put; signal.addEventListener('abort',()=>{try{put('escaped',{}, {expectRevision:0,subject:'subject'});}catch(error){if(error.error?.code!=='SERVICE_EXPIRED')throw error;}}); await Promise.resolve(); return s.state.put('count',{count:1},{expectRevision:0,subject:'subject'}); },
      'counter.show': ({services:s}) => s.state.get('escaped') ?? null
    };`;
    for (const [file, value] of Object.entries({
      "forge.block.json": JSON.stringify(manifest),
      "index.cjs": source,
      "input.json": '{"type":"object"}',
      "output.json": "{}",
      "docs.json": JSON.stringify({
        operations: Object.fromEntries(
          Object.keys(declarations).map((op) => [
            op,
            { title: op, summary: op },
          ]),
        ),
      }),
    }))
      writeFileSync(join(b, file), value);
    const assembly = await createAssembly({
      root: assemblyRoot,
      deviceRoot: join(assemblyRoot, "device"),
    });
    const ctx = {
      actor: { kind: "agent", id: "a" },
      project: { id: assemblyRoot, root: assemblyRoot },
      session: { id: "session" },
      device: { id: join(assemblyRoot, "device") },
    };
    let sequence = 0;
    const invoke = (op, input = {}, context = ctx, caller = "agent") =>
      assembly.catalog.invoke({
        schemaVersion: "forge.invocation/1",
        requestId: `assembled-${++sequence}`,
        op,
        input,
        context,
        caller,
      });
    try {
      assert.equal(
        (await invoke("block.add", { path: "./counter" })).result?.admitted,
        false,
      );
      const checked = await invoke("block.check", { path: "./counter" });
      assert.equal(
        (
          await invoke(
            "block.admit",
            { digest: checked.result.digest },
            ctx,
            "human",
          )
        ).ok,
        true,
      );
      assert.equal(
        (
          await invoke(
            "config.grant",
            { digest: checked.result.digest, effects: ["counter:write"] },
            ctx,
            "human",
          )
        ).ok,
        true,
      );
      const claimed = await invoke("counter.claim");
      assert.equal(claimed.result.generation, 1);
      const put = await invoke(
        "counter.put",
        {},
        { ...ctx, leaseGeneration: 1 },
      );
      assert.equal(put.ok, true, JSON.stringify(put));
      assert.equal(
        (await invoke("counter.show")).result,
        null,
        "settled assembled leased client must not write",
      );
    } finally {
      await assembly.close();
    }
  }
  console.log(`PASS async-handlers ${mode}`);
} finally {
  // Failed counterfactuals must not leave the very descendant they exposed running.
  for (const file of readdirSync(root).filter((name) =>
    name.endsWith(".ready"),
  )) {
    const pid = Number(readFileSync(join(root, file), "utf8"));
    if (process.platform === "win32")
      spawnSync(
        win32.join(
          process.env.SystemRoot ?? "C:/Windows",
          "System32",
          "taskkill.exe",
        ),
        ["/PID", String(pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore", timeout: 5000 },
      );
    else {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already stopped */
      }
    }
  }
  rmSync(root, { recursive: true, force: true });
}
