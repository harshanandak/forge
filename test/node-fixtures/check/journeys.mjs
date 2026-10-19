import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  readFileSync,
  mkdtempSync,
  rmSync,
  watchFile,
  unwatchFile,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { ecosystems } from "./ecosystems.mjs";

const installed = process.argv[2];
const mode = process.argv[3] ?? "all";
const load = (path) =>
  import(pathToFileURL(join(installed, "dist/src", path)).href);
const { createCheck, verifyReceipt } = await load("blocks/check/index.js");
const { hash } = await load("blocks/check/receipt.js");
const { operations } = await load("blocks/check/operations.js");
const { createRunnerOutput } = await load("adapters/runner-output/index.js");
const { createProcessPort } = await load("adapters/process/index.js");
const { StateOwner } = await load("core/state/index.js");
const { sqliteStore } = await load("adapters/store-sqlite/index.js");
const { detectProject, createFolderFiles } = await load(
  "blocks/project/index.js",
);
const child = fileURLToPath(new URL("child.mjs", import.meta.url));
const directory = realpathSync(mkdtempSync(join(tmpdir(), "check-journey-")));
const opened = await sqliteStore.open({
  path: mode === "all" ? join(directory, "state.sqlite") : ":memory:",
  readOnly: false,
});
assert.equal(opened.ok, true, "state opened");
const owner = new StateOwner(opened.handle.value, { now: () => Date.now() });
owner.initialize();
const actor = { kind: "human", id: "check-fixture" };
const state = {
  get: (key) => owner.get("forge/check", key),
  put: (key, value, options) =>
    owner.put("forge/check", key, value, actor, options),
  list: (prefix) => owner.list("forge/check", prefix),
  events: (key) => owner.events("forge/check", key),
};
const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key, value]) =>
      value !== undefined && !/^(?:CHECK_PARENT_ONLY|NODE_OPTIONS)$/i.test(key),
  ),
);
baseEnv.CHECK_SELECTED = "child";
process.env.CHECK_PARENT_ONLY = "must not leak";
const services = {
  root: directory,
  environment: baseEnv,
  state,
  clock: { now: () => Date.now() },
  snapshot: async () => ({
    head: "fixture-exact-head",
    filesDigest:
      "sha256:" +
      createHash("sha256").update(readFileSync(child)).digest("hex"),
  }),
  process: createProcessPort({
    supervision: {
      cleanupTimeoutMs: 5000,
      pollIntervalMs: 25,
      drainTimeoutMs: 250,
      maxConcurrent: 1,
    },
  }),
  output: createRunnerOutput(),
};
const check = createCheck(services);
const config = (name, timeoutMs = 3000) => ({
  commands: { test: { argv: [process.execPath, child, name] } },
  timeoutMs,
  maxOutputBytes: 8192,
  outputHeadBytes: 1024,
  outputTailBytes: 1024,
  maxMetadataBytes: 32768,
  maxReceiptBytes: 262144,
  report: "auto",
  stopOnFailure: true,
  inputs: [],
  maxInputBytes: 1048576,
  environment: [],
});
const cases = {
  async budget() {
    await assert.rejects(
      services.process.run(
        services.process.resolve(process.execPath, baseEnv),
        [child, "maximum"],
        {
          cwd: directory,
          env: baseEnv,
          timeoutMs: 3000,
          maxOutputBytes: 1,
          capture: { headBytes: 2, tailBytes: 2 },
        },
      ),
      { code: "INVALID_OPTIONS" },
    );
    let io = 0;
    const guarded = createCheck({
      ...services,
      snapshot: async () => {
        io++;
        return services.snapshot();
      },
    });
    for (const change of [{ maxReceiptBytes: 4096 }, { maxMetadataBytes: 1 }]) {
      await assert.rejects(
        guarded.run({}, { ...config("maximum"), ...change }),
        /INPUT_INVALID/,
        "budget conflict refuses before I/O",
      );
      assert.equal(io, 0, "budget conflict refuses before I/O");
    }
    const options = {
      ...config("maximum"),
      maxOutputBytes: 262144,
      commands: {
        first: { argv: [process.execPath, child, "maximum"] },
        second: { argv: [process.execPath, child, "maximum"] },
      },
      stopOnFailure: false,
    };
    const receipt = await check.run({}, options);
    assert.equal(receipt.runs.length, 2);
    assert.equal(
      verifyReceipt(receipt, receipt.inputsDigest),
      true,
      "bounded receipt verifies",
    );
    assert.ok(
      Buffer.byteLength(JSON.stringify(receipt)) <= options.maxReceiptBytes,
      "receipt fits declared total",
    );
    const full = Buffer.from("H" + "x".repeat(262142) + "T");
    const expected =
      "sha256:" + createHash("sha256").update(full).digest("hex");
    for (const run of receipt.runs)
      for (const stream of [run.stdoutEvidence, run.stderrEvidence]) {
        assert.equal(stream.totalBytes, 262144, "full stream length");
        assert.equal(
          stream.digest,
          expected,
          "full streaming digest includes discarded middle",
        );
        assert.equal(stream.complete, true, "stream drained completely");
        assert.equal(
          Buffer.from(stream.head, "base64").length,
          options.outputHeadBytes,
          "bounded head bytes",
        );
        assert.equal(
          Buffer.from(stream.tail, "base64").length,
          options.outputTailBytes,
          "bounded tail bytes",
        );
      }
    assert.deepEqual(check.show(receipt.id), receipt);
  },
  async pytest() {
    const output = createRunnerOutput();
    assert.equal(
      output.parse("1 passed, 1 warning in 0.12s", "", "auto").testCount,
      1,
      "pytest warnings preserve the real test count",
    );
    assert.equal(
      output.parse("1 mystery, 2 passed in 0.12s", "", "auto").testCount,
      null,
      "unknown summary terms never yield a partial count",
    );
  },
  async cancellation() {
    const controller = new AbortController();
    const marker = join(directory, "cancel-ready.json");
    let observed;
    let launches = 0;
    watchFile(marker, { interval: 25, persistent: false }, (info) => {
      if (info.size > 0) controller.abort();
    });
    try {
      const command = { argv: [process.execPath, child, "cancel", marker] };
      await assert.rejects(
        operations["check.run"]({
          input: {},
          config: {
            ...config("unknown", 3000),
            commands: { first: command, second: command },
          },
          signal: controller.signal,
          deadline: Date.now() + 10000,
          services: {
            ...services,
            process: {
              ...services.process,
              async run(...args) {
                launches++;
                observed = await services.process.run(...args);
                return observed;
              },
            },
          },
        }),
        /INVOCATION_CANCELLED/,
        "actual process cancellation rejects the handler",
      );
      assert.equal(
        observed.timedOut,
        false,
        "cancellation stops the tree before command timeout",
      );
      assert.match(
        observed.stdout,
        /output before timeout/,
        "cancellation retains output",
      );
      assert.equal(launches, 1, "cancellation starts no subsequent check");
      const pids = JSON.parse(readFileSync(marker, "utf8"));
      for (const pid of Object.values(pids))
        assert.throws(
          () => process.kill(pid, 0),
          "cancellation stops every marked process",
        );
      assert.equal(state.list().length, 0, "cancellation persists no receipt");
    } finally {
      unwatchFile(marker);
    }
  },
  async handler() {
    const controller = new AbortController();
    const args = {
      input: {},
      config: config("unknown"),
      services,
      signal: controller.signal,
      deadline: Date.now() + 3000,
    };
    const receipt = await operations["check.run"](args);
    assert.equal(
      receipt.status,
      "PASS",
      "async handler awaits the actual process service",
    );
    assert.match(receipt.runs[0].stdout, /project-owned check finished/);
    const before = state.list().length;
    controller.abort();
    await assert.rejects(
      operations["check.run"](args),
      /INVOCATION_CANCELLED/,
      "cancelled handler starts no process",
    );
    assert.equal(
      state.list().length,
      before,
      "cancelled handler writes no accepted receipt",
    );
  },
  async unknown() {
    const receipt = await check.run({}, config("unknown"));
    assert.equal(receipt.status, "PASS", "unknown output uses exit code");
    assert.equal(
      receipt.runs[0].testCount,
      null,
      "unknown count stays unknown",
    );
    assert.equal(
      (await check.run({}, config("fail"))).status,
      "FAIL",
      "nonzero exit fails",
    );
  },
  async zero() {
    assert.equal(
      (await check.run({}, config("zero"))).status,
      "FAIL",
      "recognized zero tests fail",
    );
  },
  async malformed() {
    assert.equal(
      (await check.run({}, config("malformed"))).status,
      "INCOMPLETE",
      "malformed reports incomplete",
    );
  },
  async nothing() {
    assert.equal(
      (await check.run({}, { ...config("unknown"), commands: {} })).status,
      "NOT_EXECUTED",
      "nothing declared is not executed",
    );
    assert.equal(
      (await check.run({ checks: ["lint"] }, config("unknown"))).status,
      "NOT_EXECUTED",
      "no lint is not invented",
    );
  },
  async environment() {
    const receipt = await check.run({}, config("environment"));
    assert.equal(
      receipt.status,
      "PASS",
      "child gets only selected environment",
    );
    assert.match(receipt.runs[0].stdout, /isolated environment/);
    assert.equal(process.env.CHECK_PARENT_ONLY, "must not leak");
  },
  async timeout() {
    const receipt = await check.run({}, config("timeout", 3000));
    assert.equal(receipt.status, "INCOMPLETE", "timeout never passes");
    assert.match(
      receipt.runs[0].stdout,
      /output before timeout/,
      "timeout keeps output",
    );
    const pid = Number(/descendant:(\d+)/.exec(receipt.runs[0].stdout)?.[1]);
    assert.ok(pid > 0, "descendant started");
    let alive = true;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(alive, false, "timeout reaps descendant");
  },
  async receipt() {
    const receipt = await check.run({ trigger: "manual" }, config("unknown"));
    const { digest: _digest, ...body } = receipt;
    const invalid = { ...body, status: ["PASS"] };
    assert.equal(
      verifyReceipt(
        { ...invalid, digest: hash(invalid) },
        receipt.inputsDigest,
      ),
      false,
      "coercible receipt status is invalid",
    );
    assert.equal(verifyReceipt(receipt, receipt.inputsDigest), true);
    assert.equal(
      verifyReceipt({ ...receipt, status: "FAIL" }, receipt.inputsDigest),
      false,
      "changed evidence fails integrity",
    );
    assert.equal(
      verifyReceipt(receipt, "sha256:" + "f".repeat(64)),
      false,
      "different inputs cannot reuse receipt",
    );
    assert.deepEqual(
      check.show(receipt.id),
      receipt,
      "readback from state owner",
    );
    const changed = await createCheck({
      ...services,
      environment: { ...baseEnv, CHECK_SELECTED: "other" },
    }).run({ trigger: "manual" }, config("unknown"));
    assert.notEqual(
      changed.inputsDigest,
      receipt.inputsDigest,
      "environment binds receipt",
    );
  },
};
try {
  const selected = mode === "all" ? Object.keys(cases) : [mode];
  for (const name of selected) {
    assert.ok(cases[name], `unknown journey ${name}`);
    await cases[name]();
  }
  const ecosystem =
    mode === "all"
      ? await ecosystems({
          directory,
          services,
          createCheck,
          detectProject,
          createFolderFiles,
        })
      : undefined;
  console.log(
    JSON.stringify({ passed: selected, runtime: process.version, ecosystem }),
  );
} finally {
  await opened.handle.close();
  rmSync(directory, { recursive: true, force: true });
}
