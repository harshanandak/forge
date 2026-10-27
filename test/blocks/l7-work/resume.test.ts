import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  SchemaRegistry,
  type SchemaObject,
} from "../../../src/contract/schema.ts";

setDefaultTimeout(30_000);
type Record = {
  key: string;
  revision: number;
  updatedAt: string;
  value: { [key: string]: unknown };
};
type Checkpoint = {
  step: string;
  branch: string;
  worktree: string;
  next: string;
  head?: string;
  pr?: string;
  receipt?: string;
  time: string;
  commentId: string;
};
type Result = {
  id: string;
  commentId: string;
  checkpoint?: Checkpoint;
  items: {
    id: string;
    title: string;
    step: string;
    time: string;
    claim?: { status: string; holder: { id: string }; expiresAt: string };
  }[];
  body?: string;
  claim?: unknown;
  delivers: Record[];
  calls: { id: string; used: number; left: number; stopBy: string };
  comments: Record[];
  more: boolean;
};
type Handler = (call: {
  input: { [key: string]: unknown };
  services: unknown;
  config?: unknown;
}) => Result;
let operations: { [key: string]: Handler };
const globals = globalThis as { [key: string]: unknown };
const previousFail = globals.fail;
beforeAll(() => {
  globals.fail = (code: string, message: string) => {
    throw new Error(`${code}: ${message}`);
  };
  operations = require(
    resolve(import.meta.dirname, "../../../src/blocks/work/entry.cts"),
  ) as typeof operations;
});
afterAll(() => {
  if (previousFail === undefined) delete globals.fail;
  else globals.fail = previousFail;
});

const start = Date.parse("2026-01-01T00:00:00.000Z");
function project(stampDelay = 0) {
  let now = start;
  const records = new Map<string, Record>();
  const leases = new Map<
    string,
    {
      subject: string;
      generation: number;
      holder: { actor: { kind: string; id: string }; session: { id: string } };
      expiresAt: string;
      releasedAt?: string;
    }
  >();
  const state = {
    now: () => now,
    get: (key: string) => records.get(key),
    list: (prefix: string) =>
      [...records.values()].filter((r) => r.key.startsWith(prefix)).reverse(),
    lease: (key: string) => leases.get(key),
    acquire: () => undefined,
    put: (
      key: string,
      value: Record["value"],
      options: { expectRevision: number },
    ) => {
      if ((records.get(key)?.revision ?? 0) !== options.expectRevision)
        throw new Error("REVISION_CONFLICT");
      const record = {
        key,
        value,
        revision: options.expectRevision + 1,
        updatedAt: new Date(now + stampDelay).toISOString(),
      };
      records.set(key, record);
      return record;
    },
  };
  const run = (
    op: string,
    input: { [key: string]: unknown } = {},
    config?: unknown,
  ) => operations[`issue.${op}`]!({ input, services: { state }, config });
  const issue = (n: number, extra: Record["value"] = {}) => {
    const id = `work-${n}`;
    state.put(
      `issue:${id}`,
      { id, title: `Slice ${n}`, status: "open", dependsOn: [], ...extra },
      { expectRevision: 0 },
    );
    return id;
  };
  issue(1, { body: "Original scope" });
  const checkpoint = (
    id = "work-1",
    extra: { [key: string]: unknown } = {},
  ): Pick<Result, "id" | "commentId"> =>
    run("checkpoint", {
      id,
      step: "red",
      branch: "slice",
      worktree: "/tmp/slice",
      next: "make the assertion pass",
      ...extra,
    });
  return {
    records,
    leases,
    run,
    issue,
    checkpoint,
    at: (hours: number) => {
      now = start + hours * 3600_000;
    },
  };
}

test("checkpoint and resume are exported", () => {
  expect(typeof operations["issue.checkpoint"]).toBe("function");
  expect(typeof operations["issue.resume"]).toBe("function");
});
test("checkpoint next uses the schema's Unicode character limit", () => {
  const p = project();
  expect(() =>
    p.checkpoint("work-1", { next: "\u{1f642}".repeat(300) }),
  ).not.toThrow();
  expect(() =>
    p.checkpoint("work-1", { next: "\u{1f642}".repeat(301) }),
  ).toThrow(/INPUT_INVALID/);
});
test("checkpoint appends structured data with its accepted timestamp and refuses empty next", () => {
  const p = project(1000);
  expect(() => p.checkpoint("work-1", { next: "" })).toThrow(
    /INPUT_INVALID.*next/,
  );
  expect(p.records.size).toBe(1);
  const saved = p.checkpoint("work-1", {
    head: "a".repeat(40),
    pr: "https://example.com/pull/1",
    receipt: "receipt-1",
  });
  expect(saved).toEqual({ id: "work-1", commentId: "comment:work-1:1" });
  const record = p.records.get(saved.commentId)!;
  expect(record.value.checkpoint).toEqual({
    step: "red",
    branch: "slice",
    worktree: "/tmp/slice",
    next: "make the assertion pass",
    head: "a".repeat(40),
    pr: "https://example.com/pull/1",
    receipt: "receipt-1",
  });
  expect(record.value.body).toContain("checkpoint red");
  expect(p.run("resume", { id: "work-1" }).checkpoint).toMatchObject({
    time: "2026-01-01T00:00:01.000Z",
    commentId: saved.commentId,
  });
});
test("discovery keeps only open checkpointed slices with the newest append not merged, sorted and capped at ten", () => {
  const p = project();
  p.checkpoint("work-1", { step: "merged" });
  p.issue(2, { status: "closed" });
  p.checkpoint("work-2");
  p.issue(3);
  for (let n = 4; n <= 15; n++) {
    p.issue(n);
    p.at(n);
    p.checkpoint(`work-${n}`);
  }
  p.at(1);
  p.checkpoint("work-4", { step: "merged" });
  const before = structuredClone([...p.records.values()]);
  const result = p.run("resume");
  expect(result.items.map((row) => row.id)).toEqual(
    Array.from({ length: 10 }, (_, n) => `work-${15 - n}`),
  );
  expect(result.items[0]).toEqual({
    id: "work-15",
    title: "Slice 15",
    step: "red",
    time: "2026-01-01T15:00:00.000Z",
  });
  expect([...p.records.values()]).toEqual(before);
});
test("latest checkpoint follows numeric append order and equal discovery times have deterministic order", () => {
  const p = project();
  p.issue(2);
  for (let n = 0; n < 10; n++)
    p.checkpoint("work-1", { step: n === 9 ? "green" : "red" });
  p.checkpoint("work-2");
  expect(p.run("resume", { id: "work-1" }).checkpoint?.step).toBe("green");
  expect(p.run("resume").items.map((row) => row.id)).toEqual([
    "work-1",
    "work-2",
  ]);
});
test("discovery shows live and stale holder sessions, omits released claims, and detail only shows live claims", () => {
  const p = project();
  for (let n = 1; n <= 3; n++) {
    if (n > 1) p.issue(n);
    p.checkpoint(`work-${n}`);
    p.leases.set(`issue:work-${n}`, {
      subject: `issue:work-${n}`,
      generation: 1,
      holder: {
        actor: { kind: "human", id: "owner" },
        session: { id: `slice-${n}-worker` },
      },
      expiresAt: new Date(start + (n === 2 ? 0 : 3600_000)).toISOString(),
      ...(n === 3 ? { releasedAt: new Date(start).toISOString() } : {}),
    });
  }
  const rows = p.run("resume").items;
  expect(rows[0]?.claim).toEqual({
    status: "live",
    holder: { id: "slice-1-worker" },
    expiresAt: "2026-01-01T01:00:00.000Z",
  });
  expect(rows[1]?.claim?.status).toBe("stale");
  expect(rows[2]?.claim).toBeUndefined();
  expect(p.run("resume", { id: "work-1" }).claim).toEqual(
    p.leases.get("issue:work-1"),
  );
  expect(p.run("resume", { id: "work-2" }).claim).toBeUndefined();
  expect(p.run("resume", { id: "work-3" }).claim).toBeUndefined();
});
test("detail returns scope, delivers and the newest twenty later comments in append order with more, without writing", () => {
  const p = project();
  p.run("comment", { id: "work-1", body: "before" });
  const saved = p.checkpoint();
  for (let n = 1; n <= 21; n++)
    p.run("comment", { id: "work-1", body: `direction ${n}` });
  p.records.set("link:work-1:1", {
    key: "link:work-1:1",
    revision: 1,
    updatedAt: new Date(start).toISOString(),
    value: {
      id: "work-1",
      relation: "delivers",
      url: "https://example.com/pull/1",
    },
  });
  p.records.set("link:work-1:2", {
    key: "link:work-1:2",
    revision: 1,
    updatedAt: new Date(start).toISOString(),
    value: {
      id: "work-1",
      relation: "relates",
      url: "https://example.com/other",
    },
  });
  const before = structuredClone([...p.records.values()]);
  const result = p.run("resume", { id: "work-1" });
  expect(result).toMatchObject({
    id: "work-1",
    title: "Slice 1",
    body: "Original scope",
    more: true,
  });
  expect(result.checkpoint?.commentId).toBe(saved.commentId);
  expect(result.delivers).toEqual([p.records.get("link:work-1:1")!]);
  expect(result.comments).toHaveLength(20);
  expect(result.comments.map((row) => row.value.body)).toEqual(
    Array.from({ length: 20 }, (_, n) => `direction ${n + 2}`),
  );
  expect([...p.records.values()]).toEqual(before);
});
test("without a checkpoint all comments are returned, and exactly twenty does not set more", () => {
  const p = project();
  for (let n = 0; n < 20; n++)
    p.run("comment", { id: "work-1", body: `note ${n}` });
  const result = p.run("resume", { id: "work-1" });
  expect(result.checkpoint).toBeUndefined();
  expect(result.comments).toHaveLength(20);
  expect(result.more).toBe(false);
});
test("without a checkpoint overflow preserves the latest owner direction in append order", () => {
  const p = project();
  for (let n = 1; n <= 21; n++)
    p.run("comment", { id: "work-1", body: `owner direction ${n}` });
  const before = structuredClone([...p.records.values()]);
  const result = p.run("resume", { id: "work-1" });
  expect(result.checkpoint).toBeUndefined();
  expect(result.comments.map((row) => row.value.body)).toEqual(
    Array.from({ length: 20 }, (_, n) => `owner direction ${n + 2}`),
  );
  expect(result.more).toBe(true);
  expect([...p.records.values()]).toEqual(before);
});
test("detail shares root-intent calls and original accepted deadline, including expired and unused budgets", () => {
  const p = project(1000);
  p.issue(2, { parent: "work-1" });
  p.issue(3, { parent: "work-2" });
  expect(p.run("resume", { id: "work-3" }).calls).toEqual({
    id: "work-1",
    used: 0,
    left: 60,
    stopBy: "2026-01-02T06:00:00.000Z",
  });
  p.run("call", { id: "work-3", role: "build" });
  p.at(1);
  p.run("call", { id: "work-2", role: "review" });
  p.at(31);
  const before = structuredClone([...p.records.values()]);
  expect(p.run("resume", { id: "work-3" }).calls).toEqual({
    id: "work-1",
    used: 2,
    left: 58,
    stopBy: "2026-01-02T06:00:01.000Z",
  });
  expect([...p.records.values()]).toEqual(before);
});
test("checkpoint and resume resolve historical prefixes and display the configured prefix", () => {
  const p = project();
  p.records.get("issue:work-1")!.value.prefix = "old";
  const config = { idPrefix: "new" };
  p.run(
    "checkpoint",
    { id: "old-1", step: "red", branch: "b", worktree: ".", next: "continue" },
    config,
  );
  expect(p.run("resume", {}, config).items[0]?.id).toBe("new-1");
  expect(p.run("resume", { id: "old-1" }, config)).toMatchObject({
    id: "new-1",
    calls: { id: "new-1" },
  });
});
test("checkpoint schema enforces required next, enums, hash, URL, bounds and extra properties", () => {
  const read = (path: string) =>
    JSON.parse(readFileSync(path, "utf8")) as SchemaObject;
  const contracts = resolve(import.meta.dirname, "../../../schemas");
  const schema = {
    ...read(
      resolve(
        import.meta.dirname,
        "../../../src/blocks/work/schemas/checkpoint.input.json",
      ),
    ),
    $id: "urn:forge:test:checkpoint",
  };
  const registry = new SchemaRegistry([
    ...readdirSync(contracts)
      .filter((name) => name.endsWith(".json"))
      .map((name) => read(resolve(contracts, name))),
    schema,
  ]);
  const valid = {
    id: "work-1",
    step: "red",
    branch: "b",
    worktree: ".",
    next: "continue",
  };
  expect(registry.validate("urn:forge:test:checkpoint", valid)).toEqual([]);
  for (const pr of [
    "https://example.com:8443/pull/1",
    "http://localhost:8080/pull/1",
    "http://127.0.0.1:8080/pull/1",
    "http://[::1]:8080/pull/1",
  ])
    expect(
      registry.validate("urn:forge:test:checkpoint", { ...valid, pr }),
    ).toEqual([]);
  for (const change of [
    { branch: "" },
    { worktree: "" },
    { next: "" },
    { next: "x".repeat(301) },
    { step: "unknown" },
    { head: "x".repeat(40) },
    { pr: "not-a-url" },
    { pr: "https://example.com:abc/pull/1" },
    { pr: "https:///pull/1" },
    { pr: "https://:443/pull/1" },
    { pr: "https://bad..host/pull/1" },
    { pr: "https://256.0.0.1/pull/1" },
    { pr: "https://example.com:65536/pull/1" },
    { pr: "ftp://example.com/pull/1" },
    { extra: true },
  ])
    expect(
      registry.validate("urn:forge:test:checkpoint", { ...valid, ...change }),
    ).not.toEqual([]);
  const { next: _next, ...missing } = valid;
  expect(registry.validate("urn:forge:test:checkpoint", missing)).not.toEqual(
    [],
  );
});
