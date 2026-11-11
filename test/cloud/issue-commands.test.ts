import { expect, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Project } from "../../cloud/src/project.ts";
import type { DurableStorage } from "../../cloud/src/store.ts";
import { prepareCommand } from "../../cloud/src/issue-commands.ts";
import { createWorker } from "../../cloud/src/worker.ts";
import { exitCode } from "../../src/surface/result.ts";

if (!("timingSafeEqual" in crypto.subtle))
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    value: crypto.timingSafeEqual.bind(crypto),
  });
await mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
const { createConfiguredWorker } =
  await import("../../cloud/src/adapters/workers-oauth/compose.ts");

const start = 1_800_000_000_000,
  day = 86_400_000,
  limit = 512 * 1024;
const vars = { FORGE_CLOUD_PROJECT: "p", ADMIN_TOKEN: "admin-secret" };
const refused = "not yet supported in cloud";
interface Envelope {
  ok: boolean;
  error?: { code: string; message: string };
  value?: { token: string };
}
type Fetcher = { fetch: (request: Request, env: never) => Promise<Response> };
type Options = {
  token?: string;
  headers?: Record<string, string>;
  name?: string;
  via?: Fetcher | "direct";
  method?: string;
};

function fixture() {
  let t = start;
  spyOn(Date, "now").mockImplementation(() => t);
  const db = new Database(":memory:"),
    values = new Map<string, unknown>(),
    calls: string[] = [];
  const storage: DurableStorage = {
    sql: {
      exec: (sql, ...bindings) => {
        calls.push(sql);
        const rows = db
          .query(sql)
          .all(
            ...bindings.map((value) =>
              value instanceof ArrayBuffer ? new Uint8Array(value) : value,
            ),
          ) as Record<string, unknown>[];
        return { toArray: () => rows };
      },
    },
    transactionSync: (body) => db.transaction(body)(),
    get: (key) => {
      calls.push(`get ${key}`);
      return Promise.resolve(values.get(key));
    },
    put: (key, value) => {
      calls.push(`put ${key}`);
      values.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => {
      calls.push(`delete ${key}`);
      return Promise.resolve(values.delete(key));
    },
  };
  let project = new Project({ storage }, vars);
  const reached: string[] = [];
  const bindings = {
    ...vars,
    PROJECTS: {
      idFromName: (name: string) => name,
      get: (id: unknown) => {
        reached.push(String(id));
        return project;
      },
    },
  };
  async function send(body: unknown, o: Options = {}) {
    const request = new Request(
      `https://w.example/p/${o.name ?? "p"}/command`,
      {
        method: o.method ?? "POST",
        headers: {
          ...(o.token === undefined
            ? {}
            : { authorization: `Bearer ${o.token}` }),
          ...o.headers,
        },
        ...(o.method === "GET"
          ? {}
          : {
              body:
                typeof body === "string" || body instanceof ReadableStream
                  ? body
                  : JSON.stringify(body),
              duplex: "half",
            }),
      },
    );
    calls.length = 0;
    const response =
      o.via === "direct"
        ? await project.fetch(request)
        : await (o.via ?? createWorker()).fetch(request, bindings as never);
    const json = (await response.json()) as Envelope;
    return {
      status: response.status,
      json,
      code: json.error?.code,
      exit: exitCode(json as never),
      touched: [...calls],
    };
  }
  const device = async (ttlMs = day) => {
    const response = await createWorker().fetch(
      new Request("https://w.example/p/p/devices", {
        method: "POST",
        headers: { authorization: `Bearer ${vars.ADMIN_TOKEN}` },
        body: JSON.stringify({ device: "laptop", ttlMs }),
      }),
      bindings,
    );
    reached.length = 0;
    return ((await response.json()) as Envelope).value!.token;
  };
  const snapshot = () =>
    JSON.stringify(
      (
        db
          .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY 1")
          .all() as { name: string }[]
      ).map(({ name }) => [name, db.query(`SELECT * FROM "${name}"`).all()]),
    );
  return {
    send,
    device,
    snapshot,
    reached,
    db,
    reopen: () => {
      project = new Project({ storage }, vars);
    },
    advance: (ms: number) => {
      t += ms;
    },
    now: () => t,
  };
}
const actor = { kind: "agent", id: "tester" } as const;
const call = {
  requestId: "r-1",
  op: "issue.show",
  input: { id: "forge-1" },
  context: { actor },
};
const configured = (forward?: () => Promise<Response>) =>
  createConfiguredWorker(undefined, forward ? { forward } : {});
const fakeToken = `fct_0123456789abcdef.${"A".repeat(43)}`;
const oauthToken = "eyJhbGciOi.e30.sig";

for (const [layer, via] of [
  ["Worker", () => createWorker()],
  ["configured Worker without OAuth settings", () => configured()],
] as const)
  test(`${layer} refuses a command before any object or OAuth setting is read`, async () => {
    const f = fixture();
    const token = await f.device();
    const cases: [string, Options, number, string][] = [
      ["other project", { token, name: "other" }, 403, "AUTH_FORBIDDEN"],
      [
        "owner header",
        { token, headers: { "X-Forge-Owner": "phone" } },
        403,
        "AUTH_FORBIDDEN",
      ],
      [
        "owner expiry header",
        { token, headers: { "X-Forge-Owner-Expires": "1" } },
        403,
        "AUTH_FORBIDDEN",
      ],
      ["no bearer", {}, 401, "AUTH_REQUIRED"],
      ["admin token", { token: vars.ADMIN_TOKEN }, 403, "AUTH_FORBIDDEN"],
      ["oauth bearer", { token: oauthToken }, 403, "AUTH_FORBIDDEN"],
    ];
    const before = f.snapshot();
    for (const [name, options, status, code] of cases) {
      const got = await f.send(call, { ...options, via: via() });
      expect([name, got.status, got.code]).toEqual([name, status, code]);
    }
    expect(f.reached).toEqual([]);
    expect(f.snapshot()).toBe(before);
    const ok = await f.send(call, { token, via: via() });
    expect([ok.status, ok.code, ok.exit, f.reached]).toEqual([
      400,
      "INPUT_INVALID",
      6,
      ["p"],
    ]);
    expect(ok.json.error?.message).toContain(refused);
    expect(f.snapshot()).toBe(before);
  }, 30_000);

test("an owner-forwarded OAuth request never reaches the command handler", async () => {
  const f = fixture();
  const forward = mock(() => Promise.resolve(new Response("forwarded")));
  const got = await f.send(call, {
    token: oauthToken,
    via: configured(forward),
  });
  expect([got.status, forward.mock.calls.length, f.reached]).toEqual([
    403,
    0,
    [],
  ]);
}, 30_000);

test("the object refuses on its own when reached directly", async () => {
  const f = fixture();
  const token = await f.device();
  const cases: [string, Options, number, string][] = [
    [
      "owner header with token",
      { token, headers: { "X-Forge-Owner": "phone" } },
      403,
      "AUTH_FORBIDDEN",
    ],
    [
      "owner header alone",
      { headers: { "X-Forge-Owner": "phone" } },
      403,
      "AUTH_FORBIDDEN",
    ],
    ["other project", { token, name: "other" }, 403, "AUTH_FORBIDDEN"],
    ["no bearer", {}, 401, "AUTH_REQUIRED"],
    ["admin token", { token: vars.ADMIN_TOKEN }, 403, "AUTH_FORBIDDEN"],
    ["wrong secret", { token: `${token}x` }, 403, "AUTH_FORBIDDEN"],
    ["unknown token", { token: fakeToken }, 401, "AUTH_INVALID"],
    ["wrong method", { token, method: "GET" }, 404, "UNKNOWN_COMMAND"],
  ];
  for (const [name, options, status, code] of cases) {
    const got = await f.send(call, { via: "direct", ...options });
    expect([name, got.status, got.code]).toEqual([name, status, code]);
  }
}, 30_000);

test("an unprovisioned project runs no SQL for a command", async () => {
  const f = fixture();
  const got = await f.send(call, { via: "direct", token: fakeToken });
  expect([got.status, got.code]).toEqual([401, "AUTH_INVALID"]);
  expect(f.snapshot()).toBe("[]");
}, 30_000);

test("an expired or revoked token ends the command, also during the body read", async () => {
  const f = fixture();
  const token = await f.device();
  const text = JSON.stringify(call);
  const slow = (between: () => void) =>
    new ReadableStream({
      start: (c) => c.enqueue(new TextEncoder().encode(text.slice(0, 9))),
      pull(c) {
        between();
        c.enqueue(new TextEncoder().encode(text.slice(9)));
        c.close();
      },
    });
  const revoke = () =>
    f.db
      .query("UPDATE domain_cloud_tokens SET revoked_at=? WHERE id=?")
      .run(f.now(), token.slice(4, 20));
  const during = await f.send(slow(revoke), { token });
  expect([during.status, during.code]).toEqual([401, "AUTH_REVOKED"]);
  const fresh = await f.device();
  const late = await f.send(
    slow(() => f.advance(2 * day)),
    { token: fresh },
  );
  expect([late.status, late.code]).toEqual([401, "AUTH_EXPIRED"]);
  const after = await f.send(call, { token: fresh });
  expect([after.status, after.code]).toEqual([401, "AUTH_EXPIRED"]);
}, 30_000);

test("a body over 512 KiB is refused at the limit and nothing is written", async () => {
  const f = fixture();
  const token = await f.device();
  const before = f.snapshot();
  const padded = (size: number) => `{"pad":"${"x".repeat(size)}"}`;
  const at = padded(limit - 10);
  expect(at.length).toBe(limit);
  for (const body of [padded(limit - 9), padded(limit * 2)]) {
    const got = await f.send(body, { token });
    expect([got.status, got.code, got.exit]).toEqual([400, "INPUT_INVALID", 6]);
    expect(got.json.error?.message).toContain(`${limit} bytes`);
  }
  for (const [body, message] of [
    [at, "body must be { requestId"],
    ["{not json", "body must be JSON"],
    ["", "body must be JSON"],
  ] as const) {
    const got = await f.send(body, { token });
    expect([got.status, got.code]).toEqual([400, "INPUT_INVALID"]);
    expect(got.json.error?.message).toContain(message);
  }
  expect(f.snapshot()).toBe(before);
}, 30_000);

test("a refused command on a cold object older than the login migration writes nothing", async () => {
  const f = fixture();
  const token = await f.device();
  for (const sql of [
    "DROP TABLE domain_cloud_login",
    "DELETE FROM state_migrations WHERE id='003_cloud_login'",
    "DELETE FROM state_domains WHERE table_name='domain_cloud_login'",
  ])
    f.db.query(sql).run();
  const before = f.snapshot();
  expect(before).not.toContain("domain_cloud_login");
  f.reopen();
  for (const [name, bearer, status, code] of [
    ["invented token", fakeToken, 401, "AUTH_INVALID"],
    ["valid token", token, 400, "INPUT_INVALID"],
  ] as const)
    for (const via of ["direct", createWorker()] as const) {
      const got = await f.send(call, { token: bearer, via });
      expect([name, got.status, got.code]).toEqual([name, status, code]);
      expect(f.snapshot()).toBe(before);
    }
  f.db.query("DROP TABLE domain_cloud_tokens").run();
  const gone = f.snapshot();
  const got = await f.send(call, { token, via: "direct" });
  expect([got.status, got.code]).toEqual([401, "AUTH_INVALID"]);
  expect(f.snapshot()).toBe(gone);
}, 30_000);

test("a streamed body is cut off at the limit before the rest is read", async () => {
  const f = fixture();
  const token = await f.device();
  const before = f.snapshot();
  const chunks = 20;
  for (const headers of [{}, { "content-length": "100" }]) {
    const seen = { pulled: 0, cancelled: false };
    const stream = new ReadableStream({
      pull(c) {
        if (seen.pulled++ < chunks) c.enqueue(new Uint8Array(65_536).fill(120));
        else c.close();
      },
      cancel() {
        seen.cancelled = true;
      },
    });
    const got = await f.send(stream, { token, headers });
    expect([got.status, got.code, got.exit]).toEqual([400, "INPUT_INVALID", 6]);
    expect(got.json.error?.message).toContain(`${limit} bytes`);
    expect(seen.cancelled).toBe(true);
    expect(seen.pulled).toBeLessThan(chunks);
    expect(f.snapshot()).toBe(before);
  }
}, 30_000);

// A refusal reads only the token row and the provisioned flag: no work state, write or setup.
const refusal = (
  name: string,
  got: {
    status: number;
    code?: string | undefined;
    exit: number;
    touched: string[];
  },
  want: [number, string, number],
) => {
  expect([name, got.status, got.code, got.exit]).toEqual([name, ...want]);
  expect(
    got.touched.filter(
      (call) =>
        call !== "get provisioned" &&
        !/^SELECT (name FROM sqlite_schema WHERE type='table' AND name=\?|\* FROM domain_cloud_tokens WHERE id=\?)$/.test(
          call,
        ),
    ),
  ).toEqual([]);
};
async function begin() {
  const f = fixture();
  return { f, token: await f.device(), before: f.snapshot() };
}
const marker = "leak-me";
const held = { actor, session: { id: "s1" }, leaseGeneration: 3 };
const deep = (levels: number) => {
  let value: unknown = [];
  for (let i = 1; i < levels; i++) value = [value];
  return value;
};
const allowed = [
  "issue.create",
  "issue.update",
  "issue.comment",
  "issue.show",
  "issue.comments",
  "issue.list",
  "issue.ready",
];

test("all seven allowed operations pass the envelope and context checks, then are refused", async () => {
  const { f, token, before } = await begin();
  const named = {
    actor,
    session: { id: "s1", device: "laptop" },
    device: { id: "laptop" },
    project: { id: "p" },
  };
  for (const [op, context] of [
    ...allowed.map(
      (op) => [op, op === "issue.update" ? held : { actor }] as const,
    ),
    ["issue.show", named],
  ] as const) {
    const got = await f.send({ ...call, op, context }, { token });
    refusal(op, got, [400, "INPUT_INVALID", 6]);
    expect(got.json.error?.message).toContain(refused);
  }
  expect(f.snapshot()).toBe(before);
}, 30_000);

test("a malformed or hostile envelope or context is refused and never echoed", async () => {
  const { f, token, before } = await begin();
  const { input: _input, ...noInput } = call;
  const { context: _context, ...noContext } = call;
  const context = (extra: Record<string, unknown>) => ({
    ...call,
    context: { actor, ...extra },
  });
  const cases: [string, unknown][] = [
    ["unknown field", { ...call, extra: marker }],
    ["array body", [marker]],
    ["bad request id", { ...call, requestId: `${marker} !` }],
    ["op not a string", { ...call, op: [marker] }],
    ["op named constructor", { ...call, op: "constructor" }],
    ["op named __proto__", { ...call, op: "__proto__" }],
    ["no input", noInput],
    ["no context", noContext],
    ["dryRun not a boolean", { ...call, dryRun: marker }],
    ["different project", context({ project: { id: marker } })],
    ["project root", context({ project: { id: "p", root: marker } })],
    ...["namespace", "clock", "variant", "leaseSubject"].map(
      (key): [string, unknown] => [
        `context ${key}`,
        context({ [key]: marker }),
      ],
    ),
  ];
  for (const [name, body] of cases) {
    const got = await f.send(body, { token });
    refusal(name, got, [400, "INPUT_INVALID", 6]);
    expect(JSON.stringify(got.json)).not.toContain(marker);
  }
  expect(f.snapshot()).toBe(before);
}, 30_000);

test("an op that is excluded, undeclared or prototype-like is unknown, even as a dry run", async () => {
  const { f, token, before } = await begin();
  const ops = [
    "issue.claim",
    "issue.delete",
    "lane.show",
    "constructor.constructor",
  ];
  for (const op of ops)
    for (const dryRun of [false, true])
      refusal(op, await f.send({ ...call, op, dryRun }, { token }), [
        404,
        "UNKNOWN_COMMAND",
        3,
      ]);
  expect(f.snapshot()).toBe(before);
}, 30_000);

test("a device the token does not name is refused without repeating it", async () => {
  const { f, token, before } = await begin();
  for (const context of [
    { actor, session: { id: "s1", device: marker } },
    { actor, device: { id: marker } },
  ]) {
    const got = await f.send({ ...call, context }, { token });
    refusal("device", got, [403, "AUTH_DEVICE_MISMATCH", 1]);
    expect(JSON.stringify(got.json)).not.toContain(marker);
  }
  expect(f.snapshot()).toBe(before);
}, 30_000);

test("a missing declared context is refused as CONTEXT_MISSING", async () => {
  const { f, token } = await begin();
  for (const [op, context] of [
    ["issue.show", {}],
    ["issue.update", { actor, session: { id: "s1" } }],
    ["issue.update", { actor, leaseGeneration: 3 }],
  ] as const)
    refusal(op, await f.send({ ...call, op, context }, { token }), [
      400,
      "CONTEXT_MISSING",
      6,
    ]);
}, 30_000);

test("nesting and value limits hold at the boundary and name the limit", async () => {
  const { f, token, before } = await begin();
  // The envelope is level 1 and holds 8 values of its own: the root, the request id, the op, the
  // input, the context, the actor and its two fields.
  const cases: [string, unknown, string][] = [
    ["32 levels", deep(31), refused],
    ["33 levels", deep(32), "maxDepth limit of 32"],
    ["5000 values", new Array(4992).fill(0), refused],
    ["5001 values", new Array(4993).fill(0), "maxNodes limit of 5000"],
    ["brackets inside a string", `${"[".repeat(100)}\\"{`, refused],
  ];
  for (const [name, input, message] of cases) {
    const got = await f.send({ ...call, input }, { token });
    refusal(name, got, [400, "INPUT_INVALID", 6]);
    expect(got.json.error?.message).toContain(message);
  }
  expect(f.snapshot()).toBe(before);
}, 30_000);

test("a dry run is unavailable before its context is bound and runs nothing", async () => {
  const { f, token, before } = await begin();
  for (const [op, context] of [
    ["issue.show", { actor }],
    ["issue.create", { actor }],
    ["issue.update", {}],
  ] as const)
    refusal(
      op,
      await f.send({ ...call, op, context, dryRun: true }, { token }),
      [503, "UNAVAILABLE", 1],
    );
  expect(f.snapshot()).toBe(before);
}, 30_000);

test("the server builds the effective context from what the operation declares", () => {
  const host = { device: "laptop", project: "p" };
  const prepared = (op: string, context: unknown) =>
    prepareCommand(JSON.stringify({ ...call, op, context }), host);
  const loose = {
    actor,
    session: { id: "s1", agent: "a", harness: "h" },
    device: { id: "laptop" },
    leaseGeneration: 9,
  };
  expect(prepared("issue.show", loose)).toEqual({
    op: "issue.show",
    input: call.input,
    context: { variant: "project", actor, project: { id: "p" } },
  });
  expect(
    prepared("issue.update", { ...loose, leaseGeneration: 3 }).context,
  ).toEqual({
    variant: "leased",
    leaseMode: "held",
    actor,
    session: { id: "s1", agent: "a", harness: "h", device: "laptop" },
    project: { id: "p" },
    leaseGeneration: 3,
  });
}, 30_000);
