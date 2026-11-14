import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createCloudHttp,
  type CloudFetch,
} from "../../../src/adapters/http/index.ts";
import { ForgeFailure } from "../../../src/contract/failure.ts";
import type {
  StateCommitRequest,
  StateReadRequest,
  StateQuery,
} from "../../../src/ports/state-protocol.ts";
import { exitCode, failure } from "../../../src/surface/result.ts";

setDefaultTimeout(10_000);

const token = "fct_" + "a".repeat(16) + "." + "b".repeat(43);
const actor = { kind: "human", id: "harsha" } as const;
const version = { epoch: "epoch", revision: 10 };
const common = {
  version: 1,
  namespace: "forge/memory",
  operation: "record.read",
  policyRevision: "policy",
  context: { actor },
} as const;
const record = {
  namespace: common.namespace,
  key: "a",
  revision: 2,
  value: { note: "hello" },
  updatedAt: "2026-11-15T00:00:00.000Z",
  updatedBy: actor,
};
const event = {
  type: "forge/state:record.updated@1",
  namespace: common.namespace,
  key: "a",
  revision: 2,
  at: record.updatedAt,
  actor,
};
const read = (
  query: StateQuery = { kind: "get", key: "a" },
): StateReadRequest => ({
  ...common,
  kind: "read",
  readVersion: version,
  query,
});
const commit: StateCommitRequest = {
  ...common,
  kind: "commit",
  requestId: "commit-1",
  input: null,
  readVersion: version,
  readSet: [],
  entries: [{ key: "a", value: record.value, expectRevision: 1 }],
};
const resultFor = (
  request: StateReadRequest | StateCommitRequest,
  result: unknown,
) => ({
  version: 1,
  project: "proj",
  namespace: common.namespace,
  policyRevision: "policy",
  readVersion:
    request.kind === "commit" ? { ...version, revision: 11 } : version,
  ...(request.kind === "commit"
    ? { requestId: request.requestId, records: [record] }
    : {}),
  result,
});
const envelope = (result: unknown) => ({
  ok: true,
  status: "OK",
  result,
  warnings: [],
});
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
function fixture(
  reply: (init: Parameters<CloudFetch>[1]) => Response | Promise<Response>,
  timeoutMs = 50,
  create = createCloudHttp,
) {
  const calls: { url: string; init: Parameters<CloudFetch>[1] }[] = [];
  const http = create({
    origin: "https://forge.example.test",
    project: "proj",
    timeoutMs,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return reply(init);
    },
  });
  const send = (
    request: StateReadRequest | StateCommitRequest,
    signal?: AbortSignal,
  ) =>
    request.kind === "read"
      ? http.stateRead(token, request, signal)
      : http.stateCommit(token, request, signal);
  return { calls, send };
}
async function refused(run: () => Promise<unknown>, code = "UNAVAILABLE") {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ForgeFailure);
  const error = (caught as ForgeFailure).error;
  expect(error.code).toBe(code);
  expect(JSON.stringify(error)).not.toContain(token);
  const projected = failure(error.code, error.message);
  expect([projected.status, exitCode(projected)]).toEqual(["FAIL", 1]);
}

const ceiling = 1_048_576;
function responseBytes(bytes: number) {
  const body = (value: string) =>
    envelope(resultFor(read(), { kind: "get", record: { ...record, value } }));
  const overhead = Buffer.byteLength(JSON.stringify(body("")));
  const text = JSON.stringify(body("x".repeat(bytes - overhead)));
  expect(Buffer.byteLength(text)).toBe(bytes);
  return text;
}
async function byteBoundary(create = createCloudHttp) {
  for (const delta of [-1, 0, 1]) {
    const text = responseBytes(ceiling + delta);
    const f = fixture(() => new Response(text), 1_000, create);
    if (delta > 0) await refused(() => f.send(read()));
    else {
      expect<unknown>(await f.send(read())).toEqual({
        kind: "ok",
        result: JSON.parse(text).result,
      });
    }
    expect(f.calls).toHaveLength(1);
  }
}
test("state byte boundary accepts valid responses through the ceiling only", async () => {
  await byteBoundary();
});
test("state byte boundary counterfactual fails with a raised ceiling", async () => {
  const original = new URL(
    "../../../src/adapters/http/index.ts",
    import.meta.url,
  );
  const source = await readFile(original, "utf8");
  const target = "Math.min(commandMax, 1_048_576)";
  expect(source.split(target)).toHaveLength(2);
  // Load a disposable module: production files stay untouched; only its effective cap changes.
  const mutant = source
    .replace(target, "2_097_152")
    .replace(
      /from "(\.[^"]+)"/g,
      (_, path: string) => `from "${new URL(path, original).href}"`,
    );
  const dir = await mkdtemp(join(tmpdir(), "forge-state-byte-ceiling-"));
  try {
    const file = join(dir, "http-mutant.ts");
    await writeFile(file, mutant);
    const loaded = (await import(
      pathToFileURL(file).href
    )) as typeof import("../../../src/adapters/http/index.ts");
    const f = fixture(
      () => new Response(responseBytes(ceiling + 1)),
      1_000,
      loaded.createCloudHttp,
    );
    const accepted = await f.send(read());
    expect(accepted.kind).toBe("ok");
    await expect(refused(() => Promise.resolve(accepted))).rejects.toThrow();
    expect(f.calls).toHaveLength(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const valid: [string, StateReadRequest | StateCommitRequest, unknown][] = [
  ["get", read(), { kind: "get", record }],
  [
    "large value",
    read(),
    { kind: "get", record: { ...record, value: "x".repeat(70_000) } },
  ],
  ["absent", read(), { kind: "get", record: null }],
  [
    "range",
    read({ kind: "range", from: "a", to: "z", limit: 1 }),
    { kind: "range", records: [record], next: "a\0" },
  ],
  [
    "descending",
    read({ kind: "range", limit: 1, descending: true }),
    { kind: "range", records: [record], next: "a" },
  ],
  ["count", read({ kind: "count", prefix: "" }), { kind: "count", value: 1 }],
  ["max", read({ kind: "max", prefix: "" }), { kind: "max", value: 42 }],
  [
    "history",
    read({ kind: "history", key: "a", limit: 1, before: 9 }),
    { kind: "history", events: [event], next: 8 },
  ],
  ["commit", commit, null],
];
for (const [name, request, inner] of valid)
  test(`state valid matrix: ${name}`, async () => {
    const result = resultFor(request, inner);
    const f = fixture(() => json(envelope(result)));
    const before = JSON.stringify(request);
    expect<unknown>(await f.send(request)).toEqual({ kind: "ok", result });
    expect(JSON.stringify(request)).toBe(before);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe(
      `https://forge.example.test/p/proj/state/${request.kind}`,
    );
    expect(f.calls[0]!.init).toMatchObject({
      method: "POST",
      redirect: "manual",
      headers: { authorization: `Bearer ${token}` },
      body: before,
    });
  });
test("state discover returns the pinned policy and version", async () => {
  const { readVersion: _, ...request } = read();
  const f = fixture(() =>
    json(envelope(resultFor(read(), { kind: "get", record }))),
  );
  expect((await f.send({ ...request, policyRevision: "discover" })).kind).toBe(
    "ok",
  );
});

const refusals: [string, number, number][] = [
  ...["AUTH_REQUIRED", "AUTH_INVALID", "AUTH_REVOKED", "AUTH_EXPIRED"].map(
    (code): [string, number, number] => [code, 401, 1],
  ),
  ["AUTH_FORBIDDEN", 403, 1],
  ["AUTH_DEVICE_MISMATCH", 403, 1],
  ["INPUT_INVALID", 400, 6],
  ["CONTEXT_MISSING", 400, 6],
  ["UNKNOWN_COMMAND", 404, 3],
  ...[
    "INPUT_CONFLICT",
    "REVISION_CONFLICT",
    "LEASE_HELD",
    "LEASE_STALE",
    "LEASE_EXPIRED",
    "LEASE_NOT_HELD",
  ].map((code): [string, number, number] => [code, 409, 4]),
  ["INTERNAL", 500, 1],
  ["UNAVAILABLE", 503, 1],
];
for (const [code, status, exit] of refusals)
  test(`state refusal matrix: ${code}`, async () => {
    const lease = code.startsWith("LEASE_")
      ? { subject: "subject" }
      : undefined;
    const request = { ...commit, fence: { subject: "subject", generation: 1 } };
    const body = {
      ok: false,
      status: "FAIL",
      error: {
        code,
        message: "server words",
        retry: "never",
        ...(code === "CONTEXT_MISSING" ? { missing: ["actor"] } : {}),
        ...(lease ? { lease } : {}),
      },
      warnings: [],
    };
    const f = fixture(() => json(body, status));
    expect(await f.send(request)).toEqual({
      kind: "refused",
      code,
      ...(lease ? { lease } : {}),
    });
    expect(exitCode(failure(code, "refused"))).toBe(exit);
    await refused(() =>
      fixture(() => json(body, status === 400 ? 401 : 400)).send(request),
    );
  });

type Mutation = (value: ReturnType<typeof resultFor>) => unknown;
const forged: [string, Mutation][] = [
  ["project", (v) => ({ ...v, project: "other" })],
  ["namespace", (v) => ({ ...v, namespace: "other/state" })],
  ["wire version", (v) => ({ ...v, version: 2 })],
  ["policy", (v) => ({ ...v, policyRevision: "other" })],
  ["epoch", (v) => ({ ...v, readVersion: { ...version, epoch: "other" } })],
  [
    "read revision",
    (v) => ({ ...v, readVersion: { ...version, revision: 9 } }),
  ],
  [
    "extra version field",
    (v) => ({ ...v, readVersion: { ...version, extra: 1 } }),
  ],
  ["kind", (v) => ({ ...v, result: { kind: "max", value: 0 } })],
  ...["namespace", "key", "revision", "updatedBy", "value"].map(
    (field): [string, Mutation] => [
      `record ${field}`,
      (v) => ({
        ...v,
        result: {
          kind: "get",
          record: Object.fromEntries(
            Object.entries(record).filter(([key]) => key !== field),
          ),
        },
      }),
    ],
  ),
  [
    "record namespace",
    (v) => ({
      ...v,
      result: { kind: "get", record: { ...record, namespace: "other/state" } },
    }),
  ],
  [
    "record key",
    (v) => ({ ...v, result: { kind: "get", record: { ...record, key: "b" } } }),
  ],
  ...[0, 1.5, Number.MAX_SAFE_INTEGER + 1, 11].map(
    (revision): [string, Mutation] => [
      `record revision ${revision}`,
      (v) => ({
        ...v,
        result: { kind: "get", record: { ...record, revision } },
      }),
    ],
  ),
  [
    "token echo",
    (v) => ({
      ...v,
      result: { kind: "get", record: { ...record, value: token } },
    }),
  ],
];
for (const [name, mutate] of forged)
  test(`state forged success: ${name}`, async () => {
    const f = fixture(() =>
      json(envelope(mutate(resultFor(read(), { kind: "get", record })))),
    );
    await refused(() => f.send(read()));
    expect(f.calls).toHaveLength(1);
  });
for (const [name, patch] of [
  ["id", { requestId: "other" }],
  ["count", { records: [] }],
  ["key", { records: [{ ...record, key: "b" }] }],
  ["revision", { records: [{ ...record, revision: 3 }] }],
  ["value", { records: [{ ...record, value: "other" }] }],
  ["result", { result: {} }],
  ["watermark", { readVersion: version }],
] as const)
  test(`state forged commit: ${name}`, async () => {
    await refused(() =>
      fixture(() =>
        json(envelope({ ...resultFor(commit, null), ...patch })),
      ).send(commit),
    );
  });
for (const [name, request, inner] of [
  [
    "range order",
    read({ kind: "range", limit: 3 }),
    { kind: "range", records: [{ ...record, key: "b" }, record], next: null },
  ],
  [
    "range bound",
    read({ kind: "range", from: "b", limit: 2 }),
    { kind: "range", records: [record], next: null },
  ],
  [
    "range cursor",
    read({ kind: "range", limit: 1 }),
    { kind: "range", records: [record], next: "b\0" },
  ],
  [
    "range limit",
    read({ kind: "range", limit: 1 }),
    { kind: "range", records: [record, { ...record, key: "b" }], next: null },
  ],
  [
    "history key",
    read({ kind: "history", key: "a", limit: 2 }),
    { kind: "history", events: [{ ...event, key: "b" }], next: null },
  ],
  [
    "history cursor",
    read({ kind: "history", key: "a", limit: 1, before: 9 }),
    { kind: "history", events: [event], next: 9 },
  ],
  [
    "negative aggregate",
    read({ kind: "count", prefix: "" }),
    { kind: "count", value: -1 },
  ],
  [
    "aggregate kind",
    read({ kind: "count", prefix: "" }),
    { kind: "max", value: 1 },
  ],
] satisfies [string, StateReadRequest, unknown][])
  test(`state contradictory query: ${name}`, async () => {
    await refused(() =>
      fixture(() => json(envelope(resultFor(request, inner)))).send(request),
    );
  });

for (const mode of [
  "redirect",
  "unknown status",
  "unknown refusal",
  "both",
  "warnings",
  "token key",
  "oversize",
  "depth",
  "nodes",
  "utf8",
  "header stall",
  "body stall",
  "abort",
  "pre-abort",
  "transport token",
] as const)
  test(`state unsafe/deadline table: ${mode}`, async () => {
    const good = envelope(resultFor(read(), { kind: "get", record }));
    const controller = new AbortController();
    const f = fixture((init) => {
      if (mode === "redirect")
        return init.redirect === "manual"
          ? new Response(null, {
              status: 307,
              headers: { location: "https://other.example" },
            })
          : json(good);
      if (mode === "unknown status") return json(good, 201);
      if (mode === "unknown refusal")
        return json(
          {
            ok: false,
            status: "FAIL",
            error: { code: "NEW_CODE", message: "bad", retry: "never" },
            warnings: [],
          },
          503,
        );
      if (mode === "both")
        return json({ ...good, error: { code: "UNAVAILABLE" } });
      if (mode === "warnings") return json({ ...good, warnings: ["unsafe"] });
      if (mode === "token key") return json({ ...good, [token]: true });
      if (mode === "oversize") return new Response(responseBytes(ceiling + 1));
      if (mode === "depth" || mode === "nodes") {
        const value: unknown =
          mode === "nodes"
            ? Array(100_001).fill(0)
            : JSON.parse("[".repeat(70) + "0" + "]".repeat(70));
        return json(
          envelope(
            resultFor(read(), { kind: "get", record: { ...record, value } }),
          ),
        );
      }
      if (mode === "utf8") return new Response(new Uint8Array([0xff]));
      if (mode === "header stall") return new Promise<Response>(() => {});
      if (mode === "body stall" || mode === "abort") {
        if (mode === "abort") setTimeout(() => controller.abort(), 5);
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode("{"));
            },
          }),
        );
      }
      throw new ForgeFailure({
        code: "INTERNAL",
        message: token,
        retry: "never",
      });
    });
    if (mode === "pre-abort") controller.abort();
    await refused(
      () => f.send(read(), controller.signal),
      mode === "abort" || mode === "pre-abort"
        ? "INVOCATION_CANCELLED"
        : "UNAVAILABLE",
    );
    expect(f.calls).toHaveLength(mode === "pre-abort" ? 0 : 1);
  });
