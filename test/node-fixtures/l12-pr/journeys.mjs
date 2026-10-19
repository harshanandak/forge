import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [installed, root, mode = "all", provider] = process.argv.slice(2);
const load = (path) =>
  import(pathToFileURL(join(installed, "dist/src", path)).href);
const { Runtime, Catalog, TrustStore, captureBlock, nodeRunIsolation } =
  await load("assembly/runtime.js");
const { blockCapture } = await load("assembly/capture.js");
const { StateOwner } = await load("core/state/index.js");
const { sqliteStore } = await load("adapters/store-sqlite/index.js");
const { ASSEMBLY_PROVIDES } = await load("assembly/providers.js");
const { createStateClient } = await load("assembly/state-client.js");
const { createProcessPort } = await load("adapters/process/index.js");
mkdirSync(root, { recursive: true });
const file = join(root, "fake-github.json");
let now = Date.now();
const head = "a".repeat(40),
  base = "b".repeat(40),
  reference = { repository: "owner/repository", number: 42 };
const subject = `pr:${reference.repository}:${reference.number}`;
function ready() {
  return {
    ...reference,
    headSha: head,
    baseSha: base,
    state: "OPEN",
    draft: false,
    mergeable: "MERGEABLE",
    complete: true,
    checks: [
      {
        name: "tests",
        appId: 7,
        headSha: head,
        status: "COMPLETED",
        conclusion: "SUCCESS",
      },
    ],
    requiredChecks: [{ name: "tests", appId: 7 }],
    reviews: [
      {
        id: "R1",
        author: "reviewer",
        state: "APPROVED",
        headSha: head,
        updatedAt: now - 10000,
      },
    ],
    threads: [],
    findings: [],
    lastActivityAt: now - 10000,
  };
}
function save(evidence = ready(), extra = {}) {
  writeFileSync(file, JSON.stringify({ evidence, ...extra }));
}
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    ["path", "pathext", "systemroot", "windir", "home", "tmp", "temp"].includes(
      key.toLowerCase(),
    ),
  ),
);
const config = {
  envNames: Object.keys(env),
  provider: {
    executable: process.execPath,
    readArgs: [provider, installed, file],
    writeArgs: [provider, installed, file],
    timeoutMs: 20000,
    maxOutputBytes: 1048576,
  },
  minApprovals: 1,
  settleMs: 100,
  optionalChecks: "safe-terminal",
  allowNoChecks: false,
  blockingLabels: ["P0", "P1"],
  leaseMs: 10000,
  squashTitle: "Merge {repository} #{number}",
  squashBody: "Explicit owner body",
};
const pr = captureBlock(join(installed, "dist/src/blocks/pr"), blockCapture);
assert.ok(pr.validate("schemas/config.json", config));
const catalog = new Catalog(
  {
    schemaVersion: "forge.config/1",
    blocks: { pr: { source: { path: "./pr" }, config } },
  },
  new Map([["pr", pr]]),
  undefined,
  ASSEMBLY_PROVIDES,
);
const trust = new TrustStore();
trust.admit("human", pr.digest);
trust.grant("human", pr.digest, [
  "pr:write",
  "external:write",
  "external:process",
  "environment:read",
]);
const opened = await sqliteStore.open({
  path: join(root, "state.sqlite"),
  readOnly: false,
});
assert.ok(opened.ok);
const state = new StateOwner(opened.handle.value, { now: () => now });
state.initialize();
const port = createProcessPort({
  supervision: {
    cleanupTimeoutMs: 5000,
    pollIntervalMs: 25,
    drainTimeoutMs: 250,
    maxConcurrent: 1,
  },
});
let beforePut,
  afterProvider,
  spawns = 0,
  sequence = 0;
const runtime = new Runtime(catalog, trust, {
  isolation: nodeRunIsolation,
  limits: { timeoutMs: 120000 },
  services: async (_instance, context, scope) => {
    const client = createStateClient({
      owner: state,
      namespace: "forge/pr",
      context,
      write: scope.effects.includes("pr:write"),
      requestId: `pr-${sequence}`,
    });
    return {
      ownership: "borrowed",
      value: {
        state: {
          ...client,
          now: () => now,
          put(...args) {
            const resume = beforePut;
            beforePut = undefined;
            resume?.();
            return client.put(...args);
          },
        },
        environment: {
          select: (names) =>
            Object.fromEntries(
              Object.entries(env).filter(([name]) => names.includes(name)),
            ),
        },
        process: {
          capability: port.capability,
          cwd: root,
          resolve: port.resolve,
          async run(...args) {
            spawns++;
            const result = await port.run(...args);
            const resume = afterProvider;
            afterProvider = undefined;
            resume?.();
            return result;
          },
        },
      },
    };
  },
});
const actor = (name) => ({ kind: "agent", id: name });
const context = (generation, who = "alice") => ({
  actor: actor(who),
  project: { id: root },
  session: { id: who },
  ...(generation === undefined
    ? {}
    : generation === "acquire"
      ? {}
      : { leaseGeneration: generation }),
});
async function invoke(op, input = reference, generation, who = "alice") {
  sequence++;
  return runtime.invoke({
    schemaVersion: "forge.invocation/1",
    requestId: `pr-${sequence}`,
    caller: "agent",
    op: `pr.${op}`,
    input,
    context: context(generation, who),
  });
}
async function good(op, input = reference, generation) {
  const value = await invoke(op, input, generation);
  assert.equal(value.ok, true, JSON.stringify(value));
  return value.result;
}
function error(value, code) {
  assert.equal(value.ok, false, "expected rejection");
  assert.equal(value.error.code, code, JSON.stringify(value));
}
async function status(expected) {
  const value = await good("status");
  assert.equal(value.verdict.status, expected, `expected verdict ${expected}`);
  return value;
}
try {
  if (["all", "verdicts"].includes(mode)) {
    const cases = [
      ["MERGE_READY", ready()],
      ["DRAFT", { ...ready(), draft: true }],
      ["CONFLICTING", { ...ready(), mergeable: "CONFLICTING" }],
      ["CHECKS_PENDING", { ...ready(), checks: [] }],
      [
        "CHECKS_FAILED",
        {
          ...ready(),
          checks: [{ ...ready().checks[0], conclusion: "FAILURE" }],
        },
      ],
      [
        "REVIEW_BLOCKED",
        { ...ready(), threads: [{ id: "T1", resolved: false }] },
      ],
      ["REVIEW_REQUIRED", { ...ready(), reviews: [] }],
      ["SETTLING", { ...ready(), lastActivityAt: now }],
      ["CLOSED", { ...ready(), state: "CLOSED" }],
      ["MERGED", { ...ready(), state: "MERGED" }],
    ];
    for (const [expected, evidence] of cases) {
      save(evidence);
      const value = await status(expected);
      assert.deepEqual(value.evidence, evidence);
    }
    save(ready(), { malformed: true });
    await status("INCOMPLETE");
    assert.equal(
      state.events("forge/pr").length,
      0,
      "reads must never write state",
    );
  }
  if (["all", "optional"].includes(mode)) {
    for (const conclusion of ["NEUTRAL", "SKIPPED"]) {
      save({
        ...ready(),
        checks: [
          ...ready().checks,
          {
            name: "optional",
            appId: 7,
            headSha: head,
            status: "COMPLETED",
            conclusion,
          },
        ],
      });
      await status("MERGE_READY");
    }
    save({
      ...ready(),
      checks: [{ ...ready().checks[0], conclusion: "NEUTRAL" }],
    });
    await status("CHECKS_FAILED");
  }
  if (["all", "stale-review"].includes(mode)) {
    save({
      ...ready(),
      reviews: [
        ...ready().reviews,
        {
          id: "R0",
          author: "history",
          state: "COMMENTED",
          headSha: "c".repeat(40),
          updatedAt: now - 20000,
        },
      ],
    });
    await status("MERGE_READY");
  }
  if (["all", "merge", "head", "fence", "accepted"].includes(mode)) {
    save();
    const claim = await good("claim", reference, "acquire");
    assert.equal(state.lease("forge/pr", subject).generation, claim.generation);
    const input = { ...reference, expectHead: head, expectRevision: 0 };
    if (["all", "head"].includes(mode)) {
      error(
        await invoke(
          "merge",
          { ...input, expectHead: "c".repeat(40) },
          claim.generation,
        ),
        "HEAD_MOVED",
      );
      assert.equal(
        JSON.parse(readFileSync(file, "utf8")).evidence.state,
        "OPEN",
        "moved head must not merge",
      );
    }
    if (["all", "fence"].includes(mode)) {
      beforePut = () => {
        now += 10001;
        state.acquire(
          "forge/pr",
          subject,
          { actor: actor("bob"), session: { id: "bob" } },
          10000,
          "competitor",
        );
      };
      error(await invoke("merge", input, claim.generation), "LEASE_STALE");
      assert.equal(
        JSON.parse(readFileSync(file, "utf8")).evidence.state,
        "OPEN",
        "stale lease must not trigger provider mutation",
      );
      now += 10001;
    }
    if (["all", "accepted"].includes(mode)) {
      const held = ["accepted", "merge"].includes(mode)
        ? claim
        : await good("claim", reference, "acquire");
      // Deterministic provider barrier: expire and replace only after the merge command settles.
      let seen = 0;
      const barrier = () => {
        if (++seen === 2) {
          now += 10001;
          state.acquire(
            "forge/pr",
            subject,
            { actor: actor("bob"), session: { id: "bob" } },
            10000,
            "accepted-race",
          );
        } else afterProvider = barrier;
      };
      afterProvider = barrier;
      error(await invoke("merge", input, held.generation), "LEASE_STALE");
      assert.equal(
        state.get("forge/pr", subject).value.phase,
        "merging",
        "lost lease must not accept merged evidence",
      );
      now += 10001;
      save();
    }
    if (["all", "merge"].includes(mode)) {
      const held = ["accepted", "merge"].includes(mode)
        ? claim
        : await good("claim", reference, "acquire");
      const revision = state.get("forge/pr", subject)?.revision ?? 0;
      const merged = await good(
        "merge",
        { ...input, expectRevision: revision },
        held.generation,
      );
      assert.equal(merged.verdict.status, "MERGED");
      assert.equal(state.get("forge/pr", subject).value.phase, "merged");
      const stored = JSON.parse(readFileSync(file, "utf8"));
      assert.equal(stored.mergeInput.sha, head);
      assert.equal(
        stored.mergeInput.commit_title,
        "Merge owner/repository #42",
      );
      assert.equal(stored.mergeInput.commit_message, "Explicit owner body");
      error(
        await invoke(
          "merge",
          {
            ...input,
            expectRevision: merged.revision,
            body: "Co-authored-by: Tool <a@example.test>",
          },
          held.generation,
        ),
        "INPUT_INVALID",
      );
      await good("release", reference, held.generation);
    }
  }
  console.log(
    `PR journey ${mode}: passed; supervised provider calls=${spawns}`,
  );
} finally {
  await opened.handle.close();
}
