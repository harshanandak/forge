import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssembly } from "forge-workflow/runtime";
// Cleanup may settle while a stopped member is still an unreaped zombie, which
// answers kill(pid, 0) on every POSIX platform. This probe reads its state.
import { isRunning as alive } from "./liveness.mjs";

const mode = process.argv[2] ?? "all";
const packageUrl = import.meta.resolve("forge-workflow/package.json");
const bin = fileURLToPath(new URL("dist/bin/forge.js", packageUrl));
const root = mkdtempSync(join(process.cwd(), "ap-"));
const device = join(root, "device");
const env = {
  ...process.env,
  FORGE_DEVICE_ROOT: device,
  PROVIDER_FIXTURE_VISIBLE: "selected",
  PROVIDER_FIXTURE_HIDDEN: "ambient",
};
const gitEnv = Object.fromEntries(
  Object.entries(env).filter(([key]) => !/^GIT_/i.test(key)),
);
gitEnv.GIT_CONFIG_NOSYSTEM = "1";
gitEnv.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
function git(...args) {
  const result = spawnSync("git", ["-C", root, ...args], {
    env: gitEnv,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10000,
  });
  assert.equal(result.status, 0, `${args}: ${result.stdout} ${result.stderr}`);
  return result.stdout.trim();
}
git("init", "--quiet");
git(
  "-c",
  "user.name=Fixture",
  "-c",
  "user.email=fixture@example.invalid",
  "commit",
  "--quiet",
  "--allow-empty",
  "-m",
  "fixture",
);
const operations = {};
const effects = {
  run: ["external:process", "environment:read"],
  timeout: ["external:process", "environment:read"],
  deniedprocess: ["environment:read"],
  env: ["environment:read"],
  deniedenv: [],
  read: ["files:read"],
  deniedfiles: [],
  deniedwrite: [],
  write: ["files:write"],
  remove: ["files:write"],
  snapshot: ["files:read"],
  crypto: [],
};
for (const [verb, declaredEffects] of Object.entries(effects)) {
  operations[`provider.${verb}`] = {
    input: "input.json",
    output: "output.json",
    context: "project",
    effects: declaredEffects,
    idempotent: false,
    callers: ["human", "agent"],
    stability: "stable",
    timeoutMs: verb === "timeout" ? 1500 : 10000,
  };
}
const block = join(root, "fixture");
mkdirSync(block);
const manifest = {
  schemaVersion: "forge.block/1",
  id: "example.org/provider",
  version: "1.0.0",
  authorAbi: "forge.author/v2",
  profile: "trusted-action/v2",
  entry: "entry.cjs",
  docs: "docs.json",
  requires: ["process", "files", "environment", "crypto", "state"].map(
    (slot) => ({
      slot,
      interface: `forge.${slot}@1`,
    }),
  ),
  operations,
};
writeFileSync(join(block, "forge.block.json"), JSON.stringify(manifest));
writeFileSync(
  join(block, "docs.json"),
  JSON.stringify({
    operations: Object.fromEntries(
      Object.keys(operations).map((op) => [
        op,
        { title: op, summary: "Exercise a declared generic service." },
      ]),
    ),
  }),
);
writeFileSync(join(block, "input.json"), '{"type":"object"}');
writeFileSync(join(block, "output.json"), "{}");
copyFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "entry.cjs"),
  join(block, "entry.cjs"),
);
writeFileSync(join(root, "input.txt"), "first");
const assembly = await createAssembly({
  root,
  deviceRoot: device,
  providers: { env },
});
const context = {
  actor: { kind: "human", id: "fixture" },
  project: { id: root, root },
  device: { id: device },
  session: { id: "fixture" },
};
let sequence = 0;
const invoke = (op, input = {}) =>
  assembly.catalog.invoke({
    schemaVersion: "forge.invocation/1",
    requestId: `provider-${++sequence}`,
    op,
    input,
    caller: "human",
    context,
  });
const ok = (result, label) => {
  assert.equal(result.ok, true, `${label}: ${JSON.stringify(result)}`);
  return result.result;
};
function cli(verb, input) {
  const result = spawnSync(
    process.execPath,
    [bin, "provider", verb, "--input", JSON.stringify(input)],
    { cwd: root, env, encoding: "utf8", windowsHide: true, timeout: 20000 },
  );
  assert.equal(result.status, 0, `${verb}: ${result.stdout} ${result.stderr}`);
  return ok(JSON.parse(result.stdout), verb);
}
const names = [
  "PROVIDER_FIXTURE_VISIBLE",
  ...Object.keys(env).filter((key) =>
    ["path", "pathext", "systemroot", "windir", "tmp", "temp"].includes(
      key.toLowerCase(),
    ),
  ),
];
const launch = (source) => ({
  executable: process.execPath,
  args: ["-e", source],
  names,
});
async function mcpRun(input, name = "provider_run") {
  const child = spawn(process.execPath, [bin, "--mcp"], {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  let id = 0,
    buffer = "",
    stderr = "";
  const pending = new Map();
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const next = ++id;
      const timer = setTimeout(
        () => reject(Error(`MCP timeout: ${stderr}`)),
        15000,
      );
      pending.set(next, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: next, method, params }) + "\n",
      );
    });
  try {
    await rpc("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "assembly-fixture", version: "1.0.0" },
    });
    child.stdin.write(
      '{"jsonrpc":"2.0","method":"notifications/initialized"}\n',
    );
    const response = await rpc("tools/call", {
      name,
      arguments: input,
    });
    assert.ok(
      response.result,
      `generated MCP response: ${JSON.stringify(response)}`,
    );
    return ok(response.result.structuredContent, "generated MCP");
  } finally {
    child.stdin.end();
    const deadline = setTimeout(() => child.kill(), 5000);
    try {
      await exited;
    } finally {
      clearTimeout(deadline);
    }
  }
}
try {
  assembly.catalog.list();
  assert.equal(
    existsSync(join(root, ".forge")),
    false,
    "discovery must not create a project home",
  );
  assert.equal(
    existsSync(device),
    false,
    "discovery must not create a device home",
  );
  ok(await invoke("config.show"), "empty config");
  assert.equal(existsSync(device), false, "empty config must remain read only");
  const added = await invoke("block.add", { path: "./fixture" });
  assert.equal(added.error?.code, "ADMISSION_REQUIRED", JSON.stringify(added));
  const digest = ok(
    await invoke("block.check", { path: "./fixture" }),
    "check fixture",
  ).digest;
  ok(await invoke("block.admit", { digest }), "admit fixture");
  ok(
    await invoke("config.grant", {
      digest,
      effects: [...new Set(Object.values(effects).flat())],
    }),
    "grant fixture",
  );
  assert.deepEqual(
    assembly.catalog.unavailable(),
    [],
    "all declared provider slots must bind",
  );

  if (["all", "runner-output"].includes(mode)) {
    const directory = join(root, "output-parser");
    mkdirSync(directory);
    writeFileSync(
      join(directory, "forge.block.json"),
      JSON.stringify({
        ...manifest,
        id: "example.org/output-parser",
        requires: [{ slot: "output", interface: "forge.runner-output@1" }],
        operations: {
          "report.parse": {
            ...operations["provider.crypto"],
            context: "stateless",
            effects: [],
          },
        },
      }),
    );
    writeFileSync(
      join(directory, "docs.json"),
      JSON.stringify({
        operations: {
          "report.parse": {
            title: "Parse",
            summary: "Parse supplied output without external services.",
          },
        },
      }),
    );
    writeFileSync(join(directory, "input.json"), '{"type":"object"}');
    writeFileSync(join(directory, "output.json"), "{}");
    writeFileSync(
      join(directory, "entry.cjs"),
      `module.exports={"report.parse":async({input,services})=>{
      if(Object.keys(services).join(',')!=='output') throw Error('only the pure output slot may bind');
      return services.output.parse(input.stdout,input.stderr,input.format);
    }};`,
    );
    const checked = await invoke("block.check", { path: "./output-parser" });
    const outputDigest = ok(
      checked,
      "runner-output requirement must compose",
    ).digest;
    const outputAdded = await invoke("block.add", { path: "./output-parser" });
    assert.equal(outputAdded.error?.code, "ADMISSION_REQUIRED");
    ok(
      await invoke("block.admit", { digest: outputDigest }),
      "admit output parser",
    );
    const input = {
      stdout: '{"numTotalTests":7,"numFailedTests":2}',
      stderr: "",
      format: "json",
    };
    const parsed = await invoke("report.parse", input);
    assert.equal(parsed.ok, true, "runner-output service must bind and parse");
    assert.deepEqual(parsed.result, {
      kind: "recognized",
      testCount: 7,
      failed: 2,
      detail: "Structured test report",
    });
    const result = spawnSync(
      process.execPath,
      [bin, "report", "parse", "--input", JSON.stringify(input)],
      {
        cwd: root,
        env,
        encoding: "utf8",
        windowsHide: true,
        timeout: 20000,
      },
    );
    assert.equal(result.status, 0, `${result.stdout} ${result.stderr}`);
    assert.deepEqual(
      ok(JSON.parse(result.stdout), "output CLI"),
      parsed.result,
    );
    const shown = ok(await invoke("config.show"), "output MCP config");
    ok(
      await invoke("config.apply", {
        expectRevision: shown.revision,
        patch: [
          { op: "set", path: "/mcp/expose", value: ["provider", "report"] },
        ],
      }),
      "expose output parser",
    );
    assert.deepEqual(await mcpRun(input, "report_parse"), parsed.result);
  }

  if (["all", "conditional-race"].includes(mode)) {
    const { createCloneFiles } = await import(
      new URL("dist/src/adapters/fs/clone-files.js", packageUrl)
    );
    writeFileSync(join(root, "race.txt"), "expected");
    const files = createCloneFiles(
      {
        projectRoot: realpathSync(root),
        gitDirectory: realpathSync(join(root, ".git")),
        commonDirectory: realpathSync(join(root, ".git")),
        read: true,
        write: true,
        signal: new AbortController().signal,
        deadline: Date.now() + 10000,
      },
      {
        beforeCommit() {
          writeFileSync(join(root, "replacement.txt"), "user replacement");
          renameSync(join(root, "replacement.txt"), join(root, "race.txt"));
        },
      },
    );
    assert.throws(
      () => files.write("race.txt", "new bytes", { expected: "expected" }),
      /INPUT_CONFLICT/,
      "a concurrent target replacement must be refused",
    );
    assert.equal(
      readFileSync(join(root, "race.txt"), "utf8"),
      "user replacement",
      "the user's replacement survives the refused mutation",
    );
  }
  if (["all", "stateless"].includes(mode)) {
    const directory = join(root, "stateless");
    mkdirSync(directory);
    const operation = {
      ...operations["provider.run"],
      context: "stateless",
      effects: ["external:process", "environment:read"],
    };
    writeFileSync(
      join(directory, "forge.block.json"),
      JSON.stringify({
        ...manifest,
        id: "example.org/toolbox",
        requires: manifest.requires.filter(
          (slot) => slot.slot !== "files" && slot.slot !== "crypto",
        ),
        operations: { "toolbox.probe": operation },
      }),
    );
    writeFileSync(
      join(directory, "docs.json"),
      JSON.stringify({
        operations: {
          "toolbox.probe": {
            title: "Probe",
            summary: "Stateless process with a bound state reader.",
          },
        },
      }),
    );
    writeFileSync(join(directory, "input.json"), '{"type":"object"}');
    writeFileSync(join(directory, "output.json"), "{}");
    writeFileSync(
      join(directory, "entry.cjs"),
      `module.exports={"toolbox.probe":async({input,services})=>{
      services.state.get("absent");
      const env=services.environment.select(input.names);
      const executable=services.process.resolve(input.executable,env);
      return services.process.run(executable,["-e","process.stdout.write('stateless-ok')"],{cwd:services.process.cwd,env,timeoutMs:5000,maxOutputBytes:1024});
    }};`,
    );
    const added = await invoke("block.add", { path: "./stateless" });
    assert.equal(
      added.error?.code,
      "ADMISSION_REQUIRED",
      "a stateless operation with only non-state effects must compose",
    );
    const digest = ok(
      await invoke("block.check", { path: "./stateless" }),
      "check stateless",
    ).digest;
    ok(await invoke("block.admit", { digest }), "admit stateless");
    ok(
      await invoke("config.grant", { digest, effects: operation.effects }),
      "grant stateless",
    );
    assert.equal(
      ok(
        await invoke("toolbox.probe", { executable: process.execPath, names }),
        "stateless process",
      ).stdout,
      "stateless-ok",
      "stateless process with a bound state reader must run",
    );
  }

  if (["all", "process-effect"].includes(mode)) {
    const refused = await invoke(
      "provider.deniedprocess",
      launch("process.stdout.write('unauthorized')"),
    );
    assert.equal(
      refused.error?.code,
      "EFFECT_UNDECLARED",
      `process launch must require a declared launch effect: ${JSON.stringify(refused)}`,
    );
  }
  if (["all", "environment-effect"].includes(mode)) {
    assert.equal(
      (await invoke("provider.deniedenv")).error?.code,
      "EFFECT_UNDECLARED",
      "environment selection must require its declared effect",
    );
  }
  if (["all", "state-read"].includes(mode)) {
    ok(
      await invoke("provider.env", { names: [] }),
      "non-state capability with bound state",
    );
  }
  if (["all", "files-effect"].includes(mode)) {
    assert.equal(
      (await invoke("provider.deniedfiles")).error?.code,
      "EFFECT_UNDECLARED",
      "file reads must require their declared effect",
    );
    assert.equal(
      (await invoke("provider.deniedwrite")).error?.code,
      "EFFECT_UNDECLARED",
      "file writes must require their declared effect",
    );
    assert.equal(existsSync(join(root, "unauthorized.txt")), false);
  }
  if (["all", "files-cas"].includes(mode)) {
    ok(
      await invoke("provider.write", {
        path: "owned/value.txt",
        text: "original",
        options: { expected: null },
      }),
      "create clone file",
    );
    const conflict = await invoke("provider.write", {
      path: "owned/value.txt",
      text: "overwritten",
      options: { expected: "wrong" },
    });
    assert.equal(
      conflict.error?.code,
      "INPUT_CONFLICT",
      "compare before replace must preserve user content",
    );
    assert.equal(
      readFileSync(join(root, "owned/value.txt"), "utf8"),
      "original",
    );
    assert.equal(
      (
        await invoke("provider.remove", {
          path: "owned/value.txt",
          options: { expected: "wrong" },
        })
      ).error?.code,
      "INPUT_CONFLICT",
    );
    ok(
      await invoke("provider.remove", {
        path: "owned/value.txt",
        options: { expected: "original" },
      }),
      "remove owned clone file",
    );
    assert.equal(existsSync(join(root, "owned/value.txt")), false);
  }
  if (mode === "all") {
    assert.deepEqual(
      ok(await invoke("provider.env", { names: [] }), "empty environment"),
      {},
    );
    assert.deepEqual(
      ok(
        await invoke("provider.env", {
          names: ["PROVIDER_FIXTURE_VISIBLE", "PROVIDER_FIXTURE_ABSENT"],
        }),
        "selected environment",
      ),
      { PROVIDER_FIXTURE_VISIBLE: "selected" },
    );
    const source =
      "process.stdout.write(JSON.stringify({cwd:process.cwd(),visible:process.env.PROVIDER_FIXTURE_VISIBLE,hidden:process.env.PROVIDER_FIXTURE_HIDDEN,nodeOptions:process.env.NODE_OPTIONS}))";
    for (const result of [
      cli("run", launch(source)),
      await mcpRun(launch(source)),
    ]) {
      assert.equal(
        result.exitCode,
        0,
        "generated surfaces must launch and await the supervised process",
      );
      const output = JSON.parse(result.stdout);
      output.cwd = realpathSync.native(output.cwd);
      assert.deepEqual(
        output,
        { cwd: realpathSync.native(root), visible: "selected" },
        "children receive only explicitly selected environment and clone cwd",
      );
    }
    assert.equal(cli("read", { path: "input.txt", maxBytes: 1024 }), "first");
    assert.equal(
      (await invoke("provider.read", { path: "input.txt", maxBytes: 2 })).error
        ?.code,
      "LIMIT_EXCEEDED",
      "file reads must refuse truncation",
    );
    assert.equal(
      (await invoke("provider.read", { path: "../escape", maxBytes: 1024 })).ok,
      false,
      "file paths must remain clone local",
    );
    const crypto = ok(
      await invoke("provider.crypto", { text: "fixture" }),
      "pure crypto",
    );
    assert.equal(
      crypto.digest,
      createHash("sha256").update("fixture").digest("hex"),
    );
    assert.match(crypto.uuid, /^[0-9a-f-]{36}$/);
    assert.equal(crypto.roots.project, realpathSync.native(root));
    assert.equal(crypto.roots.git, realpathSync.native(join(root, ".git")));
    ok(
      await invoke("provider.write", {
        path: "provider-router",
        text: "owned",
        options: { area: "git", expected: null, executable: true },
      }),
      "metadata-area file",
    );
    assert.equal(
      readFileSync(join(root, ".git/provider-router"), "utf8"),
      "owned",
    );
    ok(
      await invoke("provider.remove", {
        path: "provider-router",
        options: { area: "git", expected: "owned" },
      }),
      "remove metadata-area file",
    );
  }
  if (["all", "snapshot"].includes(mode)) {
    const input = {
      paths: ["input.txt", "missing.txt"],
      maxBytes: 1024,
      timeoutMs: 5000,
      maxOutputBytes: 1024,
    };
    const before = ok(
      await invoke("provider.snapshot", input),
      "snapshot missing path",
    );
    assert.equal(
      before.head,
      git("rev-parse", "HEAD"),
      "snapshot uses exact clone HEAD",
    );
    writeFileSync(join(root, "missing.txt"), "");
    const created = ok(
      await invoke("provider.snapshot", input),
      "snapshot created path",
    );
    assert.notEqual(
      created.filesDigest,
      before.filesDigest,
      "missing and empty selected inputs have different identities",
    );
    writeFileSync(join(root, "input.txt"), "dirty");
    const dirty = ok(
      await invoke("provider.snapshot", input),
      "snapshot dirty input",
    );
    assert.notEqual(
      dirty.filesDigest,
      created.filesDigest,
      "snapshot hashes actual selected input bytes",
    );
    assert.equal(
      (await invoke("provider.snapshot", { ...input, maxBytes: 1 })).error
        ?.code,
      "LIMIT_EXCEEDED",
      "snapshot enforces a total input budget",
    );
  }
  if (["all", "deadline"].includes(mode)) {
    const pidFile = join(root, "timed.pid");
    const timed = await invoke(
      "provider.timeout",
      launch(
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`,
      ),
    );
    assert.equal(
      timed.error?.code,
      "INVOCATION_TIMEOUT",
      "stock assembly invocation deadline must interrupt a process",
    );
    assert.equal(
      existsSync(pidFile),
      true,
      "deadline fixture command must have started",
    );
    assert.equal(
      alive(Number(readFileSync(pidFile, "utf8"))),
      false,
      "timed child must stop before invocation settles",
    );
    const descendant = join(root, "descendant.pid");
    const childSource = `require('node:fs').writeFileSync(${JSON.stringify(descendant)},String(process.pid));setInterval(()=>{},1000);`;
    const parentSource = `const fs=require('node:fs');require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childSource)}],{stdio:'inherit'});const poll=setInterval(()=>{if(fs.existsSync(${JSON.stringify(descendant)})){clearInterval(poll);process.exit(0)}},5);`;
    const returned = ok(
      await invoke("provider.run", launch(parentSource)),
      "normal-return process drain",
    );
    assert.equal(
      returned.exitCode,
      0,
      "normal command return remains successful",
    );
    assert.equal(
      alive(Number(readFileSync(descendant, "utf8"))),
      false,
      "normal return must stop descendants before settling",
    );
  }
  assert.equal(
    existsSync(join(root, ".forge", "state.sqlite")),
    false,
    "non-state effects must not open writable project state",
  );
  console.log(`PASS assembly-providers ${mode}`);
} finally {
  await assembly.close();
  rmSync(root, { recursive: true, force: true });
}
