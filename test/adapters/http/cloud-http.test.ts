import { expect, setDefaultTimeout, test } from "bun:test";
import {
  createCloudHttp,
  validateOrigin,
  validateProject,
  type CloudFetch,
  type CloudHttp,
  type CommandWire,
  type LeaseRoute,
  type LeaseWriteBody,
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
  more: {
    timeoutMs?: number;
    maxBytes?: number;
    commandMaxBytes?: number;
  } = {},
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

const TOKEN = `fct_0123456789abcdef.${"T".repeat(43)}`;
const SUBJECT = "issue:forge-1";
const HOLDER = {
  actor: { kind: "agent" as const, id: "a1" },
  session: { id: "s1", device: "dev-1", agent: "a1", harness: "claude" },
};
const lease = (more: Record<string, unknown> = {}) => ({
  subject: SUBJECT,
  holder: HOLDER,
  generation: 3,
  expiresAt: "2026-11-11T12:00:00.000Z",
  ...more,
});
const base = { subject: SUBJECT, holder: HOLDER, requestId: "r-1" };
const bodies: Record<LeaseRoute, LeaseWriteBody> = {
  claim: { ...base, ttlMs: 60_000 },
  renew: { ...base, generation: 3, ttlMs: 60_000 },
  release: { ...base, generation: 3 },
};
const ok = (value: unknown, status = 200) => json({ ok: true, value }, status);
const refusal = (code: string, status: number, more = {}) =>
  json({ ok: false, error: { code, message: SECRET, ...more } }, status);
const details = { ...lease(), generation: 4 };
const bad = (more: Record<string, unknown>) =>
  refusal("LEASE_STALE", 409, { lease: { ...details, ...more } });
const wire: CommandWire = {
  requestId: "r-1",
  op: "issue.show",
  input: { id: "forge-1" },
  context: { session: { id: "s1", device: "dev-1" }, project: { id: "proj" } },
};
const item = { id: "forge-1", title: "A title" };
const succeeded = (more = {}, status = 200) =>
  json(
    {
      ok: true,
      op: "issue.show",
      status: "OK",
      result: item,
      warnings: [],
      ...more,
    },
    status,
  );
const refusalBody = (code: string) => ({
  ok: false,
  status: "FAIL",
  error: { code, message: SECRET, retry: "never" },
  warnings: [],
});
const refused = (code: string, status: number, more = {}) =>
  json(
    { ...refusalBody(code), error: { ...refusalBody(code).error, ...more } },
    status,
  );
const operations: [
  string,
  (h: CloudHttp, s?: AbortSignal) => Promise<unknown>,
][] = [
  ["claim", (h, s) => h.leaseWrite(TOKEN, "claim", bodies.claim, s)],
  ["holder", (h, s) => h.leaseHolder(TOKEN, SUBJECT, s)],
  ["command", (h, s) => h.command(TOKEN, wire, s)],
];
const feed = (onCancel: () => void, after = () => {}, endless = false) =>
  new ReadableStream<Uint8Array>({
    start: (c) => void (c.enqueue(new TextEncoder().encode('{"ok":')), after()),
    pull: (c) =>
      void (endless && c.enqueue(new TextEncoder().encode("x".repeat(600)))),
    cancel: onCancel,
  });

/** Exactly one request went out, with this method, route and the bearer header. */
function sentOnce(
  net: ReturnType<typeof network>,
  method: string,
  path: string,
) {
  expect(net.calls).toHaveLength(1);
  const [call] = net.calls;
  expect([
    call?.init.method,
    call?.url,
    call?.init.headers.authorization,
  ]).toEqual([method, `${ORIGIN}/p/proj/${path}`, `Bearer ${TOKEN}`]);
}

for (const route of ["claim", "renew", "release"] as const)
  test(`a ${route} posts the exact body with the bearer header and nothing else`, async () => {
    const net = network(() => ok(lease()));
    const result = await http(net.fetch).leaseWrite(
      TOKEN,
      route,
      bodies[route],
    );
    expect(result).toEqual({ kind: "ok", lease: lease() });
    const [call] = net.calls;
    expect(call?.url).toBe(`${ORIGIN}/p/proj/${route}`);
    expect(call?.init.method).toBe("POST");
    expect(call?.init.redirect).toBe("manual");
    expect(call?.init.body).toBe(JSON.stringify(bodies[route]));
    expect(call?.init.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(Object.keys(call?.init.headers ?? {})).toHaveLength(3);
  }, 10_000);

test("a holder read is a GET with the subject URL-encoded and no body, and keeps the raw record", async () => {
  const subject = "issue:a b/c?d";
  const mine = (more = {}) => lease({ subject, ...more });
  const released = mine({ releasedAt: "2026-11-11T11:00:00.000Z" });
  const lapsed = mine({ expiresAt: "2020-01-01T00:00:00.000Z" });
  for (const value of [mine(), released, lapsed, null]) {
    const net = network(() => ok(value));
    const result = await http(net.fetch).leaseHolder(TOKEN, subject);
    expect(result).toEqual({ kind: "ok", lease: value } as never);
    sentOnce(net, "GET", "holder?subject=issue%3Aa%20b%2Fc%3Fd");
    expect(net.calls[0]?.init.body).toBeUndefined();
  }
}, 10_000);

test("every refusal in the vocabulary keeps its code, the lease ones keep validated details, and no server words survive", async () => {
  const coded = (
    "LEASE_HELD:409 LEASE_STALE:409 LEASE_NOT_HELD:409 LEASE_EXPIRED:409 " +
    "INPUT_CONFLICT:409 INPUT_INVALID:400 AUTH_REQUIRED:401 AUTH_INVALID:401 " +
    "AUTH_REVOKED:401 AUTH_EXPIRED:401 AUTH_DEVICE_MISMATCH:403"
  ).split(" ");
  for (const entry of coded) {
    const [code = "", status = ""] = entry.split(":");
    const leased = code.startsWith("LEASE_");
    const answer = refusal(
      code,
      Number(status),
      leased ? { lease: details } : {},
    );
    const result = await http(network(() => answer).fetch).leaseWrite(
      TOKEN,
      "renew",
      bodies.renew,
    );
    const expected = leased
      ? { kind: "refused", code, lease: details }
      : { kind: "refused", code };
    expect(result).toEqual(expected as never);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  }
  const bare = refusal("LEASE_HELD", 409, { lease: { subject: SUBJECT } });
  const read = http(network(() => bare).fetch).leaseHolder(TOKEN, SUBJECT);
  expect(await read).toEqual({
    kind: "refused",
    code: "LEASE_HELD",
    lease: { subject: SUBJECT },
  });
}, 10_000);

const both = (flag: boolean, status: number) =>
  json({ ok: flag, value: lease(), error: { code: "AUTH_REVOKED" } }, status);
const badAnswers: [string, () => Response][] = [
  ["malformed JSON", () => new Response("{")],
  ["a malformed lease", () => ok(lease({ generation: "3" }))],
  ["a lease with an unknown field", () => ok(lease({ extra: 1 }))],
  ["a wrong subject", () => ok(lease({ subject: "issue:x" }))],
  ["no lease on a write", () => ok(null)],
  ["a 500 with a success body", () => ok(lease(), 500)],
  [
    "a 200 with a refusal",
    () => refusal("LEASE_HELD", 200, { lease: details }),
  ],
  ["no ok flag", () => json({ value: lease() })],
  ["a success that carries an error", () => both(true, 200)],
  ["a refusal that carries a value", () => both(false, 401)],
  ["an unknown code", () => refusal("TEAPOT", 409)],
  ["UNAVAILABLE as a code", () => refusal("UNAVAILABLE", 503)],
  ["a status against the code", () => refusal("AUTH_REVOKED", 403)],
  ["no conflict details", () => refusal("LEASE_HELD", 409)],
  ["details for another subject", () => bad({ subject: "issue:x" })],
  ["details with a bad holder", () => bad({ holder: { actor: 1 } })],
  ["details with a bad generation", () => bad({ generation: 0 })],
  ["details with a bad expiry", () => bad({ expiresAt: "soon" })],
];
for (const [name, answer] of badAnswers)
  test(`${name} is unavailable and echoes nothing`, async () => {
    const response = answer();
    const net = network(() => response);
    const failed = await failure(() =>
      http(net.fetch).leaseWrite(TOKEN, "claim", bodies.claim),
    );
    expect(failed.error.code).toBe("UNAVAILABLE");
    expect(JSON.stringify(failed.error)).not.toContain(SECRET);
    sentOnce(net, "POST", "claim");
    expect(response.bodyUsed).toBe(true);
  }, 10_000);

test("a token that is not well formed never reaches the network or an error", async () => {
  const net = network(() => ok(lease()));
  for (const token of ["", "fct_x", `${TOKEN}\r\nx: 1`, `Bearer ${TOKEN}`]) {
    const failed = await failure(() =>
      http(net.fetch).leaseWrite(token, "claim", bodies.claim),
    );
    expect(failed.error.code).toBe("INPUT_INVALID");
    expect(JSON.stringify(failed.error)).not.toContain("T".repeat(43));
  }
  expect(net.calls).toHaveLength(0);
}, 10_000);

for (const [name, run] of operations) {
  type Net = ReturnType<typeof network>;
  const code = async (net: Net, more = {}, signal?: AbortSignal) =>
    (await failure(() => run(http(net.fetch, more), signal))).error.code;

  test(`${name}: a transport error or a body that holds the token is unavailable and never repeats it`, async () => {
    const thrown = network(() => {
      throw new Error(`connect failed for ${TOKEN}`);
    });
    const text = network(() => new Response(`${TOKEN} ${SECRET}`));
    const refused = network(() => refusal("TEAPOT", 409, { message: TOKEN }));
    for (const net of [thrown, text, refused]) {
      const failed = await failure(() => run(http(net.fetch)));
      expect(failed.error.code).toBe("UNAVAILABLE");
      expect(JSON.stringify(failed.error)).not.toMatch(/fct_|SERVER-TEXT/);
      expect(net.calls).toHaveLength(1);
    }
  }, 10_000);

  for (const status of [301, 302, 303, 307, 308])
    test(`${name}: a ${status} is refused after one request and the token never goes to its Location`, async () => {
      const location = "https://evil.test/steal";
      const net = network(
        () => new Response(null, { status, headers: { location } }),
        () => ok(lease()),
      );
      expect(await code(net)).toBe("UNAVAILABLE");
      expect(net.calls).toHaveLength(1);
      expect(net.calls[0]?.url).not.toContain("evil.test");
    }, 10_000);

  test(`${name}: a declared or streamed body over the limit is refused and the stream is cancelled`, async () => {
    const declared = network(
      () => new Response("{}", { headers: { "content-length": "999999" } }),
    );
    expect(
      await code(declared, { maxBytes: 1024, commandMaxBytes: 1024 }),
    ).toBe("UNAVAILABLE");
    let cancelled = false;
    const endless = feed(
      () => void (cancelled = true),
      () => {},
      true,
    );
    const streamed = network(() => new Response(endless));
    expect(
      await code(streamed, { maxBytes: 1024, commandMaxBytes: 1024 }),
    ).toBe("UNAVAILABLE");
    expect(cancelled).toBe(true);
    expect(declared.calls.length + streamed.calls.length).toBe(2);
  }, 10_000);

  test(`${name}: stalled headers or a stalled body end at the deadline and the stream is cancelled`, async () => {
    const headers = network(
      ({ init }) =>
        new Promise<Response>((_, reject) =>
          init.signal.addEventListener("abort", () => reject(new Error("x"))),
        ),
    );
    expect(await code(headers, { timeoutMs: 40 })).toBe("UNAVAILABLE");
    let cancelled = false;
    const body = network(
      () => new Response(feed(() => void (cancelled = true))),
    );
    expect(await code(body, { timeoutMs: 40 })).toBe("UNAVAILABLE");
    expect(cancelled).toBe(true);
    expect(headers.calls.length + body.calls.length).toBe(2);
  }, 10_000);

  test(`${name}: cancelling the caller during the request or the body is a cancellation with one request`, async () => {
    const early = new AbortController();
    const during = network(
      ({ init }) =>
        new Promise<Response>((_, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("x")));
          early.abort();
        }),
    );
    expect(await code(during, {}, early.signal)).toBe("INVOCATION_CANCELLED");
    const late = new AbortController();
    const abort = () => queueMicrotask(() => late.abort());
    const reading = network(() => new Response(feed(() => {}, abort)));
    expect(await code(reading, {}, late.signal)).toBe("INVOCATION_CANCELLED");
    expect(during.calls.length + reading.calls.length).toBe(2);
  }, 10_000);
}

const commands = (
  "INPUT_INVALID:400 CONTEXT_MISSING:400 UNKNOWN_COMMAND:404 NOT_FOUND:404 " +
  "INPUT_CONFLICT:409 REVISION_CONFLICT:409 INTERNAL:500 UNAVAILABLE:503 AUTH_REQUIRED:401 " +
  "AUTH_INVALID:401 AUTH_REVOKED:401 AUTH_EXPIRED:401 " +
  "AUTH_DEVICE_MISMATCH:403 AUTH_FORBIDDEN:403"
).split(" ");
test("a command posts exactly the wire body to the command route with the bearer header and returns only the result", async () => {
  const net = network(() => succeeded());
  const result = await http(net.fetch).command(TOKEN, wire);
  expect(result).toEqual({ kind: "ok", result: item });
  sentOnce(net, "POST", "command");
  const [call] = net.calls;
  expect(call?.init.body).toBe(JSON.stringify(wire));
  expect(call?.init.redirect).toBe("manual");
  expect(Object.keys(call?.init.headers ?? {})).toHaveLength(3);
}, 10_000);

test("a command answer may be up to 1 MiB while a lease answer stays at 64 KiB", async () => {
  const sized = (body: unknown, size: number) => () =>
    new Response(JSON.stringify(body), {
      headers: { "content-length": String(size) },
    });
  const answer = {
    ok: true,
    op: "issue.show",
    status: "OK",
    result: item,
    warnings: [],
  };
  const run = (size: number) =>
    http(network(sized(answer, size)).fetch).command(TOKEN, wire);
  for (const size of [70_000, 1_048_576])
    expect(await run(size)).toEqual({ kind: "ok", result: item });
  expect((await failure(() => run(1_048_577))).error.code).toBe("UNAVAILABLE");
  const leased = http(
    network(sized({ ok: true, value: lease() }, 70_000)).fetch,
  );
  expect(
    (await failure(() => leased.leaseHolder(TOKEN, SUBJECT))).error.code,
  ).toBe("UNAVAILABLE");
  const big = { text: "x".repeat(200_000) };
  const real = network(() => succeeded({ result: big }));
  expect(await http(real.fetch).command(TOKEN, wire)).toEqual({
    kind: "ok",
    result: big,
  });
}, 10_000);

test("each refusal the command route sends keeps its code at its mapped status and never the server's words", async () => {
  for (const entry of commands) {
    const [code = "", status = ""] = entry.split(":");
    const answer = refused(code, Number(status), {
      lease: details,
      observed: { blockers: [{ id: "forge-1" }] },
      repair: `forge ${SECRET}`,
      details: { SECRET },
      expected: SECRET,
    });
    const result = await http(network(() => answer).fetch).command(TOKEN, wire);
    expect(result).toEqual({ kind: "refused", code } as never);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  }
}, 10_000);

const badCommands: [string, () => Response][] = [
  ["malformed JSON", () => new Response("{")],
  ["an extra key", () => succeeded({ extra: 1 })],
  [
    "a missing key",
    () => json({ ok: true, op: "issue.show", status: "OK", result: item }),
  ],
  ["ok true with a 4xx", () => succeeded({}, 400)],
  ["ok true with a 500", () => succeeded({}, 500)],
  ["another operation", () => succeeded({ op: "issue.list" })],
  ["a status that is not OK", () => succeeded({ status: "FAIL" })],
  ["a result that is an array", () => succeeded({ result: [] })],
  ["a result that is null", () => succeeded({ result: null })],
  ["warnings that are not a list", () => succeeded({ warnings: "x" })],
  ["a valid code at the wrong status", () => refused("NOT_FOUND", 400)],
  ["a valid code at 200", () => refused("NOT_FOUND", 200)],
  ["an unknown code", () => refused("TEAPOT", 404)],
  ["a server error code at the wrong status", () => refused("INTERNAL", 503)],
  [
    "a refusal with an extra key",
    () => json({ ...refusalBody("NOT_FOUND"), extra: 1 }, 404),
  ],
  [
    "a refusal whose status says OK",
    () => json({ ...refusalBody("NOT_FOUND"), status: "OK" }, 404),
  ],
  [
    "a refusal with no error object",
    () => json({ ok: false, status: "FAIL", error: "x", warnings: [] }, 404),
  ],
];
for (const [name, answer] of badCommands)
  test(`a command answer with ${name} is unavailable and echoes nothing`, async () => {
    const response = answer();
    const net = network(() => response);
    const failed = await failure(() => http(net.fetch).command(TOKEN, wire));
    expect(failed.error.code).toBe("UNAVAILABLE");
    expect(JSON.stringify(failed.error)).not.toContain(SECRET);
    sentOnce(net, "POST", "command");
    expect(response.bodyUsed).toBe(true);
  }, 10_000);

// A failure the transport throws is not the adapter's own: whatever it says, it is never passed on.
const planted = () =>
  new ForgeFailure({
    code: "AUTH_REVOKED",
    message: `revoked ${TOKEN}`,
    retry: "never",
    repair: TOKEN,
    observed: { token: TOKEN },
  });
const midStream = () =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"ok":'));
        controller.error(planted());
      },
    }),
  );
const routes: typeof operations = [
  ...operations,
  ["loginPoll", (h, s) => h.loginPoll(DEVICE_CODE, s)],
];
for (const [name, run] of routes)
  test(`${name}: a ForgeFailure thrown by the transport or its stream is the fixed unavailable and never repeats the token`, async () => {
    const thrown = network(() => {
      throw planted();
    });
    for (const net of [thrown, network(midStream)]) {
      const failed = await failure(() => run(http(net.fetch)));
      expect([failed.error.code, failed.error.message]).toEqual([
        "UNAVAILABLE",
        "The Forge cloud gave no usable answer: the request failed.",
      ]);
      expect(`${JSON.stringify(failed.error)} ${String(failed)}`).not.toMatch(
        /fct_|AUTH_REVOKED/,
      );
      expect(net.calls).toHaveLength(1);
    }
  }, 10_000);

// What a losing claim or a blocked claim carries: checked lease, blocker and repair details, never the server's words.
const OWNER = {
  actor: { kind: "agent" as const, id: "a2" },
  session: { id: "s9", device: "dev-9", agent: "a2", harness: "claude" },
};
const HELD = {
  subject: "issue:work-0007",
  holder: OWNER,
  generation: 4,
  expiresAt: "2026-11-11T12:00:00.000Z",
};
const claimWire = (id = "forge-0007"): CommandWire => ({
  ...wire,
  op: "issue.claim",
  input: { id },
});
const closeWire = (id = "forge-0042"): CommandWire => ({
  ...wire,
  op: "issue.close",
  input: { id, withoutReceipt: "x" },
});
const FIXED =
  "The Forge cloud gave no usable answer: the command answer failed its checks.";
const ask = (response: Response, call: CommandWire, more = {}) =>
  http(network(() => response).fetch, more).command(TOKEN, call);
/** The refusal is the fixed unavailable: no partial detail and none of the planted words. */
async function unusable(response: Response, call: CommandWire) {
  const net = network(() => response);
  const failed = await failure(() => http(net.fetch).command(TOKEN, call));
  expect([failed.error.code, failed.error.message]).toEqual([
    "UNAVAILABLE",
    FIXED,
  ]);
  expect(JSON.stringify(failed.error)).not.toMatch(/fct_|SERVER-TEXT|dev-9/);
  sentOnce(net, "POST", "command");
}
const withLease = (code: string, lease: unknown, more = {}) =>
  refused(code, 409, { lease, ...more });

for (const id of ["forge-0007", "work-0007", "FORGE-0007", "legacy-0007"])
  test(`LEASE_HELD for ${id} keeps the full lease on the canonical subject and nothing else`, async () => {
    const result = await ask(withLease("LEASE_HELD", HELD), claimWire(id));
    expect(result).toStrictEqual({
      kind: "refused",
      code: "LEASE_HELD",
      lease: HELD,
    } as never);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  }, 10_000);

for (const code of ["LEASE_STALE", "LEASE_NOT_HELD", "LEASE_EXPIRED"])
  for (const lease of [
    HELD,
    { ...HELD, expiresAt: "2020-01-01T00:00:00.000Z" },
    { subject: HELD.subject },
  ])
    test(`${code} keeps ${Object.keys(lease).length === 1 ? "a subject-only" : "a full"} lease, even one that is already past`, async () => {
      const result = await ask(withLease(code, lease), claimWire());
      expect(result).toStrictEqual({ kind: "refused", code, lease } as never);
    }, 10_000);

const { generation: _generation, ...noGeneration } = HELD;
const { holder: _holder, ...noHolder } = HELD;
const { expiresAt: _expiresAt, ...noExpiry } = HELD;
const owner = (more: object) => ({ ...HELD, holder: { ...OWNER, ...more } });
const session = (more: object) =>
  owner({ session: { ...OWNER.session, ...more } });
const badLeases: [string, string, unknown][] = [
  ["LEASE_HELD", "no lease", undefined],
  ["LEASE_HELD", "a subject-only lease", { subject: HELD.subject }],
  ["LEASE_HELD", "a lease that is not an object", "issue:work-0007"],
  [
    "LEASE_STALE",
    "a holder without the rest",
    { subject: HELD.subject, holder: OWNER },
  ],
  ["LEASE_STALE", "a tuple without a generation", noGeneration],
  ["LEASE_STALE", "a tuple without a holder", noHolder],
  ["LEASE_STALE", "a tuple without an expiry", noExpiry],
  [
    "LEASE_HELD",
    "another issue's subject",
    { ...HELD, subject: "issue:work-8" },
  ],
  [
    "LEASE_HELD",
    "the shown prefix as the subject",
    { ...HELD, subject: "issue:forge-0007" },
  ],
  [
    "LEASE_HELD",
    "a subject whose number was normalised",
    { ...HELD, subject: "issue:work-7" },
  ],
  ["LEASE_HELD", "an extra lease key", { ...HELD, note: 1 }],
  [
    "LEASE_HELD",
    "a releasedAt",
    { ...HELD, releasedAt: "2026-11-11T11:00:00.000Z" },
  ],
  ["LEASE_HELD", "an extra holder key", owner({ extra: 1 })],
  [
    "LEASE_HELD",
    "an extra actor key",
    owner({ actor: { ...OWNER.actor, extra: 1 } }),
  ],
  ["LEASE_HELD", "an extra session key", session({ extra: 1 })],
  [
    "LEASE_HELD",
    "an actor kind that is neither agent nor human",
    owner({ actor: { kind: "bot", id: "a2" } }),
  ],
  [
    "LEASE_HELD",
    "an empty actor id",
    owner({ actor: { kind: "agent", id: "" } }),
  ],
  [
    "LEASE_HELD",
    "an actor id over 200 characters",
    owner({ actor: { kind: "agent", id: "a".repeat(201) } }),
  ],
  ["LEASE_HELD", "an empty session id", session({ id: "" })],
  [
    "LEASE_HELD",
    "an agent over 200 characters",
    session({ agent: "a".repeat(201) }),
  ],
  ["LEASE_HELD", "an empty harness", session({ harness: "" })],
  ["LEASE_HELD", "an empty device", session({ device: "" })],
  [
    "LEASE_HELD",
    "a device over 256 characters",
    session({ device: "d".repeat(257) }),
  ],
  [
    "LEASE_HELD",
    "an expiry that is not a timestamp",
    { ...HELD, expiresAt: "yesterday" },
  ],
  ["LEASE_HELD", "a generation of zero", { ...HELD, generation: 0 }],
  ["LEASE_HELD", "a fractional generation", { ...HELD, generation: 1.5 }],
  ["LEASE_HELD", "an unsafe generation", { ...HELD, generation: 2 ** 53 }],
  ["LEASE_HELD", "a generation sent as text", { ...HELD, generation: "4" }],
];
for (const [code, name, lease] of badLeases)
  test(`${code} with ${name} is the fixed unavailable with no partial detail`, async () => {
    await unusable(withLease(code, lease), claimWire());
  }, 10_000);

const FOREIGN = `fct_ffffffffffffffff.${"Z".repeat(43)}`;
const leaves: [string, (value: string) => unknown][] = [
  ["actor id", (v) => owner({ actor: { kind: "agent", id: v } })],
  ["session id", (v) => session({ id: v })],
  ["session device", (v) => session({ device: v })],
  ["session agent", (v) => session({ agent: v })],
  ["session harness", (v) => session({ harness: v })],
];
const canaries: [string, string][] = [
  ["the presented token", TOKEN],
  ["a foreign device token", FOREIGN],
  ["a token inside other text", `before-${TOKEN}-after`],
  ["a terminal escape", "a\u001b[31mb"],
  ["a bell", "a\u0007b"],
];
for (const [leaf, plant] of leaves)
  test(`a ${leaf} that holds a token or a control character is the fixed unavailable, as written or JSON-escaped`, async () => {
    for (const [, canary] of canaries) {
      await unusable(withLease("LEASE_HELD", plant(canary)), claimWire());
      const text = JSON.stringify({
        ...refusalBody("LEASE_HELD"),
        error: { code: "LEASE_HELD", lease: plant(canary) },
      }).replaceAll("fct_", "\\u0066ct_");
      await unusable(new Response(text, { status: 409 }), claimWire());
    }
  }, 10_000);

test("a valid refusal survives token text in every field the client discards", async () => {
  const hostile = {
    ...refusalBody("LEASE_HELD"),
    error: {
      ...refusalBody("LEASE_HELD").error,
      message: TOKEN,
      expected: TOKEN,
      hint: { template: TOKEN, command: TOKEN },
      suggest: [TOKEN],
      details: { token: TOKEN },
      reconcileWith: TOKEN,
      repair: TOKEN,
      lease: HELD,
    },
    warnings: [{ code: "W", message: TOKEN }],
  };
  const result = await ask(json(hostile, 409), claimWire());
  expect(result).toStrictEqual({
    kind: "refused",
    code: "LEASE_HELD",
    lease: HELD,
  } as never);
  expect(JSON.stringify(result)).not.toContain(TOKEN);
}, 10_000);

const BLOCKERS = [
  { id: "forge-8" },
  { id: "forge-9", holder: OWNER, holderUnverified: true },
  {
    id: "legacy-10",
    holder: { ...OWNER, actor: { kind: "human", id: "h" } },
    holderUnverified: true,
  },
];
const blocked = (observed: unknown, more = {}) =>
  refused("CLAIM_BLOCKED", 409, { observed, ...more });
test("CLAIM_BLOCKED keeps exactly the blocker edges in server order, with no invented state", async () => {
  const result = await ask(
    blocked(
      { blockers: BLOCKERS },
      { repair: "forge issue claim x --reason y" },
    ),
    claimWire(),
  );
  expect(result).toStrictEqual({
    kind: "refused",
    code: "CLAIM_BLOCKED",
    observed: { blockers: BLOCKERS },
  } as never);
}, 10_000);

const edge = (more: object) => ({ blockers: [{ id: "forge-8", ...more }] });
const unpaired = { id: "forge-9", holder: OWNER };
const badBlockers: [string, unknown][] = [
  ["no observed", undefined],
  ["an observed that is a list", [{ id: "forge-8" }]],
  ["no blockers", {}],
  ["an empty list", { blockers: [] }],
  ["a blockers that is not a list", { blockers: "forge-8" }],
  ["an edge that is not an object", { blockers: ["forge-8"] }],
  ["an empty id", edge({ id: "" })],
  ["an id that is not an id", edge({ id: "not an id" })],
  ["an id over 200 characters", edge({ id: `forge-${"9".repeat(200)}` })],
  ["an id that is a number", edge({ id: 8 })],
  [
    "a holder without its session",
    edge({ holder: { actor: OWNER.actor }, holderUnverified: true }),
  ],
  ["an extra observed key", { ...edge({}), note: 1 }],
  ["an extra edge key", edge({ extra: 1 })],
  ["a holder without holderUnverified", { blockers: [unpaired] }],
  ["holderUnverified without a holder", edge({ holderUnverified: true })],
  [
    "holderUnverified false",
    { blockers: [{ ...unpaired, holderUnverified: false }] },
  ],
  ["an invented state", edge({ state: "open" })],
];
for (const [name, observed] of badBlockers)
  test(`CLAIM_BLOCKED with ${name} is the fixed unavailable with no partial list`, async () => {
    await unusable(blocked(observed), claimWire());
  }, 10_000);

test("a token or control character in a blocker's holder is the fixed unavailable", async () => {
  for (const [, canary] of canaries)
    await unusable(
      blocked({
        blockers: [
          {
            id: "forge-9",
            holder: owner({ actor: { kind: "agent", id: canary } }).holder,
            holderUnverified: true,
          },
        ],
      }),
      claimWire(),
    );
}, 10_000);

const repairFor = (shown: string) =>
  `forge attempt select ${shown} --attempt <attempt-id> --reason "<why>"; or forge attempt select ${shown} --none --reason "<why>"`;
const conflict = (repair?: unknown) =>
  refused("INPUT_CONFLICT", 409, repair === undefined ? {} : { repair });
for (const [asked, shown] of [
  ["forge-0042", "forge-0042"],
  ["FORGE-0042", "forge-0042"],
  ["work-0042", "forge-0042"],
  ["legacy-0042", "forge-0042"],
  ["forge-0042", "legacy-0042"],
] as const)
  test(`a competing close of ${asked} keeps the exact repair rebuilt from the shown id ${shown}`, async () => {
    const result = await ask(conflict(repairFor(shown)), closeWire(asked));
    expect(result).toStrictEqual({
      kind: "refused",
      code: "INPUT_CONFLICT",
      repair: repairFor(shown),
    } as never);
  }, 10_000);

const alone = { kind: "refused", code: "INPUT_CONFLICT" };
const first = repairFor("forge-0042").split("; or ")[0] ?? "";
const droppedRepairs: [string, unknown, CommandWire][] = [
  ["no repair", undefined, closeWire()],
  ["a number", 7, closeWire()],
  ["a short arbitrary string", "forge issue reopen", closeWire()],
  ["a suffix without its leading zeros", repairFor("forge-42"), closeWire()],
  ["another issue's suffix", repairFor("forge-0043"), closeWire()],
  [
    "different ids in its two halves",
    `${first}; or forge attempt select forge-0043 --none --reason "<why>"`,
    closeWire(),
  ],
  ["trailing text", `${repairFor("forge-0042")} now`, closeWire()],
  ["a missing alternative", first, closeWire()],
  ["a token", `${repairFor("forge-0042")} ${TOKEN}`, closeWire()],
  ["a shown id that is not an id", repairFor("not an id"), closeWire()],
  [
    "the right template on another operation",
    repairFor("forge-0007"),
    claimWire(),
  ],
];
for (const [name, repair, call] of droppedRepairs)
  test(`INPUT_CONFLICT with ${name} stays INPUT_CONFLICT with no repair`, async () => {
    expect(await ask(conflict(repair), call)).toStrictEqual(alone as never);
  }, 10_000);

// The whole refusal, multibyte text included, is bounded by commandMaxBytes before it is decoded.
const multibyte = JSON.stringify({
  ...refusalBody("LEASE_HELD"),
  error: {
    code: "LEASE_HELD",
    lease: owner({ actor: { kind: "agent", id: "é".repeat(60) } }),
  },
});
const SIZE = new TextEncoder().encode(multibyte).length;
const streamed = (cap: number) => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start: (c) =>
      void (c.enqueue(new TextEncoder().encode(multibyte)), c.close()),
    cancel: () => void (cancelled = true),
  });
  const run = ask(new Response(body, { status: 409 }), claimWire(), {
    commandMaxBytes: cap,
  });
  return { run, cancelled: () => cancelled };
};
const declared = (cap: number) =>
  ask(
    new Response(multibyte, {
      status: 409,
      headers: { "content-length": String(SIZE) },
    }),
    claimWire(),
    { commandMaxBytes: cap },
  );
test("a valid multibyte refusal is accepted exactly at commandMaxBytes and refused one byte over, declared or streamed", async () => {
  expect(SIZE).toBeGreaterThan(multibyte.length);
  const want = { kind: "refused", code: "LEASE_HELD" };
  expect(await declared(SIZE)).toMatchObject(want);
  await expect(declared(SIZE - 1)).rejects.toMatchObject({
    error: { code: "UNAVAILABLE" },
  });
  const at = streamed(SIZE);
  expect(await at.run).toMatchObject(want);
  const over = streamed(SIZE - 1);
  await expect(over.run).rejects.toMatchObject({
    error: { code: "UNAVAILABLE" },
  });
  expect(over.cancelled()).toBe(true);
}, 10_000);
