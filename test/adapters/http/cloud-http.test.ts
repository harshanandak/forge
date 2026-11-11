import { expect, setDefaultTimeout, test } from "bun:test";
import {
  createCloudHttp,
  validateOrigin,
  validateProject,
  type CloudFetch,
} from "../../../src/adapters/http/index.ts";
import { ForgeFailure } from "../../../src/contract/failure.ts";

setDefaultTimeout(30_000);

const ORIGIN = "https://forge.example.test";
const DEVICE_CODE = "k".repeat(43);
const SECRET = "SERVER-TEXT-THAT-MUST-NOT-APPEAR";
const started = {
  ok: true,
  device_code: DEVICE_CODE,
  user_code: "BCDF-GHJK",
  expires_in: 600,
  interval: 5,
  verification_uri: "/device",
  project: "proj",
  device: "dev-1",
};

const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

type Step = (call: Call) => Response | Promise<Response>;
interface Call {
  readonly url: string;
  readonly init: Parameters<CloudFetch>[1];
}
function network(...steps: Step[]) {
  const calls: Call[] = [];
  const fetch: CloudFetch = (url, init) => {
    calls.push({ url, init });
    const step = steps[Math.min(calls.length, steps.length) - 1];
    if (step === undefined) return Promise.reject(new Error("no step"));
    try {
      return Promise.resolve(step({ url, init }));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error("step"));
    }
  };
  return { calls, fetch };
}

async function failure(run: () => Promise<unknown>): Promise<ForgeFailure> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(ForgeFailure);
    return error as ForgeFailure;
  }
  throw new Error("expected a ForgeFailure");
}
const http = (
  fetch: CloudFetch,
  more: { timeoutMs?: number; maxBytes?: number } = {},
) => createCloudHttp({ origin: ORIGIN, project: "proj", fetch, ...more });

for (const origin of [
  "http://forge.example.test",
  "https://user:pw@forge.example.test",
  "https://forge.example.test/path",
  "https://forge.example.test/",
  "https://forge.example.test?x=1",
  "https://forge.example.test#f",
  "https://FORGE.example.test",
  "https://forge.example.test:443",
  "ftp://forge.example.test",
  "forge.example.test",
  "https://",
  "",
])
  test(`an origin of ${JSON.stringify(origin)} is refused`, () => {
    try {
      validateOrigin(origin);
    } catch (error) {
      expect(error).toBeInstanceOf(ForgeFailure);
      expect((error as ForgeFailure).error.code).toBe("INPUT_INVALID");
      return;
    }
    throw new Error("expected a refusal");
  }, 10_000);

test("a canonical HTTPS origin is accepted as is", () => {
  expect(validateOrigin(ORIGIN)).toBe(ORIGIN);
  expect(validateOrigin("https://forge.example.test:8443")).toBe(
    "https://forge.example.test:8443",
  );
}, 10_000);

for (const project of ["", "../x", "a/b", "-x", "a b", "x?y", "p".repeat(65)])
  test(`a project name of ${JSON.stringify(project)} is refused`, () => {
    try {
      validateProject(project);
    } catch (error) {
      expect((error as ForgeFailure).error.code).toBe("INPUT_INVALID");
      return;
    }
    throw new Error("expected a refusal");
  }, 10_000);

test("a Worker-grammar project name is accepted", () => {
  expect(validateProject("forge-prod")).toBe("forge-prod");
  expect(validateProject("a.b_c-1")).toBe("a.b_c-1");
}, 10_000);

test("start posts the device to the project route with no bearer, no cookie and no redirect", async () => {
  const net = network(() => json(started));
  const result = await http(net.fetch).loginStart("dev-1");
  expect(result).toEqual({
    kind: "started",
    challenge: {
      deviceCode: DEVICE_CODE,
      userCode: "BCDF-GHJK",
      expiresIn: 600,
      interval: 5,
      device: "dev-1",
    },
  });
  const [call] = net.calls;
  expect(call?.url).toBe(`${ORIGIN}/p/proj/loginstart`);
  expect(call?.init.method).toBe("POST");
  expect(call?.init.redirect).toBe("manual");
  expect(JSON.parse(call?.init.body ?? "")).toEqual({ device: "dev-1" });
  const names = Object.keys(call?.init.headers ?? {}).map((n) =>
    n.toLowerCase(),
  );
  expect(names).not.toContain("authorization");
  expect(names).not.toContain("cookie");
}, 10_000);

test("poll posts only the device code and returns the credential string untouched", async () => {
  const net = network(() => json({ ok: true, credential: '{"x":1}' }));
  const result = await http(net.fetch).loginPoll(DEVICE_CODE);
  expect(result).toEqual({ kind: "credential", credential: '{"x":1}' });
  expect(net.calls[0]?.url).toBe(`${ORIGIN}/p/proj/loginpoll`);
  expect(JSON.parse(net.calls[0]?.init.body ?? "")).toEqual({
    device_code: DEVICE_CODE,
  });
}, 10_000);

test("refusals keep their name and a raised interval, and never the server's words", async () => {
  const cases: [Response, unknown][] = [
    [
      json({ ok: false, error: "authorization_pending" }, 400),
      { kind: "refused", error: "authorization_pending" },
    ],
    [
      json({ ok: false, error: "slow_down", interval: 10 }, 400),
      { kind: "refused", error: "slow_down", interval: 10 },
    ],
    [
      json({ ok: false, error: "capacity_exceeded" }, 429),
      { kind: "refused", error: "capacity_exceeded" },
    ],
    [
      json(
        {
          ok: false,
          error: { code: "AUTH_FORBIDDEN", message: SECRET, retry: "never" },
        },
        403,
      ),
      { kind: "refused", error: "AUTH_FORBIDDEN" },
    ],
    [
      json({ ok: false, error: SECRET, detail: SECRET }, 400),
      { kind: "refused", error: "unknown" },
    ],
  ];
  for (const [response, expected] of cases) {
    const result = await http(network(() => response).fetch).loginPoll(
      DEVICE_CODE,
    );
    expect(result).toEqual(expected as never);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  }
}, 10_000);

const badStarts: [string, Record<string, unknown>][] = [
  ["no device code", { device_code: undefined }],
  ["a short device code", { device_code: "short" }],
  ["a lowercase user code", { user_code: "bcdf-ghjk" }],
  ["a control character in the user code", { user_code: "BCDF-GH\u0007K" }],
  ["a user code with a vowel", { user_code: "BCDF-GHJA" }],
  ["zero lifetime", { expires_in: 0 }],
  ["a huge lifetime", { expires_in: 100_000 }],
  ["a fractional lifetime", { expires_in: 1.5 }],
  ["zero interval", { interval: 0 }],
  ["a text interval", { interval: "5" }],
  [
    "an absolute verification URI",
    { verification_uri: "https://evil.test/device" },
  ],
  ["a project-scoped verification URI", { verification_uri: "/p/proj/device" }],
  ["a trailing-slash verification URI", { verification_uri: "/device/" }],
  ["another project", { project: "other" }],
  ["another device", { device: "someone-else" }],
  ["ok false", { ok: false }],
];
for (const [name, change] of badStarts)
  test(`a start with ${name} is unavailable and prints nothing`, async () => {
    const body = { ...started, ...change };
    const failed = await failure(() =>
      http(network(() => json(body)).fetch).loginStart("dev-1"),
    );
    expect(failed.error.code).toBe("UNAVAILABLE");
    expect(JSON.stringify(failed.error)).not.toContain("evil.test");
    expect(JSON.stringify(failed.error)).not.toContain(DEVICE_CODE);
  }, 10_000);

for (const status of [301, 302, 303, 307, 308])
  test(`a ${status} is a failure and its Location is never requested`, async () => {
    const net = network(
      () =>
        new Response(null, {
          status,
          headers: { location: "https://evil.test/steal" },
        }),
      () => json(started),
    );
    const failed = await failure(() => http(net.fetch).loginStart("dev-1"));
    expect(failed.error.code).toBe("UNAVAILABLE");
    expect(net.calls).toHaveLength(1);
    expect(JSON.stringify(failed.error)).not.toContain("evil.test");
  }, 10_000);

test("a body that is not JSON, or is not an object, is unavailable and not echoed", async () => {
  for (const body of [SECRET, `[${SECRET}]`, '"x"', "", "{"]) {
    const failed = await failure(() =>
      http(network(() => new Response(body, { status: 200 })).fetch).loginPoll(
        DEVICE_CODE,
      ),
    );
    expect(failed.error.code).toBe("UNAVAILABLE");
    expect(JSON.stringify(failed.error)).not.toContain(SECRET);
  }
}, 10_000);

test("a declared or streamed body over the limit is refused and the stream is cancelled", async () => {
  const declared = network(
    () =>
      new Response("{}", {
        status: 200,
        headers: { "content-length": "999999" },
      }),
  );
  expect(
    (
      await failure(() =>
        http(declared.fetch, { maxBytes: 1024 }).loginPoll(DEVICE_CODE),
      )
    ).error.code,
  ).toBe("UNAVAILABLE");
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(600)));
    },
    cancel() {
      cancelled = true;
    },
  });
  const streamed = network(() => new Response(stream, { status: 200 }));
  const failed = await failure(() =>
    http(streamed.fetch, { maxBytes: 1024 }).loginPoll(DEVICE_CODE),
  );
  expect(failed.error.code).toBe("UNAVAILABLE");
  expect(cancelled).toBe(true);
}, 10_000);

test("a body that stalls is cut off at the deadline and cancelled", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"ok":'));
    },
    cancel() {
      cancelled = true;
    },
  });
  const net = network(() => new Response(stream, { status: 200 }));
  const failed = await failure(() =>
    http(net.fetch, { timeoutMs: 40 }).loginPoll(DEVICE_CODE),
  );
  expect(failed.error.code).toBe("UNAVAILABLE");
  expect(cancelled).toBe(true);
}, 10_000);

test("a request that never answers is cut off at the deadline", async () => {
  const net = network(
    ({ init }) =>
      new Promise<Response>((_, reject) => {
        init.signal.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      }),
  );
  const failed = await failure(() =>
    http(net.fetch, { timeoutMs: 40 }).loginStart("dev-1"),
  );
  expect(failed.error.code).toBe("UNAVAILABLE");
}, 10_000);

test("a transport error is unavailable and its text, which may hold a token, is dropped", async () => {
  const net = network(() => {
    throw new Error("connect failed for fct_0123456789abcdef.SECRETSECRET");
  });
  const failed = await failure(() => http(net.fetch).loginPoll(DEVICE_CODE));
  expect(failed.error.code).toBe("UNAVAILABLE");
  expect(JSON.stringify(failed.error)).not.toContain("fct_");
  expect(JSON.stringify(failed.error)).not.toContain("SECRETSECRET");
}, 10_000);

test("cancelling the caller's signal during the request or the body is a cancellation", async () => {
  const early = new AbortController();
  const during = network(
    ({ init }) =>
      new Promise<Response>((_, reject) => {
        init.signal.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
        early.abort();
      }),
  );
  expect(
    (
      await failure(() =>
        http(during.fetch).loginPoll(DEVICE_CODE, early.signal),
      )
    ).error.code,
  ).toBe("INVOCATION_CANCELLED");
  const late = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"ok":'));
      queueMicrotask(() => late.abort());
    },
  });
  const reading = network(() => new Response(body, { status: 200 }));
  expect(
    (
      await failure(() =>
        http(reading.fetch).loginPoll(DEVICE_CODE, late.signal),
      )
    ).error.code,
  ).toBe("INVOCATION_CANCELLED");
}, 10_000);

test("the real HTTPS transport reports an unreachable local port as unavailable", async () => {
  const failed = await failure(() =>
    createCloudHttp({
      origin: "https://127.0.0.1:1",
      project: "proj",
      timeoutMs: 5_000,
    }).loginStart("dev-1"),
  );
  expect(failed.error.code).toBe("UNAVAILABLE");
}, 20_000);
