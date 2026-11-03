import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, test, setDefaultTimeout } from "bun:test";
import { ForgeFailure } from "../../../src/contract/failure.ts";
import { DEFAULT_PARSE_LIMITS } from "../../../src/contract/untrusted.ts";
import { InvocationServices } from "../../../src/core/runtime/services.ts";
import type { ProcessPort, ProcessResult } from "../../../src/ports/process.ts";
import type {
  RunIsolation,
  RuntimeOptions,
} from "../../../src/core/runtime/index.ts";
import { fixture } from "./fixture.ts";

setDefaultTimeout(5000);

const spawn = { cwd: "/", env: {}, timeoutMs: 100, maxOutputBytes: 100 };
const executable = { kind: "resolved", path: "fake" } as const;
function result(): ProcessResult {
  return {
    exitCode: null,
    signal: "SIGTERM",
    stdout: "partial output",
    stderr: "error",
    timedOut: true,
    truncated: false,
    durationMs: 20,
    outputEvidence: {
      stdout: {
        head: "aGVsbG8=",
        tail: "",
        encoding: "base64",
        totalBytes: 5,
        digest: "sha256:abc",
        complete: false,
      },
      stderr: {
        head: "",
        tail: "",
        encoding: "base64",
        totalBytes: 0,
        digest: "sha256:def",
        complete: true,
      },
    },
  };
}
function port(run: ProcessPort["run"]): ProcessPort {
  return { capability: "forge.process/v1", resolve: () => executable, run };
}
function capture(value: ProcessResult) {
  const scope = new InvocationServices(100, () => {}, false, { now: () => 0 });
  const client = scope.wrap(port(() => Promise.resolve(value))) as ProcessPort;
  return { scope, run: () => client.run(executable, [], spawn) };
}

test("snapshots detach from provider and handler mutation and omit provider extras", async () => {
  const value = { ...result(), argv: ["private"], env: { PRIVATE: "private" } };
  const f = capture(value);
  const returned = await f.run();
  expect(returned).toBe(value); // Successful process calls keep their original semantics.
  value.stdout = "changed";
  Object.assign(value.outputEvidence!.stdout, { digest: "changed" });
  const observed = f.scope.diagnostics();
  expect(observed).toMatchObject({
    results: [
      {
        stdout: "partial output",
        outputEvidence: { stdout: { digest: "sha256:abc", complete: false } },
      },
    ],
  });
  expect(JSON.stringify(observed)).not.toContain("private");
  Object.assign(observed!.results[0]!, { stdout: "changed again" });
  expect(f.scope.diagnostics()).toMatchObject({
    results: [{ stdout: "partial output" }],
  });
});

test("oversized Unicode and escaped previews have fixed prefixes and explicit truncation", async () => {
  const value = {
    ...result(),
    stdout: "\u0000".repeat(100_000),
    stderr: "😀".repeat(100_000),
  };
  Object.assign(value.outputEvidence!.stdout, {
    head: "YQ==".repeat(100_000),
    digest: "x".repeat(100_000),
  });
  Object.defineProperty(value, "extra", {
    get: () => {
      throw Error("must not inspect extras");
    },
  });
  const f = capture(value);
  await f.run();
  const observed = f.scope.diagnostics();
  expect(observed).toMatchObject({
    results: [
      {
        stdout: "\u0000".repeat(512),
        stderr: "😀".repeat(256),
        captureTruncated: true,
        outputEvidence: {
          stdout: { head: "YQ==".repeat(32), complete: false },
        },
      },
    ],
  });
  expect(JSON.stringify(observed)).not.toContain('"digest":"xxx');
  expect(Buffer.byteLength(JSON.stringify(observed))).toBeLessThan(8192);
});

test("count cap keeps eight settled results and counts omitted available results", async () => {
  const f = capture(result());
  for (let i = 0; i < 12; i++) await f.run();
  expect(f.scope.diagnostics()?.results).toHaveLength(8);
  expect(f.scope.diagnostics()?.omittedResults).toBe(4);
});

test("total serialized captures stay within 32 KiB including JSON escaping", async () => {
  const f = capture({
    ...result(),
    stdout: "\u0000".repeat(512),
    stderr: "\u0000".repeat(512),
  });
  for (let i = 0; i < 10; i++) await f.run();
  const observed = f.scope.diagnostics()!;
  expect(observed.results.length).toBeLessThan(8);
  expect(observed.omittedResults).toBe(10 - observed.results.length);
  expect(
    observed.results.reduce<number>(
      (bytes, entry) => bytes + Buffer.byteLength(JSON.stringify(entry)),
      0,
    ),
  ).toBeLessThanOrEqual(32_768);
  expect(Buffer.byteLength(JSON.stringify(observed))).toBeLessThanOrEqual(
    32_768,
  );
});

test("a result exceeding 8 KiB after escaping is omitted without retaining its source", async () => {
  const value = {
    ...result(),
    stdout: "\u0000".repeat(512),
    stderr: "\u0000".repeat(512),
  };
  for (const stream of [
    value.outputEvidence!.stdout,
    value.outputEvidence!.stderr,
  ])
    Object.assign(stream, {
      head: "\u0000".repeat(128),
      tail: "\u0000".repeat(128),
      digest: "\u0000".repeat(128),
    });
  const f = capture(value);
  await f.run();
  expect(f.scope.diagnostics()).toEqual({ results: [], omittedResults: 1 });
});

test("tail previews retain the available suffix and observation never invokes result getters", async () => {
  const value = result();
  Object.assign(value.outputEvidence!.stdout, {
    tail: "YQ==".repeat(1000) + "Yg==",
  });
  Object.defineProperty(value, "stderr", {
    get: () => {
      throw Error("getter");
    },
  });
  const f = capture(value);
  await f.run();
  expect(f.scope.diagnostics()).toMatchObject({
    results: [
      {
        captureTruncated: true,
        outputEvidence: { stdout: { tail: "YQ==".repeat(31) + "Yg==" } },
      },
    ],
  });
  expect(JSON.stringify(f.scope.diagnostics())).not.toContain('"stderr":"');
});

for (const outcome of ["timeout", "cancelled"] as const) {
  test(`available diagnostics do not reopen cached write methods after ${outcome}`, async () => {
    let now = 0;
    let writes = 0;
    const scope = new InvocationServices(100, () => {}, false, {
      now: () => now,
    });
    const services = scope.wrap({
      write: () => {
        writes++;
      },
      process: port(
        (_executable, _args, options) =>
          new Promise((resolve) => {
            options.signal!.addEventListener("abort", () => resolve(result()), {
              once: true,
            });
          }),
      ),
    }) as { write(this: void): void; process: ProcessPort };
    const write = services.write;
    const pending = services.process.run(executable, [], spawn);
    if (outcome === "timeout") {
      now = 100;
      expect(() => write()).toThrow("INVOCATION_TIMEOUT");
    } else
      scope.controller.abort(
        new ForgeFailure({
          code: "INVOCATION_CANCELLED",
          message: "cancelled",
          retry: "never",
        }),
      );
    await pending;
    await scope.drain();
    expect(scope.diagnostics()).toMatchObject({
      results: [{ stdout: "partial output" }],
    });
    expect(() => write()).toThrow(ForgeFailure);
    scope.stop();
    expect(() => write()).toThrow("SERVICE_EXPIRED");
    expect(writes).toBe(0);
  });
}

test("missing and rejected results are unavailable; genuine process errors are preserved", async () => {
  const scope = new InvocationServices(100, () => {}, false, { now: () => 0 });
  expect(scope.diagnostics()).toBeUndefined();
  const error = Error("real process error");
  const client = scope.wrap(port(() => Promise.reject(error))) as ProcessPort;
  await expect(client.run(executable, [], spawn)).rejects.toBe(error);
  await scope.drain();
  expect(scope.diagnostics()).toBeUndefined();
});

async function invoke(
  run: RunIsolation["run"],
  options: RuntimeOptions = {},
  close = () => Promise.resolve(),
  process = port(() => Promise.resolve(result())),
) {
  const f = fixture("({input}) => input", { timeoutMs: 100 });
  return f
    .runtime({
      ...options,
      services: () =>
        Promise.resolve({ ownership: "owned", value: { process }, close }),
      isolation: {
        open: () =>
          Promise.resolve({
            ok: true,
            handle: {
              ownership: "owned",
              close: () => Promise.resolve(),
              value: { run },
            },
          }),
      },
    })
    .invoke(f.request);
}
function client(args: unknown): ProcessPort {
  return (args as { services: { process: ProcessPort } }).services.process;
}

test("pre-existing observed is preserved and detached from late failure mutation", async () => {
  const previous = { detail: ["before"] };
  const envelope = await invoke(async ({ args }) => {
    await client(args).run(executable, [], spawn);
    throw new ForgeFailure({
      code: "INPUT_CONFLICT",
      message: "failed",
      retry: "never",
      observed: previous,
    });
  });
  expect(envelope).toMatchObject({
    ok: false,
    error: { observed: { previous, processes: { results: [result()] } } },
  });
  previous.detail.push("after");
  expect(envelope).toMatchObject({
    error: { observed: { previous: { detail: ["before"] } } },
  });
  expect(Object.isFrozen(envelope)).toBe(true);
});

for (const maxOutputBytes of [1, 300, 900]) {
  test(`optional evidence cannot exceed the final envelope budget ${maxOutputBytes}`, async () => {
    const previous = { detail: "preserved" };
    const envelope = await invoke(
      async ({ args }) => {
        await client(args).run(executable, [], spawn);
        throw new ForgeFailure({
          code: "INPUT_CONFLICT",
          message: "failed",
          retry: "never",
          observed: previous,
        });
      },
      { limits: { maxOutputBytes } },
    );
    expect(envelope).toMatchObject({
      ok: false,
      error: { code: "INPUT_CONFLICT" },
    });
    if (!envelope.ok && envelope.error.observed !== previous)
      expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThanOrEqual(
        maxOutputBytes,
      );
    else expect(envelope).toMatchObject({ error: { observed: previous } });
  });
}

for (const parse of [
  { ...DEFAULT_PARSE_LIMITS, maxBytes: 100 },
  { ...DEFAULT_PARSE_LIMITS, maxDepth: 4 },
  { ...DEFAULT_PARSE_LIMITS, maxNodes: 15 },
  { ...DEFAULT_PARSE_LIMITS, maxStringLength: 10 },
]) {
  test(`attachment respects parse limits ${JSON.stringify(parse)}`, async () => {
    const previous = { detail: "preserved" };
    const envelope = await invoke(
      async ({ args }) => {
        await client(args).run(executable, [], spawn);
        throw new ForgeFailure({
          code: "INPUT_CONFLICT",
          message: "failed",
          retry: "never",
          observed: previous,
        });
      },
      { limits: { parse } },
    );
    expect(envelope).toMatchObject({
      ok: false,
      error: { code: "INPUT_CONFLICT", observed: previous },
    });
    if (!envelope.ok) expect(envelope.error.observed).toBe(previous);
  });
}

test("successful invocations do not gain process observations", async () => {
  expect(
    await invoke(async ({ args, encode }) => {
      await client(args).run(executable, [], spawn);
      return encode("hello");
    }),
  ).toEqual({
    ok: true,
    op: "sample.run",
    status: "OK",
    result: "hello",
    warnings: [],
  });
});

test("a failed invocation retains its cause without inventing process observations", async () => {
  const envelope = await invoke(() => {
    throw Error("handler failed");
  });
  expect(envelope).toMatchObject({
    ok: false,
    error: { code: "BLOCK_EXECUTION_FAILED" },
  });
  if (!envelope.ok)
    expect(envelope.error.observed).toEqual({
      cause: { name: "Error" },
    });
});

for (const serviceFails of [false, true]) {
  test(`process cleanup failure retains precedence, service cleanup failure=${serviceFails}`, async () => {
    let calls = 0;
    const process = port(() =>
      ++calls === 1
        ? Promise.resolve(result())
        : Promise.reject(
            Object.assign(Error("cleanup"), { code: "TREE_KILL_FAILED" }),
          ),
    );
    const envelope = await invoke(
      async ({ args }) => {
        await client(args).run(executable, [], spawn);
        await client(args).run(executable, [], spawn);
      },
      {},
      () =>
        serviceFails
          ? Promise.reject(Error("service close"))
          : Promise.resolve(),
      process,
    );
    expect(envelope).toMatchObject({
      ok: false,
      status: "INCOMPLETE",
      error: {
        code: serviceFails ? "INTERNAL" : "PROCESS_CLEANUP_FAILED",
        observed: { processes: { results: [{ stdout: "partial output" }] } },
      },
    });
  });
}

for (const [label, code, expected] of [
  ["plain", 'throw new Error("boom")', { name: "Error" }],
  ["typed", 'throw new TypeError("boom")', { name: "TypeError" }],
  [
    "coded",
    'throw Object.assign(new Error("denied"), { code: "EPERM", syscall: "unlink" })',
    { name: "Error", code: "EPERM", syscall: "unlink" },
  ],
  ["async", 'return Promise.reject(new Error("boom"))', { name: "Error" }],
] as const)
  test(`unexpected ${label} handler errors retain a bounded cause`, async () => {
    const f = fixture(`() => { ${code} }`, { timeoutMs: 1000 });
    const result = await f.runtime().invoke(f.request);
    assert.partialDeepStrictEqual(result, {
      ok: false,
      status: "FAIL",
      error: {
        code: "BLOCK_EXECUTION_FAILED",
        message: "block execution failed",
        retry: "reconcile_first",
        observed: { cause: expected },
      },
    });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("expected failure");
    const { cause } = result.error.observed as {
      cause: Record<string, string>;
    };
    assert.equal(Object.hasOwn(cause, "message"), false);
    assert.match(cause.frame!, /^index\.cjs:\d+:\d+$/);
    for (const value of Object.values(cause))
      assert.ok(Buffer.byteLength(value) <= 200);
  }, 5000);

test("unexpected causes omit free text containing tokens and private paths", async () => {
  const privateValues = [
    "synthetic-json-token",
    "synthetic-bearer-token",
    "C:\\Users\\Example User\\private.txt",
    "\\Users\\Example\\private.txt",
    "/home/Example User/private.txt",
    join(homedir(), "private.txt"),
  ];
  const privateMessage = `{"token":"${privateValues[0]}"} Authorization: Bearer ${privateValues[1]} ${privateValues.slice(2).join(" ")}`;
  const f = fixture(
    `() => { throw Object.assign(new Error(${JSON.stringify(privateMessage)}), { name: ${JSON.stringify(privateMessage)} }) }`,
    { timeoutMs: 1000 },
  );
  const result = await f.runtime().invoke(f.request);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected failure");
  const { cause } = result.error.observed as {
    cause: Record<string, string>;
  };
  assert.equal(cause.name, "Error");
  assert.equal(Object.hasOwn(cause, "message"), false);
  const serialized = JSON.stringify(result);
  for (const value of [...privateValues, "Example", homedir()])
    assert.ok(!serialized.includes(JSON.stringify(value).slice(1, -1)));
}, 5000);

for (const invalid of ["A".repeat(41), "eperm", "/home/Example", 13])
  test(`unexpected causes omit invalid code and syscall ${JSON.stringify(invalid)}`, async () => {
    const f = fixture(
      `() => { throw Object.assign(new Error("denied"), { code: ${JSON.stringify(invalid)}, syscall: ${JSON.stringify(invalid === "eperm" ? "Unlink" : invalid)} }) }`,
      { timeoutMs: 1000 },
    );
    const result = await f.runtime().invoke(f.request);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("expected failure");
    const { cause } = result.error.observed as {
      cause: Record<string, string>;
    };
    assert.equal(Object.hasOwn(cause, "code"), false);
    assert.equal(Object.hasOwn(cause, "syscall"), false);
  }, 5000);

test("unexpected cause accessors cannot replace the failure envelope", async () => {
  const f = fixture(
    '() => { throw Object.defineProperty(new Error("boom"), "name", {get(){throw new Error("getter ran")}}) }',
    { timeoutMs: 1000 },
  );
  const result = await f.runtime().invoke(f.request);
  assert.partialDeepStrictEqual(result, {
    ok: false,
    error: {
      code: "BLOCK_EXECUTION_FAILED",
      observed: { cause: { name: "Error" } },
    },
  });
}, 5000);
