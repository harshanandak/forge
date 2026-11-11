import { expect, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { Project } from "../../cloud/src/project.ts";
import {
  readOnlyStore,
  TABLE_PROBE,
  type DurableStorage,
} from "../../cloud/src/store.ts";
import { TOKEN_LOOKUP, TOKENS } from "../../cloud/src/tokens.ts";
import { prepareCommand } from "../../cloud/src/issue-commands.ts";
import { LEASE_READS, RECORD_READS } from "../../cloud/src/issue-read.ts";
import { createWorker } from "../../cloud/src/worker.ts";
import manifest from "../../src/blocks/work/forge.block.json" with { type: "json" };
import { createStateClient } from "../../src/assembly/state-client.ts";
import { StateOwner } from "../../src/core/state/index.ts";
import { stateMigrations } from "../../src/core/state/migrations.ts";
import type { SqlDatabase, SqlRow, SqlValue } from "../../src/ports/store.ts";
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
const vars = {
  FORGE_CLOUD_PROJECT: "p",
  ADMIN_TOKEN: "admin-secret",
  FORGE_CLOUD_ID_PREFIX: "forge",
};
const refused = "not yet supported in cloud";
interface Envelope {
  ok: boolean;
  op?: string;
  result?: unknown;
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

// Fixtures that share a registry are projects of one deployment: the id a name maps to picks the object.
function fixture(
  settings: Record<string, unknown> = vars,
  name = "p",
  registry = new Map<string, () => Project>(),
) {
  const env = { ...settings, FORGE_CLOUD_PROJECT: name };
  let t = start;
  spyOn(Date, "now").mockImplementation(() => t);
  const db = new Database(":memory:"),
    values = new Map<string, unknown>(),
    calls: string[] = [],
    probes: string[] = [];
  const storage: DurableStorage = {
    sql: {
      exec: (sql, ...bindings) => {
        calls.push(sql);
        if (sql === TABLE_PROBE) probes.push(bindings[0] as string);
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
  let project = new Project({ storage }, env);
  registry.set(name, () => project);
  const reached: string[] = [];
  const bindings = {
    ...env,
    PROJECTS: {
      idFromName: (name: string) => name,
      get: (id: unknown) => {
        reached.push(String(id));
        return registry.get(String(id))!();
      },
    },
  };
  async function send(body: unknown, o: Options = {}) {
    const request = new Request(
      `https://w.example/p/${o.name ?? name}/command`,
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
    probes.length = 0;
    const response =
      o.via === "direct"
        ? await project.fetch(request)
        : await (o.via ?? createWorker()).fetch(request, bindings as never);
    const text = await response.text();
    const json = JSON.parse(text) as Envelope;
    return {
      status: response.status,
      text,
      bytes: new TextEncoder().encode(text).length,
      type: response.headers.get("content-type"),
      probes: [...probes],
      json,
      code: json.error?.code,
      exit: exitCode(json as never),
      touched: [...calls],
    };
  }
  const device = async (ttlMs = day) => {
    const response = await createWorker().fetch(
      new Request(`https://w.example/p/${name}/devices`, {
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
    JSON.stringify({
      sql: (
        db
          .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY 1")
          .all() as { name: string }[]
      ).map(({ name }) => [name, db.query(`SELECT * FROM "${name}"`).all()]),
      kv: [...values.entries()].sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      ),
    });
  return {
    send,
    device,
    snapshot,
    reached,
    db,
    storage,
    calls,
    // The work tables, from the state owner's own migrations, and rows the way the owner stores them.
    tables: () => {
      for (const { statements } of stateMigrations)
        for (const sql of statements) db.run(sql);
    },
    put: (
      value: unknown,
      over: object = {},
      key = "issue:work-1",
      ns = "forge/work",
    ) =>
      db.run(
        "INSERT INTO state_records(namespace,key,revision,body) VALUES (?,?,3,?)",
        [
          ns,
          key,
          JSON.stringify({
            namespace: ns,
            key,
            revision: 3,
            value,
            updatedAt: iso(start - 500),
            updatedBy: actor,
            ...over,
          }),
        ],
      ),
    lease: (over: object = {}) => {
      db.run("DELETE FROM state_leases");
      db.run(
        "INSERT INTO state_leases(namespace,subject,generation,body) VALUES (?,?,2,?)",
        ["forge/work", "issue:work-1", JSON.stringify(grant(over))],
      );
    },
    reopen: () => {
      project = new Project({ storage }, env);
    },
    advance: (ms: number) => {
      t += ms;
    },
    now: () => t,
  };
}
const actor = { kind: "agent", id: "tester" } as const;
const iso = (ms: number) => new Date(ms).toISOString();
const stored = (over: object = {}) => ({
  id: "work-1",
  title: "Issue 1",
  status: "open",
  labels: ["a"],
  dependsOn: [],
  createdAt: iso(start - 1000),
  ...over,
});
const shown = (over: object = {}) => ({
  ...stored({ id: "forge-1" }),
  updatedAt: iso(start - 500),
  revision: 3,
  ...over,
});
const grant = (over: object = {}) => ({
  subject: "issue:work-1",
  holder: { actor, session: { id: "s1" } },
  generation: 2,
  expiresAt: iso(start + 1000),
  ...over,
});
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
const TOKEN_PROBE = [TOKENS];
// A show read adds only the two work-table probes and readIssue's own fixed statements.
const readCalls = (touched: string[]) =>
  strayCalls(touched).filter(
    (sql) =>
      !(RECORD_READS as readonly string[]).includes(sql) &&
      !(LEASE_READS as readonly string[]).includes(sql),
  );
// A refusal reads only the token row and the provisioned flag: no work state, write or setup.
const strayCalls = (touched: string[]) =>
  touched.filter(
    (call) =>
      call !== "get provisioned" &&
      !/^SELECT (name FROM sqlite_schema WHERE type='table' AND name=\?|\* FROM domain_cloud_tokens WHERE id=\?)$/.test(
        call,
      ),
  );

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
      expect(strayCalls(got.touched)).toEqual([]);
    }
    expect(f.reached).toEqual([]);
    expect(f.snapshot()).toBe(before);
    const ok = await f.send(call, { token, via: via() });
    expect([ok.status, ok.code, ok.exit, f.reached]).toEqual([
      404,
      "NOT_FOUND",
      3,
      ["p"],
    ]);
    expect(ok.json.error?.message).toBe("Issue was not found");
    expect(readCalls(ok.touched)).toEqual([]);
    expect(ok.probes).toEqual([TOKENS, "state_records"]);
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
    expect(strayCalls(got.touched)).toEqual([]);
  }
}, 30_000);

test("an unprovisioned project runs no SQL for a command", async () => {
  const f = fixture();
  const got = await f.send(call, { via: "direct", token: fakeToken });
  expect([got.status, got.code]).toEqual([401, "AUTH_INVALID"]);
  expect(strayCalls(got.touched)).toEqual([]);
  expect(f.snapshot()).toBe('{"sql":[],"kv":[]}');
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
  expect(strayCalls(during.touched)).toEqual([]);
  const fresh = await f.device();
  const late = await f.send(
    slow(() => f.advance(2 * day)),
    { token: fresh },
  );
  expect([late.status, late.code]).toEqual([401, "AUTH_EXPIRED"]);
  expect(strayCalls(late.touched)).toEqual([]);
  const after = await f.send(call, { token: fresh });
  expect([after.status, after.code]).toEqual([401, "AUTH_EXPIRED"]);
  expect(strayCalls(after.touched)).toEqual([]);
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
    expect(strayCalls(got.touched)).toEqual([]);
  }
  for (const [body, message] of [
    [at, "body must be { requestId"],
    ["{not json", "body must be JSON"],
    ["", "body must be JSON"],
  ] as const) {
    const got = await f.send(body, { token });
    expect([got.status, got.code]).toEqual([400, "INPUT_INVALID"]);
    expect(got.json.error?.message).toContain(message);
    expect(strayCalls(got.touched)).toEqual([]);
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
    ["valid token", token, 404, "NOT_FOUND"],
  ] as const)
    for (const via of ["direct", createWorker()] as const) {
      const got = await f.send(call, { token: bearer, via });
      expect([name, got.status, got.code]).toEqual([name, status, code]);
      expect(readCalls(got.touched)).toEqual([]);
      expect(f.snapshot()).toBe(before);
    }
  f.db.query("DROP TABLE domain_cloud_tokens").run();
  const gone = f.snapshot();
  const got = await f.send(call, { token, via: "direct" });
  expect([got.status, got.code]).toEqual([401, "AUTH_INVALID"]);
  expect(strayCalls(got.touched)).toEqual([]);
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
    expect(strayCalls(got.touched)).toEqual([]);
    expect(f.snapshot()).toBe(before);
  }
}, 30_000);

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
  expect(strayCalls(got.touched)).toEqual([]);
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
  "issue.comments",
  "issue.list",
  "issue.ready",
];

test("the six other allowed operations pass the envelope and context checks, then are refused", async () => {
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
    ["issue.list", named],
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
    expect(got.json.error?.message).toContain("must be");
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
    const got = await f.send({ ...call, op: "issue.list", input }, { token });
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

test("an exposed op missing from the manifest fails closed as UNKNOWN_COMMAND", async () => {
  const { f, token, before } = await begin();
  // No await while the shared manifest is changed: the whole mutation is synchronous.
  const operations = manifest.operations as unknown as Record<string, unknown>;
  const declared = operations["issue.show"];
  delete operations["issue.show"];
  try {
    // Direct: the envelope step takes only a device and a project, never a storage capability.
    expect(() =>
      prepareCommand(JSON.stringify(call), { device: "laptop", project: "p" }),
    ).toThrow("UNKNOWN_COMMAND: No such command");
  } finally {
    operations["issue.show"] = declared;
  }
  expect(f.snapshot()).toBe(before);
  const restored = await f.send(call, { token });
  expect([restored.status, restored.code, restored.exit]).toEqual([
    404,
    "NOT_FOUND",
    3,
  ]);
  expect(restored.json.error?.message).toBe("Issue was not found");
  expect(readCalls(restored.touched)).toEqual([]);
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

const WORK_PROBES = [TOKENS, "state_records", "state_leases"];
const bytesOf = (text: string) => new TextEncoder().encode(text).length;
const envelope = (result: unknown) =>
  JSON.stringify({
    ok: true,
    op: "issue.show",
    status: "OK",
    result,
    warnings: [],
  });

test("issue.show returns the stored issue through the Worker and the object, with a lease only while live", async () => {
  const f = fixture();
  const token = await f.device();
  f.tables();
  f.put(stored());
  for (const [name, over, live] of [
    ["none", undefined, false],
    ["live", { expiresAt: iso(start + 1) }, true],
    ["exactly at expiry", { expiresAt: iso(start) }, false],
    ["expired", { expiresAt: iso(start - 1) }, false],
    ["released", { releasedAt: iso(start - 5) }, false],
  ] as const) {
    if (over === undefined) f.db.run("DELETE FROM state_leases");
    else f.lease(over);
    const before = f.snapshot();
    for (const via of ["direct", createWorker()] as const) {
      const got = await f.send(call, { token, via });
      expect([name, got.status, got.json.ok, got.json.op]).toEqual([
        name,
        200,
        true,
        "issue.show",
      ]);
      expect([name, got.json.result]).toEqual([
        name,
        shown(live ? { lease: grant(over) } : {}),
      ]);
      expect(got.type).toContain("application/json");
      expect(readCalls(got.touched)).toEqual([]);
      expect(got.probes).toEqual(WORK_PROBES);
      expect(f.snapshot()).toBe(before);
    }
  }
}, 30_000);

test("the response is capped at 1 MiB of UTF-8 bytes, measured on the whole envelope", async () => {
  const cap = 1_048_576;
  const f = fixture();
  const token = await f.device();
  f.tables();
  // Two-byte, escaped and three-byte characters, so characters and bytes differ.
  const body = 'é"\n✓\\';
  const room = cap - bytesOf(envelope(shown({ body, kind: "" })));
  for (const [delta, fits] of [
    [-1, true],
    [0, true],
    [1, false],
  ] as const) {
    const kind = "k".repeat(room + delta);
    f.db.run("DELETE FROM state_records");
    f.put(stored({ body, kind }));
    const before = f.snapshot();
    const got = await f.send(call, { token });
    expect(got.probes).toEqual(WORK_PROBES);
    expect(f.snapshot()).toBe(before);
    if (fits) {
      expect([got.status, got.bytes]).toEqual([200, cap + delta]);
      expect(got.json.result).toEqual(shown({ body, kind }));
      expect(got.text).toBe(JSON.stringify(got.json));
    } else {
      expect([got.status, got.code, got.exit]).toEqual([503, "UNAVAILABLE", 1]);
      expect(got.json.error?.message).toContain("response too large");
      expect(got.bytes).toBeLessThan(1000);
    }
  }
}, 60_000);

test("show refuses a missing issue, an unknown prefix, bad input and a corrupt record, reading only what it needs", async () => {
  for (const [name, input, over, want, probes] of [
    ["missing number", { id: "forge-2" }, {}, [404, "NOT_FOUND", 3], 2],
    ["unknown prefix", { id: "acme-1" }, {}, [400, "INPUT_INVALID", 6], 2],
    [
      "extra field",
      { id: "forge-1", extra: marker },
      {},
      [400, "INPUT_INVALID", 6],
      1,
    ],
    [
      "wrong-typed revision",
      { id: "forge-1" },
      { revision: "x" },
      [500, "INTERNAL", 1],
      3,
    ],
  ] as const) {
    const f = fixture();
    const token = await f.device();
    f.tables();
    f.put(stored({ title: marker }), over);
    const before = f.snapshot();
    const got = await f.send({ ...call, input }, { token });
    expect([name, got.status, got.code, got.exit]).toEqual([name, ...want]);
    expect(JSON.stringify(got.json)).not.toContain(marker);
    expect(readCalls(got.touched)).toEqual([]);
    expect(got.probes).toEqual(WORK_PROBES.slice(0, probes));
    expect(f.snapshot()).toBe(before);
  }
}, 30_000);

test("a missing or invalid configured prefix is UNAVAILABLE and no work table is probed or read", async () => {
  for (const prefix of [undefined, "", "Forge", "x".repeat(33), 5]) {
    const f = fixture({ ...vars, FORGE_CLOUD_ID_PREFIX: prefix });
    const token = await f.device();
    f.tables();
    f.put(stored());
    const before = f.snapshot();
    for (const via of ["direct", createWorker()] as const) {
      const got = await f.send(call, { token, via });
      expect([got.status, got.code, got.exit]).toEqual([503, "UNAVAILABLE", 1]);
      expect(got.json.error?.message).toBe("Server configuration is not valid");
      expect(strayCalls(got.touched)).toEqual([]);
      expect(got.probes).toEqual([TOKENS]);
    }
    expect(f.snapshot()).toBe(before);
  }
}, 30_000);

test("a token revoked or expired after the first check, while the body is held, ends the command before any work read", async () => {
  const f = fixture();
  f.tables();
  f.put(stored());
  const text = JSON.stringify(call);
  // The rest of the body and the change are released only after the first token lookup has run.
  const held = async (token: string, between: () => void) => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stream = new ReadableStream({
      start: (c) => c.enqueue(new TextEncoder().encode(text.slice(0, 9))),
      async pull(c) {
        await gate;
        c.enqueue(new TextEncoder().encode(text.slice(9)));
        c.close();
      },
    });
    const pending = f.send(stream, { token });
    while (!f.calls.includes(TOKEN_LOOKUP))
      await new Promise((resolve) => setTimeout(resolve, 0));
    between();
    release();
    return pending;
  };
  let after = "";
  const revoked = await f.device();
  for (const got of [
    await f.send(call, { token: revoked }),
    await held(revoked, () => {}),
  ])
    expect([got.status, got.json.ok, got.probes]).toEqual([
      200,
      true,
      WORK_PROBES,
    ]);
  const cases: [string, string, () => void, string][] = [
    [
      "revoked",
      revoked,
      () =>
        f.db
          .query("UPDATE domain_cloud_tokens SET revoked_at=? WHERE id=?")
          .run(f.now(), revoked.slice(4, 20)),
      "AUTH_REVOKED",
    ],
    ["expired", await f.device(), () => f.advance(2 * day), "AUTH_EXPIRED"],
  ];
  for (const [name, token, change, code] of cases) {
    const got = await held(token, () => {
      change();
      after = f.snapshot();
    });
    expect([name, got.status, got.code, got.exit]).toEqual([
      name,
      401,
      code,
      1,
    ]);
    expect(got.probes).toEqual(TOKEN_PROBE);
    expect(got.touched.filter((sql) => sql.includes("state_"))).toEqual([]);
    expect(f.snapshot()).toBe(after);
  }
}, 30_000);

type F = ReturnType<typeof fixture>;
const globals = globalThis as Record<string, unknown>;
type Handler = (call: {
  input: unknown;
  config: unknown;
  services: unknown;
}) => unknown;

// The local handler reads only the owner's point, list (with and without an upper bound) and lease
// SELECTs, as exact statements. Any other statement is refused and recorded.
const OWNER_READS = new Set([
  "SELECT body FROM state_records WHERE namespace=? AND key=?",
  "SELECT body FROM state_records WHERE namespace=? AND key>=? AND key<? ORDER BY key",
  "SELECT body FROM state_records WHERE namespace=? AND key>=? ORDER BY key",
  "SELECT body FROM state_leases WHERE namespace=? AND subject=?",
]);
const readView = (db: Database, refused: string[]): SqlDatabase => {
  const deny = (what: string) => (): never => {
    refused.push(what);
    throw new Error(`${what} refused`);
  };
  const read = (sql: string, params: readonly SqlValue[] = []) => {
    if (!OWNER_READS.has(sql)) deny(sql)();
    return db.query(sql).all(...(params as never[])) as SqlRow[];
  };
  return {
    exec: deny("exec"),
    run: deny("run"),
    transaction: deny("transaction"),
    all: read,
    get: (sql, params) => read(sql, params)[0],
  };
};

test("the cloud issue.show agrees with the local handler on aliases, case, historical prefixes and leading zeros", async () => {
  const hadFail = "fail" in globals,
    previous = globals.fail;
  globals.fail = (code: string, message: string) => {
    throw new Error(`${code}: ${message}`);
  };
  try {
    const handlers = require(
      resolve(import.meta.dirname, "../../src/blocks/work/entry.cts"),
    ) as Record<string, Handler>;
    const f = fixture();
    const token = await f.device();
    f.tables();
    f.put(
      stored({
        prefix: "acme",
        kind: "task",
        body: "b",
        parent: "work-2",
        dependsOn: ["work-2"],
      }),
    );
    f.put(stored({ id: "work-2", title: "Issue 2" }), {}, "issue:work-2");
    f.put(stored({ id: "work-007", prefix: "old" }), {}, "issue:work-007");
    const refused: string[] = [];
    const state = createStateClient({
      owner: new StateOwner(readView(f.db, refused), { now: f.now }),
      namespace: "forge/work",
      context: { variant: "project", actor, project: { id: "p" } },
      write: false,
      requestId: "oracle",
    });
    const before = f.snapshot();
    const ids = [
      ...[
        "forge-1",
        "FORGE-1",
        "acme-1",
        "ACME-1",
        "work-1",
        "work-2",
        "Work-2",
      ],
      ...["acme-2", "forge-007", "work-007", "old-007"],
      ...["forge-7", "forge-0001", "forge-3", "zzz-1"],
    ];
    const refusal = (code: string) => ({
      code,
      exit: exitCode({
        ok: false,
        status: "FAIL",
        error: { code, message: "", retry: "never" },
        warnings: [],
      } as never),
    });
    const outcomes = [];
    for (const id of ids) {
      const cloud = await f.send({ ...call, input: { id } }, { token });
      let local;
      try {
        local = {
          result: handlers["issue.show"]!({
            input: { id },
            config: { idPrefix: "forge" },
            services: { state },
          }),
        };
      } catch (error) {
        local = refusal((error as Error).message.split(":")[0]!);
      }
      const here = cloud.json.ok
        ? { result: cloud.json.result }
        : refusal(cloud.code!);
      expect([id, here]).toEqual([id, local]);
      outcomes.push(here);
    }
    // Both sides must not simply fail alike: 11 shown, 3 not found, 1 unknown prefix.
    expect(outcomes.filter((o) => "result" in o)).toHaveLength(11);
    expect(outcomes.map((o) => ("code" in o ? o.code : "")).join()).toBe(
      ",,,,,,,,,,,NOT_FOUND,NOT_FOUND,NOT_FOUND,INPUT_INVALID",
    );
    expect(refused).toEqual([]);
    expect(f.snapshot()).toBe(before);
  } finally {
    if (hadFail) globals.fail = previous;
    else delete globals.fail;
  }
}, 30_000);

test("a lease stored inside the issue is never shown: only a live state_leases row is", async () => {
  const f = fixture();
  const token = await f.device();
  f.tables();
  const holder = { actor, session: { id: marker } };
  f.put(stored({ lease: grant({ holder, expiresAt: iso(start + day) }) }));
  const live = { expiresAt: iso(start + 1) };
  for (const [row, want] of [
    [undefined, shown()],
    [live, shown({ lease: grant(live) })],
  ] as const) {
    if (row) f.lease(row);
    const before = f.snapshot();
    const got = await f.send(call, { token });
    expect([got.status, got.json.result]).toEqual([200, want]);
    expect(JSON.stringify(got.json)).not.toContain(marker);
    expect(f.snapshot()).toBe(before);
  }
}, 30_000);

const gone = "Issue was not found";
const notValid = "Stored issue is not valid";
const unproven =
  "Competing and collaborative issues are not yet supported in cloud";
const replaced = (f: F, value: unknown, over: object = {}) => {
  f.db.run("DELETE FROM state_records");
  f.put(value, over);
};
const bad = { title: marker };

test("a missing table, a mode record, a mismatched row or a foreign namespace is refused as mapped, reading only what it needs", async () => {
  const input = call.input;
  const rows: [
    string,
    (f: F) => void,
    object,
    [number, string?, number?],
    number,
    string?,
  ][] = [
    [
      "no leases table",
      (f) => f.db.run("DROP TABLE state_leases"),
      input,
      [200],
      3,
    ],
    [
      "no records table",
      (f) => f.db.run("DROP TABLE state_records"),
      input,
      [404, "NOT_FOUND", 3],
      2,
      gone,
    ],
    [
      "no records table, alias",
      (f) => f.db.run("DROP TABLE state_records"),
      { id: "acme-1" },
      [400, "INPUT_INVALID", 6],
      2,
      "Unknown issue id prefix",
    ],
    [
      "slots only",
      (f) => f.put({ count: 2 }, {}, "slots:work-1"),
      input,
      [400, "INPUT_INVALID", 6],
      2,
      unproven,
    ],
    [
      "participant only",
      (f) => f.put({}, {}, "participant:work-1:1"),
      input,
      [400, "INPUT_INVALID", 6],
      2,
      unproven,
    ],
    [
      "record key mismatch",
      (f) => replaced(f, stored(bad), { key: "issue:work-2" }),
      input,
      [500, "INTERNAL", 1],
      2,
      notValid,
    ],
    [
      "record namespace mismatch",
      (f) => replaced(f, stored(bad), { namespace: "forge/other" }),
      input,
      [500, "INTERNAL", 1],
      2,
      notValid,
    ],
    [
      "record id mismatch",
      (f) => replaced(f, stored({ id: "work-2", ...bad })),
      input,
      [500, "INTERNAL", 1],
      2,
      notValid,
    ],
    [
      "lease subject mismatch",
      (f) => f.lease({ subject: "issue:work-9" }),
      input,
      [500, "INTERNAL", 1],
      3,
      notValid,
    ],
    [
      "issue only in another namespace",
      (f) => {
        f.db.run("DELETE FROM state_records");
        f.put(stored(bad), {}, "issue:work-1", "forge/other");
      },
      input,
      [404, "NOT_FOUND", 3],
      2,
      gone,
    ],
    [
      "mode record only in another namespace",
      (f) => f.put({ count: 2 }, {}, "slots:work-1", "forge/other"),
      input,
      [200],
      3,
    ],
  ];
  for (const [
    name,
    setup,
    body,
    [status, code, exit = 0],
    probes,
    message,
  ] of rows) {
    const f = fixture();
    const token = await f.device();
    f.tables();
    f.put(stored(bad));
    setup(f);
    const before = f.snapshot();
    const got = await f.send({ ...call, input: body }, { token });
    expect([name, got.status, got.code, got.exit]).toEqual([
      name,
      status,
      code,
      exit,
    ]);
    expect(readCalls(got.touched)).toEqual([]);
    expect(got.probes).toEqual(WORK_PROBES.slice(0, probes));
    if (message === undefined) expect(got.json.result).toEqual(shown(bad));
    else {
      expect(got.json.error?.message).toBe(message);
      expect(JSON.stringify(got.json)).not.toContain(marker);
    }
    expect(f.snapshot()).toBe(before);
  }
}, 60_000);

test("two projects with distinct names and one id-indexed binding each see only their own, and a token opens only its own", async () => {
  const registry = new Map<string, () => Project>();
  const [a, b] = [
    fixture(vars, "alpha", registry),
    fixture(vars, "beta", registry),
  ];
  const [ta, tb] = [await a.device(), await b.device()];
  for (const [f, title] of [
    [a, "alpha"],
    [b, "beta"],
  ] as const) {
    f.tables();
    f.put(stored({ title }));
  }
  const before = [a.snapshot(), b.snapshot()];
  const [ga, gb] = [
    await a.send(call, { token: ta }),
    await b.send(call, { token: tb }),
  ];
  expect([ga.json.result, gb.json.result, a.reached, b.reached]).toEqual([
    shown({ title: "alpha" }),
    shown({ title: "beta" }),
    ["alpha"],
    ["beta"],
  ]);
  for (const cross of [
    await b.send(call, { token: ta }),
    await a.send(call, { token: tb }),
  ])
    expect([cross.status, cross.code]).toEqual([401, "AUTH_INVALID"]);
  expect([a.snapshot(), b.snapshot()]).toEqual(before);
}, 30_000);

const READ_ONLY = "This view is read-only";
const missingId = "0000000000000000";
const DEVICE_ONLY = `SELECT device FROM ${TOKENS} WHERE id=?`;
const thrown = (body: () => unknown) => {
  try {
    body();
  } catch (error) {
    return (error as Error).message;
  }
  return "did not throw";
};
async function viewOf(statements: readonly string[]) {
  const f = fixture();
  const id = (await f.device()).slice(4, 20);
  const view = readOnlyStore(f.storage, TOKENS, statements)!;
  f.calls.length = 0;
  return { f, id, view };
}

test("a read-only view runs an allowed statement through get and all", async () => {
  const { f, id, view } = await viewOf([TOKEN_LOOKUP, DEVICE_ONLY]);
  const before = f.snapshot();
  const row = f.db.query(TOKEN_LOOKUP).get(id);
  expect(row).toMatchObject({ id, device: "laptop", revoked_at: null });
  expect(view.get(TOKEN_LOOKUP, [id])).toEqual(row as never);
  expect(view.all(TOKEN_LOOKUP, [id])).toEqual([row] as never);
  expect(view.get(TOKEN_LOOKUP, [missingId])).toBeUndefined();
  expect(view.all(TOKEN_LOOKUP, [missingId])).toEqual([]);
  expect(view.get(DEVICE_ONLY, [id])).toEqual({ device: "laptop" });
  expect(f.calls).toHaveLength(5);
  expect(f.snapshot()).toBe(before);
}, 30_000);

test("bound values stay values, whatever text they hold", async () => {
  const { f, id, view } = await viewOf([TOKEN_LOOKUP]);
  const before = f.snapshot();
  for (const hostile of [
    `${id}' OR '1'='1`,
    `'; DROP TABLE ${TOKENS}; --`,
    `" OR 1=1 --`,
    "%",
  ]) {
    f.calls.length = 0;
    expect(view.get(TOKEN_LOOKUP, [hostile])).toBeUndefined();
    expect(view.all(TOKEN_LOOKUP, [hostile])).toEqual([]);
    expect(f.calls).toEqual([TOKEN_LOOKUP, TOKEN_LOOKUP]);
  }
  expect(f.snapshot()).toBe(before);
}, 30_000);

const refusals: [string, (id: string) => [string, unknown[]]][] = [
  [
    "a DELETE of a seeded row",
    (id) => [`DELETE FROM ${TOKENS} WHERE id=? RETURNING *`, [id]],
  ],
  [
    "a valid INSERT with a fresh id",
    () => [
      `INSERT INTO ${TOKENS} (id, hash, device, expires_at) VALUES (?, ?, ?, ?) RETURNING *`,
      ["ffffffffffffffff", "h", "other", 1],
    ],
  ],
  ["a trailing space", (id) => [`${TOKEN_LOOKUP} `, [id]]],
  ["a doubled space", (id) => [TOKEN_LOOKUP.replace(" ", "  "), [id]]],
  ["a leading newline", (id) => [`\n${TOKEN_LOOKUP}`, [id]]],
  ["lower case", (id) => [TOKEN_LOOKUP.toLowerCase(), [id]]],
  [
    "a lower-case keyword",
    (id) => [TOKEN_LOOKUP.replace("SELECT", "select"), [id]],
  ],
  ["an unlisted read", () => ["SELECT * FROM sqlite_schema", []]],
  ["the table probe", () => [TABLE_PROBE, [TOKENS]]],
];
for (const [name, build] of refusals)
  test(`a read-only view refuses ${name} before storage sees it`, async () => {
    const { f, id, view } = await viewOf([TOKEN_LOOKUP]);
    const [statement, params] = build(id);
    for (const method of ["get", "all"] as const) {
      const before = f.snapshot();
      f.calls.length = 0;
      expect(thrown(() => view[method](statement, params as never))).toBe(
        READ_ONLY,
      );
      expect(f.calls).toEqual([]);
      expect(f.snapshot()).toBe(before);
    }
  }, 30_000);

test("an empty allowlist refuses every statement", async () => {
  const { f, id, view } = await viewOf([]);
  const before = f.snapshot();
  for (const method of ["get", "all"] as const)
    expect(thrown(() => view[method](TOKEN_LOOKUP, [id]))).toBe(READ_ONLY);
  expect(f.calls).toEqual([]);
  expect(f.snapshot()).toBe(before);
}, 30_000);

test("changing the allowlist array after construction grants nothing", async () => {
  const list = [TOKEN_LOOKUP];
  const { f, id, view } = await viewOf(list);
  const drop = `DELETE FROM ${TOKENS} WHERE id=? RETURNING *`;
  const before = f.snapshot();
  list.push(drop);
  for (const method of ["get", "all"] as const)
    expect(thrown(() => view[method](drop, [id]))).toBe(READ_ONLY);
  list.length = 0;
  expect(view.get(TOKEN_LOOKUP, [id])).toMatchObject({ id });
  expect(f.calls).toEqual([TOKEN_LOOKUP]);
  expect(f.snapshot()).toBe(before);
}, 30_000);

test("exec, run and transaction stay refused even with an allowed statement", async () => {
  const { f, id, view } = await viewOf([TOKEN_LOOKUP]);
  const body = mock(() => view.all(TOKEN_LOOKUP, [id]));
  const before = f.snapshot();
  for (const attempt of [
    () => view.exec(TOKEN_LOOKUP),
    () => view.run(TOKEN_LOOKUP, [id]),
    () => view.transaction(body),
  ])
    expect(thrown(attempt)).toBe(READ_ONLY);
  expect(body).not.toHaveBeenCalled();
  expect(f.calls).toEqual([]);
  expect(f.snapshot()).toBe(before);
}, 30_000);

test("a view of a missing table runs only the probe and creates nothing", async () => {
  const f = fixture();
  await f.device();
  const seen: unknown[][] = [];
  const spied: DurableStorage = {
    ...f.storage,
    sql: {
      exec: (statement, ...bindings) => {
        seen.push([statement, ...bindings]);
        return f.storage.sql.exec(statement, ...bindings);
      },
    },
  };
  const schema = () => f.db.query("SELECT * FROM sqlite_schema").all();
  const before = schema();
  expect(readOnlyStore(spied, "domain_cloud_missing", [TOKEN_LOOKUP])).toBe(
    undefined,
  );
  expect(seen).toEqual([[TABLE_PROBE, "domain_cloud_missing"]]);
  expect(schema()).toEqual(before);
}, 30_000);
