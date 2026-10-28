import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { captureBlock, Catalog } from "../../../src/core/catalog/index.ts";
import { Runtime } from "../../../src/core/runtime/index.ts";
import { TrustStore } from "../../../src/core/trust/index.ts";
import { nodeRunIsolation } from "../../../src/adapters/node-runtime/isolation.ts";
import type { ProcessService } from "../../../src/assembly/providers.ts";
import type { ProcessResult } from "../../../src/ports/process.ts";

setDefaultTimeout(30_000);

type Handler = (call: {
  input: Record<string, unknown>;
  services: unknown;
}) => Record<string, unknown> | Promise<Record<string, unknown>>;
let operations: Record<string, Handler>;
const globals = globalThis as Record<string, unknown>;
const previousFail = globals.fail;
beforeAll(() => {
  globals.fail = (code: string) => {
    throw new Error(code);
  };
  operations = require(
    resolve(import.meta.dirname, "../../../src/blocks/work/entry.cts"),
  ) as typeof operations;
});
afterAll(() => {
  if (previousFail === undefined) delete globals.fail;
  else globals.fail = previousFail;
});

const head = "a".repeat(40);
const merge = "b".repeat(40);
const pr = "https://github.com/example/repo/pull/1";
const merged = {
  state: "MERGED",
  headRefOid: head,
  mergeCommit: { oid: merge },
};
type Options = {
  links?: readonly { relation: string; url: string }[];
  pr?: unknown;
  process?: "missing" | "unbound" | "throw";
  environment?: "unbound";
  result?: Partial<ProcessResult>;
};
function project(
  receipt?: { id: string; status: string; subject?: string },
  options: Options = {},
) {
  const calls: unknown[] = [];
  const links = (options.links ?? [{ relation: "delivers", url: pr }]).map(
    (value, i) => ({
      key: `link:work-1:${i + 1}`,
      revision: 1,
      value,
    }),
  );
  const process: ProcessService = {
    capability: "forge.process/v1",
    cwd: "/project",
    resolve(executable, env) {
      calls.push({ executable, env });
      return options.process === "missing"
        ? { kind: "unavailable", reason: "missing", remedy: "install gh" }
        : { kind: "resolved", path: "/fake/gh" };
    },
    run(executable, args, spawn) {
      calls.push({ executable, args, spawn });
      if (options.process === "throw")
        return Promise.reject(new Error("network failure"));
      return Promise.resolve({
        exitCode: 0,
        signal: null,
        stdout: JSON.stringify(options.pr ?? merged),
        stderr: "",
        timedOut: false,
        truncated: false,
        durationMs: 0,
        ...options.result,
      });
    },
  };
  let record = {
    key: "issue:work-1",
    revision: 1,
    updatedAt: "2026-10-26T00:00:00Z",
    value: {
      id: "work-1",
      title: "Deliver",
      status: "open",
      labels: [],
      dependsOn: [],
      createdAt: "2026-10-26T00:00:00Z",
    },
  };
  const state = {
    now: () => 0,
    lease: () => undefined,
    acquire: () => undefined,
    get: (key: string) =>
      key === record.key ? structuredClone(record) : undefined,
    list: (prefix: string) =>
      prefix.startsWith("link:")
        ? structuredClone(links)
        : [structuredClone(record)],
    put(
      key: string,
      value: typeof record.value,
      options: { expectRevision: number },
    ) {
      expect(options.expectRevision).toBe(record.revision);
      record = {
        key,
        value: structuredClone(value),
        revision: record.revision + 1,
        updatedAt: record.updatedAt,
      };
      return structuredClone(record);
    },
  };
  return {
    state,
    calls,
    call: async (input: Record<string, unknown>) =>
      await operations["issue.close"]!({
        input: { id: "work-1", ...input },
        services: {
          state,
          ...(options.process === "unbound" ? {} : { process }),
          ...(options.environment === "unbound"
            ? {}
            : {
                environment: {
                  select: (names: readonly string[]) =>
                    Object.fromEntries(names.map((name) => [name, name])),
                },
              }),
          receipts: {
            get: (id: string) => {
              return receipt?.id === id ? receipt : undefined;
            },
          },
        },
      }),
    read: () =>
      operations["issue.show"]!({
        input: { id: "work-1" },
        services: { state },
      }) as Record<string, unknown>,
    stored: () => structuredClone(record),
  };
}

for (const input of [
  {},
  { reason: "merged in abc" },
  { withoutReceipt: "  \n\t" },
]) {
  test(`close refuses missing delivery evidence ${JSON.stringify(input)} without changing the item`, async () => {
    const harness = project();
    const before = harness.stored();
    await expect(harness.call(input)).rejects.toThrow("RECEIPT_REQUIRED");
    expect(harness.stored()).toEqual(before);
    expect(harness.read().status).toBe("open");
  });
}

for (const status of ["FAIL", "INCOMPLETE", "NOT_EXECUTED", undefined]) {
  test(`close refuses ${status ?? "unknown"} evidence without changing the item`, async () => {
    const harness = project(status ? { id: "receipt", status } : undefined);
    const before = harness.stored();
    await expect(harness.call({ receipt: "receipt" })).rejects.toThrow(
      "RECEIPT_INVALID",
    );
    expect(harness.stored()).toEqual(before);
  });
}

test("close stores its evidence, survives show readback and replaces previous evidence", async () => {
  const harness = project({ id: "receipt", status: "PASS", subject: head });
  expect(
    await harness.call({ receipt: "receipt", reason: "merged" }),
  ).toMatchObject({
    status: "closed",
    receipt: "receipt",
  });
  expect(harness.read()).toMatchObject({
    status: "closed",
    receipt: "receipt",
  });
  expect(await harness.call({ withoutReceipt: "Superseded" })).toMatchObject({
    status: "closed",
    withoutReceipt: "Superseded",
  });
  expect(harness.read().receipt).toBeUndefined();
  expect(harness.read()).toMatchObject({
    withoutReceipt: "Superseded",
  });
  await harness.call({ receipt: "receipt" });
  expect(harness.read().withoutReceipt).toBeUndefined();
  expect(harness.read().receipt).toBe("receipt");
});

test("an invalid supplied receipt cannot be hidden by an exemption", async () => {
  const harness = project();
  await expect(
    harness.call({ receipt: "unknown", withoutReceipt: "Superseded" }),
  ).rejects.toThrow("RECEIPT_INVALID");
  expect(harness.read().status).toBe("open");
});

for (const subject of [head, merge]) {
  test(`close binds a PASS receipt to delivered commit ${subject}`, async () => {
    const harness = project({ id: "receipt", status: "PASS", subject });
    expect(await harness.call({ receipt: "receipt" })).toMatchObject({
      status: "closed",
    });
    expect(harness.calls).toHaveLength(2);
    expect(harness.calls[1]).toMatchObject({
      args: ["pr", "view", pr, "--json", "state,headRefOid,mergeCommit"],
    });
  });
}

const refusals: readonly [string, Options, string, string?][] = [
  ["old head", {}, "RECEIPT_HEAD_MISMATCH", "c".repeat(40)],
  ["unrelated receipt", {}, "RECEIPT_HEAD_MISMATCH", "d".repeat(40)],
  ["missing subject", {}, "RECEIPT_HEAD_MISMATCH"],
  ["no link", { links: [] }, "PR_UNLINKED"],
  [
    "non-PR link",
    {
      links: [
        {
          relation: "delivers",
          url: "https://github.com/example/repo/issues/1",
        },
      ],
    },
    "PR_UNLINKED",
  ],
  [
    "unrelated relation",
    { links: [{ relation: "references", url: pr }] },
    "PR_UNLINKED",
  ],
  [
    "open PR",
    { pr: { ...merged, state: "OPEN", mergeCommit: null } },
    "PR_NOT_MERGED",
  ],
  [
    "closed unmerged PR",
    { pr: { ...merged, state: "CLOSED", mergeCommit: null } },
    "PR_NOT_MERGED",
  ],
  [
    "newest open link",
    {
      links: [
        { relation: "delivers", url: pr },
        { relation: "delivers", url: `${pr}2` },
      ],
      pr: { ...merged, state: "OPEN", mergeCommit: null },
    },
    "PR_NOT_MERGED",
  ],
  ["missing gh", { process: "missing" }, "UNAVAILABLE"],
  ["unbound process", { process: "unbound" }, "UNAVAILABLE"],
  ["failed gh", { result: { exitCode: 1 } }, "UNAVAILABLE"],
  ["timed out gh", { result: { timedOut: true } }, "UNAVAILABLE"],
  ["thrown gh", { process: "throw" }, "UNAVAILABLE"],
  ["bad JSON", { result: { stdout: "{" } }, "UNAVAILABLE"],
  ["bad PR output", { pr: {} }, "UNAVAILABLE"],
  [
    "wrong field types",
    { pr: { ...merged, state: ["MERGED"] } },
    "UNAVAILABLE",
  ],
  ["empty head", { pr: { ...merged, headRefOid: "" } }, "UNAVAILABLE"],
  [
    "empty merge commit",
    { pr: { ...merged, mergeCommit: { oid: "" } } },
    "UNAVAILABLE",
  ],
  [
    "missing merge commit",
    { pr: { ...merged, mergeCommit: null } },
    "UNAVAILABLE",
  ],
  ["unbound environment", { environment: "unbound" }, "UNAVAILABLE"],
  ["truncated gh", { result: { truncated: true } }, "UNAVAILABLE"],
];
for (const [name, options, code, subject = head] of refusals) {
  test(`close refuses ${name} before any write`, async () => {
    const harness = project(
      {
        id: "receipt",
        status: "PASS",
        ...(name === "missing subject" ? {} : { subject }),
      },
      options,
    );
    const before = harness.stored();
    await expect(harness.call({ receipt: "receipt" })).rejects.toThrow(code);
    expect(harness.stored()).toEqual(before);
    if (code === "PR_UNLINKED") expect(harness.calls).toHaveLength(0);
    if (name === "newest open link")
      expect(harness.calls[1]).toMatchObject({
        args: [
          "pr",
          "view",
          `${pr}2`,
          "--json",
          "state,headRefOid,mergeCommit",
        ],
      });
  });
}

test("an exemption cannot hide a mismatched supplied receipt", async () => {
  const harness = project({
    id: "receipt",
    status: "PASS",
    subject: "c".repeat(40),
  });
  const before = harness.stored();
  await expect(
    harness.call({ receipt: "receipt", withoutReceipt: "Superseded" }),
  ).rejects.toThrow("RECEIPT_HEAD_MISMATCH");
  expect(harness.stored()).toEqual(before);
});

test("an exemption needs neither a delivery link nor a process slot", async () => {
  const harness = project(undefined, {
    links: [],
    process: "unbound",
    environment: "unbound",
  });
  expect(await harness.call({ withoutReceipt: "Superseded" })).toMatchObject({
    status: "closed",
  });
  expect(harness.calls).toHaveLength(0);
});

test("newest delivers link follows numeric append order beyond nine", async () => {
  const links = Array.from({ length: 12 }, (_, i) => ({
    relation: "delivers",
    url: `https://github.com/example/repo/pull/${i + 1}`,
  }));
  const harness = project(
    { id: "receipt", status: "PASS", subject: head },
    { links },
  );
  expect(await harness.call({ receipt: "receipt" })).toMatchObject({
    status: "closed",
  });
  expect(harness.calls[1]).toMatchObject({
    args: [
      "pr",
      "view",
      links[11]!.url,
      "--json",
      "state,headRefOid,mergeCommit",
    ],
  });
});

function stateOnlyRuntime() {
  const root = resolve(import.meta.dirname, "../../../src/blocks/work");
  const block = captureBlock("work", {
    open: () => ({
      ownership: "borrowed",
      value: {
        read(name) {
          if (name === "entry.cjs")
            return new TextEncoder().encode(
              new Bun.Transpiler({ loader: "ts" }).transformSync(
                readFileSync(resolve(root, "entry.cts"), "utf8"),
              ),
            );
          return readFileSync(
            resolve(root, name === "block.json" ? "forge.block.json" : name),
          );
        },
      },
    }),
  });
  const catalog = new Catalog(
    {
      schemaVersion: "forge.config/1",
      blocks: { work: { source: { path: "./work" }, bind: { state: "core" } } },
    },
    new Map([["work", block]]),
    undefined,
    ["forge.state@1.0.0"],
  );
  expect(catalog.list()).toContain("issue.close");
  expect(catalog.bindings("work").map((binding) => binding.slot)).toEqual([
    "state",
  ]);
  const harness = project();
  const trust = new TrustStore();
  trust.admit("human", block.digest);
  trust.grant("human", block.digest, [
    "issue:write",
    "external:process",
    "external:network",
    "environment:read",
  ]);
  const runtime = new Runtime(catalog, trust, {
    isolation: nodeRunIsolation,
    services: () =>
      Promise.resolve({
        ownership: "borrowed",
        value: { state: harness.state },
      }),
  });
  return {
    harness,
    close: (input: Record<string, unknown>) =>
      runtime.invoke({
        schemaVersion: "forge.invocation/1",
        requestId: "state-only-close",
        op: "issue.close",
        caller: "agent",
        input: { id: "work-1", ...input },
        context: {
          actor: { kind: "agent", id: "test" },
          session: { id: "test" },
          project: { id: "test", root: "/test" },
          leaseGeneration: 1,
        },
      }),
  };
}

for (const input of [{}, { reason: "merged" }]) {
  test(`state-only work composes and refuses missing evidence ${JSON.stringify(input)}`, async () => {
    const { harness, close } = stateOnlyRuntime();
    const before = harness.stored();
    expect(await close(input)).toMatchObject({
      ok: false,
      error: { code: "RECEIPT_REQUIRED" },
    });
    expect(harness.stored()).toEqual(before);
  });
}

for (const input of [
  { receipt: "receipt" },
  { receipt: "receipt", withoutReceipt: "Superseded" },
]) {
  test(`state-only work refuses unverifiable supplied receipt ${JSON.stringify(input)}`, async () => {
    const { harness, close } = stateOnlyRuntime();
    const before = harness.stored();
    expect(await close(input)).toMatchObject({
      ok: false,
      error: {
        code: "RECEIPTS_UNAVAILABLE",
        message:
          "Cannot verify receipt: the receipts slot is unbound; bind forge.receipts@1 or omit receipt and supply withoutReceipt",
      },
    });
    expect(harness.stored()).toEqual(before);
  });
}

test("state-only work closes with a stored explicit exemption", async () => {
  const { harness, close } = stateOnlyRuntime();
  expect(await close({ withoutReceipt: "Superseded" })).toMatchObject({
    ok: true,
    result: { status: "closed", withoutReceipt: "Superseded" },
  });
  expect(harness.read()).toMatchObject({
    status: "closed",
    withoutReceipt: "Superseded",
  });
  expect(harness.read().receipt).toBeUndefined();
});
