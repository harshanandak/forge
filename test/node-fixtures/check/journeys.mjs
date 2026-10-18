import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { ecosystems } from "./ecosystems.mjs";

const installed = process.argv[2];
const mode = process.argv[3] ?? "all";
const load = (path) =>
  import(pathToFileURL(join(installed, "dist/src", path)).href);
const { createCheck, verifyReceipt } = await load("blocks/check/index.js");
const { createRunnerOutput } = await load("adapters/runner-output/index.js");
const { createProcessPort } = await load("adapters/process/index.js");
const { StateOwner } = await load("core/state/index.js");
const { sqliteStore } = await load("adapters/store-sqlite/index.js");
const { detectProject, createFolderFiles } = await load(
  "blocks/project/index.js",
);
const child = fileURLToPath(new URL("child.mjs", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "check-journey-"));
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
  process: createProcessPort(),
  output: createRunnerOutput(),
};
const check = createCheck(services);
const config = (name, timeoutMs = 3000) => ({
  commands: { test: { argv: [process.execPath, child, name] } },
  timeoutMs,
  maxOutputBytes: 8192,
});
const cases = {
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
    const receipt = await check.run({}, config("timeout", 800));
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
