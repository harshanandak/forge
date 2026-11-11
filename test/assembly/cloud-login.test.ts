import { expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  cloudLoginCatalog,
  wireDeviceId,
  type CloudLoginDeps,
} from "../../src/assembly/cloud-login.ts";
import {
  credentialStore,
  openCloudFiles,
} from "../../src/assembly/cloud-profile.ts";
import type { McpCandidate } from "../../src/contract/mcp.ts";
import type { ResultEnvelope } from "../../src/generated/types.ts";
import {
  emptyCatalog,
  type SurfaceCatalog,
} from "../../src/surface/catalog.ts";
import { exitCode } from "../../src/surface/result.ts";
import {
  approved,
  bindingFor,
  clock,
  credentialJson,
  DEVICE_CODE,
  entry,
  json,
  network,
  ORIGIN,
  OTHER_ORIGIN,
  pending,
  PROJECT,
  PROJECT_ID,
  refusal,
  sandbox,
  SECRET,
  startBody,
  tokenFor,
  USER_CODE,
  type Sandbox,
  type Step,
} from "./cloud-fixture.ts";

setDefaultTimeout(30_000);

const INPUT = { origin: ORIGIN, project: PROJECT };

interface Rig {
  readonly sb: Sandbox;
  readonly clk: ReturnType<typeof clock>;
  readonly lines: string[];
}
function rig(options: { manifest?: boolean } = {}): Rig {
  return { sb: sandbox(options), clk: clock(), lines: [] };
}

async function login(
  r: Rig,
  steps: Step[],
  more: Partial<CloudLoginDeps> = {},
  input: unknown = INPUT,
  request: { dryRun?: boolean } = {},
) {
  const net = network(...steps);
  const catalog = cloudLoginCatalog(emptyCatalog, {
    root: r.sb.root,
    home: r.sb.home,
    deviceRoot: r.sb.deviceRoot,
    env: { FORGE_DEVICE_ID: "dev-1" },
    fetch: net.fetch,
    now: r.clk.now,
    wait: (ms, signal) => r.clk.wait(ms, signal),
    progress: (line) => r.lines.push(line),
    ...more,
  });
  const envelope = await catalog.invoke({
    schemaVersion: "forge.invocation/1",
    requestId: "request-1",
    op: "cloud.login",
    input,
    caller: "human",
    context: {},
    ...request,
  });
  return { envelope, net, exit: exitCode(envelope) };
}

/** Every output path of a login stays free of the token, the device code and the poll words. */
function expectNoSecrets(envelope: ResultEnvelope, lines: readonly string[]) {
  const text = JSON.stringify(envelope) + lines.join("\n");
  for (const secret of [
    "fct_",
    SECRET,
    "O".repeat(43),
    DEVICE_CODE,
    "NEWMARK",
    "SERVER-WORDS",
  ])
    expect(text).not.toContain(secret);
}
function failure(envelope: ResultEnvelope) {
  if (envelope.ok)
    throw new Error(`expected a failure, got ${JSON.stringify(envelope)}`);
  return envelope.error;
}
const read = (path: string): string | null =>
  existsSync(path) ? readFileSync(path, "utf8") : null;
const snapshot = (sb: Sandbox) => ({
  credentials: read(sb.credentials),
  binding: read(sb.binding),
});

async function seedPrior(r: Rig) {
  const store = credentialStore(openCloudFiles(r.sb.home), {
    wait: () => Promise.resolve(),
  });
  await store.save(entry(r.clk.now()));
  writeFileSync(r.sb.binding, `${JSON.stringify(bindingFor(), null, 2)}\n`);
  return snapshot(r.sb);
}

const goodPoll =
  (r: Rig, change: Record<string, unknown> = {}): Step =>
  () =>
    approved(credentialJson(r.clk.now(), change));

test("a login prints the code and verification URL, saves the credential privately, then binds the project", async () => {
  const r = rig();
  try {
    const { envelope, net, exit } = await login(r, [
      () => json(startBody()),
      pending,
      goodPoll(r),
    ]);
    expect(exit).toBe(0);
    expect(envelope).toMatchObject({
      ok: true,
      op: "cloud.login",
      status: "OK",
      result: {
        origin: ORIGIN,
        project: PROJECT,
        device: "dev-1",
        tokenId: "0123456789abcdef",
        expiresAt: new Date(r.clk.now() + 30 * 86_400_000).toISOString(),
      },
    });
    expectNoSecrets(envelope, r.lines);
    expect(
      r.lines.some(
        (l) => l.includes(`${ORIGIN}/device`) && l.includes(USER_CODE),
      ),
    ).toBe(true);
    expect(r.clk.waits).toEqual([5_000, 5_000]);
    expect(net.calls.map((c) => c.url)).toEqual([
      `${ORIGIN}/p/proj/loginstart`,
      `${ORIGIN}/p/proj/loginpoll`,
      `${ORIGIN}/p/proj/loginpoll`,
    ]);
    expect(net.calls[0]?.body).toEqual({ device: "dev-1" });
    expect(net.calls[1]?.body).toEqual({ device_code: DEVICE_CODE });
    for (const call of net.calls)
      expect(
        Object.keys(call.headers).map((name) => name.toLowerCase()),
      ).not.toContain("authorization");
    expect(JSON.parse(read(r.sb.binding) ?? "")).toEqual(bindingFor());
    const saved = credentialStore(openCloudFiles(r.sb.home)).lookup(
      { origin: ORIGIN, identity: PROJECT_ID, project: PROJECT },
      r.clk.now(),
    );
    expect(saved?.token).toBe(tokenFor());
  } finally {
    r.sb.close();
  }
}, 30_000);

test("slow_down raises the interval to the server's value, or by five when it names none", async () => {
  const r = rig();
  try {
    const { exit } = await login(r, [
      () => json(startBody()),
      () => refusal("slow_down", 10),
      pending,
      () => refusal("slow_down"),
      goodPoll(r),
    ]);
    expect(exit).toBe(0);
    expect(r.clk.waits).toEqual([5_000, 10_000, 10_000, 15_000]);
  } finally {
    r.sb.close();
  }
}, 30_000);

test("polling stops at the original challenge deadline even if the server keeps answering pending", async () => {
  const r = rig();
  try {
    const start = r.clk.now();
    const { envelope, exit, net } = await login(r, [
      () => json(startBody({ expires_in: 20 })),
      pending,
    ]);
    expect(exit).toBe(1);
    expect(failure(envelope).code).toBe("LOGIN_EXPIRED");
    expect(r.clk.now() - start).toBeLessThanOrEqual(20_000);
    expect(net.calls).toHaveLength(4);
    expect(snapshot(r.sb)).toEqual({ credentials: null, binding: null });
    expectNoSecrets(envelope, r.lines);
  } finally {
    r.sb.close();
  }
}, 30_000);

test("cancelling during the sleep stops the login with nothing saved", async () => {
  const r = rig();
  try {
    const controller = new AbortController();
    const { envelope, exit, net } = await login(
      r,
      [() => json(startBody()), pending],
      {
        signal: controller.signal,
        wait: () => {
          controller.abort();
          return Promise.reject(new Error("aborted"));
        },
      },
    );
    expect(exit).toBe(1);
    expect(failure(envelope).code).toBe("INVOCATION_CANCELLED");
    expect(net.calls).toHaveLength(1);
    expect(snapshot(r.sb)).toEqual({ credentials: null, binding: null });
  } finally {
    r.sb.close();
  }
}, 30_000);

test("cancelling during a poll request stops the login without another request", async () => {
  const r = rig();
  try {
    const controller = new AbortController();
    const { envelope, net } = await login(
      r,
      [
        () => json(startBody()),
        () =>
          new Promise<Response>((_, reject) => {
            controller.abort();
            reject(new Error("aborted"));
          }),
      ],
      { signal: controller.signal },
    );
    expect(failure(envelope).code).toBe("INVOCATION_CANCELLED");
    expect(net.calls).toHaveLength(2);
    expect(snapshot(r.sb)).toEqual({ credentials: null, binding: null });
  } finally {
    r.sb.close();
  }
}, 30_000);

const refusals: [string, string][] = [
  ["access_denied", "LOGIN_DENIED"],
  ["expired_token", "LOGIN_EXPIRED"],
  ["invalid_grant", "LOGIN_REFUSED"],
  ["invalid_user_code", "LOGIN_REFUSED"],
  ["rate_limited", "LOGIN_REFUSED"],
  ["capacity_exceeded", "LOGIN_REFUSED"],
  ["issuance_failed", "LOGIN_REFUSED"],
  ["unavailable", "LOGIN_REFUSED"],
  ["something_new", "LOGIN_REFUSED"],
];
for (const [error, code] of refusals)
  test(`a ${error} refusal at poll is ${code}, exit 1, and keeps the prior credential and binding`, async () => {
    const r = rig();
    try {
      const prior = await seedPrior(r);
      const { envelope, exit, net } = await login(r, [
        () => json(startBody()),
        () => json({ ok: false, error, message: "SERVER-WORDS" }, 400),
      ]);
      expect(exit).toBe(1);
      expect(failure(envelope).code).toBe(code);
      expect(net.calls).toHaveLength(2);
      expect(snapshot(r.sb)).toEqual(prior);
      expectNoSecrets(envelope, r.lines);
    } finally {
      r.sb.close();
    }
  }, 30_000);

test("a refusal at start never reaches a poll", async () => {
  const r = rig();
  try {
    const { envelope, net } = await login(r, [
      () => json({ ok: false, error: "rate_limited" }, 429),
    ]);
    expect(failure(envelope).code).toBe("LOGIN_REFUSED");
    expect(net.calls).toHaveLength(1);
    expect(r.lines).toEqual([]);
  } finally {
    r.sb.close();
  }
}, 30_000);

test("a redirect from start or poll is unavailable and its Location is never followed", async () => {
  for (const at of ["start", "poll"] as const) {
    const r = rig();
    try {
      const redirect: Step = () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example.test/steal" },
        });
      const prior = await seedPrior(r);
      const { envelope, exit, net } = await login(
        r,
        at === "start" ? [redirect] : [() => json(startBody()), redirect],
      );
      expect(exit).toBe(1);
      expect(failure(envelope).code).toBe("UNAVAILABLE");
      expect(net.calls).toHaveLength(at === "start" ? 1 : 2);
      expect(net.calls.every((c) => c.url.startsWith(ORIGIN))).toBe(true);
      expect(snapshot(r.sb)).toEqual(prior);
      expect(JSON.stringify(envelope)).not.toContain("evil.example.test");
    } finally {
      r.sb.close();
    }
  }
}, 30_000);

test("a transport failure at poll ends the login: no retry, no new start, nothing changed", async () => {
  const r = rig();
  try {
    const prior = await seedPrior(r);
    const { envelope, exit, net } = await login(r, [
      () => json(startBody()),
      () => {
        throw new Error(`reset while sending ${DEVICE_CODE}`);
      },
    ]);
    expect(exit).toBe(1);
    expect(failure(envelope).code).toBe("UNAVAILABLE");
    expect(net.calls.map((c) => c.url.split("/").pop())).toEqual([
      "loginstart",
      "loginpoll",
    ]);
    expect(snapshot(r.sb)).toEqual(prior);
    expectNoSecrets(envelope, r.lines);
  } finally {
    r.sb.close();
  }
}, 30_000);

const badCredentials: [string, (now: number) => string][] = [
  ["JSON that is malformed", () => "{"],
  [
    "a token that names another id",
    (now) => credentialJson(now, { token: tokenFor("ffffffffffffffff") }),
  ],
  [
    "the wrong device",
    (now) => credentialJson(now, { device: "someone-else" }),
  ],
  [
    "an expiry already past",
    (now) =>
      credentialJson(now, { expiresAt: new Date(now - 1).toISOString() }),
  ],
  [
    "an expiry that is not a date",
    (now) => credentialJson(now, { expiresAt: "soon" }),
  ],
  ["another format", (now) => credentialJson(now, { format: "other" })],
];
for (const [name, build] of badCredentials)
  test(`a poll that returns ${name} is unavailable, keeps the prior state and is not restarted`, async () => {
    const r = rig();
    try {
      const prior = await seedPrior(r);
      const { envelope, exit, net } = await login(r, [
        () => json(startBody()),
        () => approved(build(r.clk.now())),
      ]);
      expect(exit).toBe(1);
      expect(failure(envelope).code).toBe("UNAVAILABLE");
      expect(net.calls).toHaveLength(2);
      expect(snapshot(r.sb)).toEqual(prior);
      expectNoSecrets(envelope, r.lines);
    } finally {
      r.sb.close();
    }
  }, 30_000);

test("a start with a bad user code is unavailable and prints nothing", async () => {
  const r = rig();
  try {
    const { envelope } = await login(r, [
      () => json(startBody({ user_code: "BCDF-GH\u001b[2JK" })),
    ]);
    expect(failure(envelope).code).toBe("UNAVAILABLE");
    expect(r.lines).toEqual([]);
  } finally {
    r.sb.close();
  }
}, 30_000);

test("the binding is written only after the credential is saved: a failed save writes no binding", async () => {
  const r = rig();
  try {
    const { envelope, exit } = await login(
      r,
      [() => json(startBody()), goodPoll(r)],
      {
        security: {
          directory() {},
          file(path) {
            if (basename(path) !== "credentials.json") throw new Error("acl");
          },
        },
      },
    );
    expect(exit).toBe(1);
    expect(failure(envelope).code).toBe("ACCOUNT_INTEGRITY");
    expect(snapshot(r.sb)).toEqual({ credentials: null, binding: null });
    expectNoSecrets(envelope, r.lines);
  } finally {
    r.sb.close();
  }
}, 30_000);

test("a credential that publishes but fails readback restores the prior one and leaves the binding", async () => {
  const r = rig();
  try {
    const prior = await seedPrior(r);
    const { envelope, exit } = await login(
      r,
      [
        () => json(startBody()),
        goodPoll(r, {
          token: tokenFor("0123456789abcdef", "NEWMARK".padEnd(43, "N")),
        }),
      ],
      {
        security: {
          directory() {},
          file(path) {
            if (
              basename(path) === "credentials.json" &&
              readFileSync(path, "utf8").includes("NEWMARK")
            )
              throw new Error("acl");
          },
        },
      },
    );
    expect(exit).toBe(1);
    expect(failure(envelope).code).toBe("ACCOUNT_INTEGRITY");
    expect(snapshot(r.sb)).toEqual(prior);
    expectNoSecrets(envelope, r.lines);
  } finally {
    r.sb.close();
  }
}, 30_000);

test("a second login for the same key replaces the old entry only once the new one is verified", async () => {
  const r = rig();
  try {
    await seedPrior(r);
    const { exit } = await login(r, [() => json(startBody()), goodPoll(r)]);
    expect(exit).toBe(0);
    const text = read(r.sb.credentials) ?? "";
    expect(text).toContain("0123456789abcdef");
    expect(text).not.toContain("aaaaaaaaaaaaaaaa");
  } finally {
    r.sb.close();
  }
}, 30_000);

test("the file lock is not held while waiting for approval", async () => {
  const r = rig();
  try {
    const { exit } = await login(
      r,
      [() => json(startBody()), pending, goodPoll(r)],
      {
        wait: (ms, signal) => {
          openCloudFiles(r.sb.home).lock().release();
          return r.clk.wait(ms, signal);
        },
      },
    );
    expect(exit).toBe(0);
  } finally {
    r.sb.close();
  }
}, 30_000);

test("a binding edited to another origin than the saved association is refused before any request", async () => {
  const r = rig();
  try {
    await seedPrior(r);
    writeFileSync(
      r.sb.binding,
      `${JSON.stringify(bindingFor({ origin: OTHER_ORIGIN }), null, 2)}\n`,
    );
    const before = snapshot(r.sb);
    const { envelope, exit, net } = await login(
      r,
      [() => json(startBody())],
      {},
      {},
    );
    expect(exit).toBe(4);
    expect(failure(envelope).code).toBe("INPUT_CONFLICT");
    expect(net.calls).toHaveLength(0);
    expect(snapshot(r.sb)).toEqual(before);
    expectNoSecrets(envelope, r.lines);
  } finally {
    r.sb.close();
  }
}, 30_000);

test("explicit flags that differ from the established binding are refused before any request", async () => {
  const r = rig();
  try {
    const prior = await seedPrior(r);
    for (const input of [
      { origin: OTHER_ORIGIN, project: PROJECT },
      { origin: ORIGIN, project: "other" },
    ]) {
      const { envelope, exit, net } = await login(
        r,
        [() => json(startBody())],
        {},
        input,
      );
      expect(exit).toBe(4);
      expect(failure(envelope).code).toBe("INPUT_CONFLICT");
      expect(net.calls).toHaveLength(0);
      expect(snapshot(r.sb)).toEqual(prior);
    }
  } finally {
    r.sb.close();
  }
}, 30_000);

test("a later login with no flags uses the existing binding", async () => {
  const r = rig();
  try {
    await seedPrior(r);
    const { exit, net } = await login(
      r,
      [() => json(startBody()), goodPoll(r)],
      {},
      {},
    );
    expect(exit).toBe(0);
    expect(net.calls[0]?.url).toBe(`${ORIGIN}/p/proj/loginstart`);
  } finally {
    r.sb.close();
  }
}, 30_000);

test("a missing project identity is a context failure with no request and nothing created", async () => {
  const r = rig({ manifest: false });
  try {
    const { envelope, exit, net } = await login(r, [() => json(startBody())]);
    expect(exit).toBe(6);
    expect(failure(envelope).code).toBe("CONTEXT_MISSING");
    expect(net.calls).toHaveLength(0);
    expect(existsSync(join(r.sb.home, ".forge"))).toBe(false);
    expect(existsSync(r.sb.binding)).toBe(false);
    expect(existsSync(join(r.sb.root, ".forge", "project.json"))).toBe(false);
  } finally {
    r.sb.close();
  }
}, 30_000);

const badInputs: [string, unknown][] = [
  ["no flags on a first login", {}],
  ["only an origin", { origin: ORIGIN }],
  ["an http origin", { origin: "http://forge.example.test", project: PROJECT }],
  [
    "an origin with credentials",
    { origin: "https://u:p@forge.example.test", project: PROJECT },
  ],
  ["an origin with a path", { origin: `${ORIGIN}/x`, project: PROJECT }],
  ["a project outside the route grammar", { origin: ORIGIN, project: "../x" }],
  ["an unknown property", { ...INPUT, token: "fct_x" }],
  ["a number for the origin", { origin: 5, project: PROJECT }],
];
for (const [name, input] of badInputs)
  test(`input with ${name} is refused with exit 6 and no request`, async () => {
    const r = rig();
    try {
      const { envelope, exit, net } = await login(
        r,
        [() => json(startBody())],
        {},
        input,
      );
      expect(exit).toBe(6);
      expect(failure(envelope).code).toBe("INPUT_INVALID");
      expect(net.calls).toHaveLength(0);
      expect(snapshot(r.sb)).toEqual({ credentials: null, binding: null });
      expect(JSON.stringify(envelope)).not.toContain("fct_x");
    } finally {
      r.sb.close();
    }
  }, 30_000);

test("a dry run is refused because login cannot be previewed", async () => {
  const r = rig();
  try {
    const { envelope, exit, net } = await login(
      r,
      [() => json(startBody())],
      {},
      INPUT,
      { dryRun: true },
    );
    expect(exit).toBe(6);
    expect(failure(envelope).code).toBe("INPUT_INVALID");
    expect(net.calls).toHaveLength(0);
  } finally {
    r.sb.close();
  }
}, 30_000);

test("a device id that fits is sent unchanged and any other is mapped by its SHA-256", () => {
  expect(wireDeviceId("laptop-0123")).toBe("laptop-0123");
  expect(wireDeviceId("a".repeat(128))).toBe("a".repeat(128));
  for (const local of [
    "a".repeat(129),
    "my@laptop",
    "x".repeat(256),
    "-leading",
  ]) {
    const hex = createHash("sha256").update(local).digest("hex");
    expect(wireDeviceId(local)).toBe(`device-${hex}`);
    expect(wireDeviceId(local)).toMatch(/^[A-Za-z0-9][\w.:-]{0,127}$/);
  }
}, 10_000);

test("a long local device id is mapped for the Worker, stored with both ids, and the credential must match the mapped one", async () => {
  const local = "h".repeat(200);
  const wire = wireDeviceId(local);
  const r = rig();
  try {
    const good = await login(
      r,
      [() => json(startBody({ device: wire })), goodPoll(r, { device: wire })],
      { env: { FORGE_DEVICE_ID: local } },
    );
    expect(good.exit).toBe(0);
    expect(good.net.calls[0]?.body).toEqual({ device: wire });
    const saved = JSON.parse(read(r.sb.credentials) ?? "{}") as {
      entries: Record<string, { device: string; localDevice: string }>;
    };
    const [saving] = Object.values(saved.entries);
    expect(saving).toMatchObject({ device: wire, localDevice: local });
  } finally {
    r.sb.close();
  }
  const other = rig();
  try {
    const bad = await login(
      other,
      [
        () => json(startBody({ device: wire })),
        goodPoll(other, { device: local }),
      ],
      { env: { FORGE_DEVICE_ID: local } },
    );
    expect(failure(bad.envelope).code).toBe("UNAVAILABLE");
    expect(snapshot(other.sb)).toEqual({ credentials: null, binding: null });
  } finally {
    other.sb.close();
  }
}, 30_000);

test("without FORGE_DEVICE_ID the persistent device id is acquired and used", async () => {
  const r = rig();
  try {
    let wire = "";
    const { exit } = await login(
      r,
      [
        ({ body }) => {
          wire = (body as { device: string }).device;
          return json(startBody({ device: wire }));
        },
        () => approved(credentialJson(r.clk.now(), { device: wire })),
      ],
      { env: {} },
    );
    expect(exit).toBe(0);
    const local = readFileSync(
      join(r.sb.deviceRoot, "device-id"),
      "utf8",
    ).trim();
    expect(wire).toBe(wireDeviceId(local));
  } finally {
    r.sb.close();
  }
}, 30_000);

test("an invalid FORGE_DEVICE_ID is a context failure with no request", async () => {
  const r = rig();
  try {
    const { envelope, exit, net } = await login(r, [() => json(startBody())], {
      env: { FORGE_DEVICE_ID: "has a space" },
    });
    expect(exit).toBe(6);
    expect(failure(envelope).code).toBe("CONTEXT_MISSING");
    expect(net.calls).toHaveLength(0);
  } finally {
    r.sb.close();
  }
}, 30_000);

test("the catalog gains cloud.login, and every other call passes through unchanged", async () => {
  const other = {
    ok: true,
    op: "x.y",
    status: "OK",
    result: { a: 1 },
    warnings: [],
  } as const;
  const listed = { op: "x.y" } as unknown as McpCandidate;
  const calls: string[] = [];
  const base: SurfaceCatalog = {
    list: () => [listed],
    diagnose: () => undefined,
    invoke: (request) => {
      calls.push(request.op);
      return Promise.resolve(other);
    },
  };
  const catalog = cloudLoginCatalog(base, {
    root: "unused",
    home: "unused",
    deviceRoot: "unused",
    env: {},
  });
  const entries = catalog.list();
  expect(entries[0]).toBe(listed);
  const candidate = entries.find((c) => c.op === "cloud.login");
  expect(candidate).toBeDefined();
  expect(candidate?.admitted).toBe(true);
  expect(candidate?.declaration.callers).toEqual(["human"]);
  expect(candidate?.declaration.context).toBe("device");
  expect(candidate?.declaration.effects).toContain("files:write");
  expect(candidate?.declaration.effects.length).toBeGreaterThan(0);
  expect(candidate?.docs.title.length).toBeGreaterThan(0);
  expect(candidate?.inputSchema).toMatchObject({
    additionalProperties: false,
    properties: { origin: { type: "string" }, project: { type: "string" } },
  });
  expect(typeof catalog.diagnose).toBe("function");
  const result = await catalog.invoke({
    schemaVersion: "forge.invocation/1",
    requestId: "request-1",
    op: "x.y",
    input: {},
    caller: "human",
    context: {},
  });
  expect(result).toBe(other);
  expect(calls).toEqual(["x.y"]);
}, 10_000);
