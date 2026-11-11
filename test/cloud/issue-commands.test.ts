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
import { MAX_RECEIPTS } from "../../cloud/src/issue-receipts.ts";
import { listIssues } from "../../cloud/src/issue-list.ts";
import { commentIssue } from "../../cloud/src/issue-comment.ts";
import { createIssue } from "../../cloud/src/issue-create.ts";
import { updateIssue } from "../../cloud/src/issue-update.ts";
import {
  LEASE_READS,
  RECORD_READS,
  ROWS,
  type IssueViews,
} from "../../cloud/src/issue-read.ts";
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
  const device = async (ttlMs = day, who = "laptop", session?: string) => {
    const response = await createWorker().fetch(
      new Request(`https://w.example/p/${name}/devices`, {
        method: "POST",
        headers: { authorization: `Bearer ${vars.ADMIN_TOKEN}` },
        body: JSON.stringify({
          device: who,
          ttlMs,
          ...(session === undefined ? {} : { session }),
        }),
      }),
      bindings,
    );
    reached.length = 0;
    return ((await response.json()) as Envelope).value!.token;
  };
  const dump = async () =>
    (
      await createWorker().fetch(
        new Request(`https://w.example/p/${name}/dump`, {
          headers: { authorization: `Bearer ${vars.ADMIN_TOKEN}` },
        }),
        bindings,
      )
    ).text();
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
    dump,
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
    lease: (over: object = {}, subject = "issue:work-1") => {
      const body = grant({ subject, ...over });
      db.run("DELETE FROM state_leases WHERE subject=?", [subject]);
      db.run(
        "INSERT INTO state_leases(namespace,subject,generation,body) VALUES (?,?,?,?)",
        [
          "forge/work",
          subject,
          Number.isInteger(body.generation) ? body.generation : 2,
          JSON.stringify(body),
        ],
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
const deep = (levels: number) => {
  let value: unknown = [];
  for (let i = 1; i < levels; i++) value = [value];
  return value;
};
const allowed = ["issue.comments"];

test("the other allowed operation passes the envelope and context checks, then is refused", async () => {
  const { f, token, before } = await begin();
  const named = {
    actor,
    session: { id: "s1", device: "laptop" },
    device: { id: "laptop" },
    project: { id: "p" },
  };
  for (const [op, context] of [
    ...allowed.map((op) => [op, { actor }] as const),
    ["issue.comments", named],
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
    const got = await f.send(
      { ...call, op: "issue.comments", input },
      { token },
    );
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
    ["issue.comment", { actor }],
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
const envelope = (result: unknown, op = "issue.show") =>
  JSON.stringify({
    ok: true,
    op,
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

// The same barrier for each read: `body` is the show or the list command.
async function barrier(body: object) {
  const f = fixture();
  f.tables();
  f.put(stored());
  const text = JSON.stringify(body);
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
    await f.send(body, { token: revoked }),
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
}

for (const op of ["issue.show", "issue.list"])
  test(
    `a token revoked or expired after the first check, while the ${op} body is held, ends the command before any work read`,
    () =>
      barrier({ ...call, op, input: op === "issue.show" ? call.input : {} }),
    30_000,
  );

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

test("the cloud issue.list agrees with the local handler on order, limit, truncation and live leases", async () => {
  const hadFail = "fail" in globals,
    previous = globals.fail;
  globals.fail = (code: string, message: string) => {
    throw new Error(`${code}: ${message}`);
  };
  try {
    const handlers = require(
      resolve(import.meta.dirname, "../../src/blocks/work/entry.cts"),
    ) as Record<string, Handler>;
    // The cloud route and the local handler read the same rows, clock and config.
    const config = { idPrefix: "forge", labelOrder: [] };
    const both = async (f: F, token: string, input: unknown) => {
      const refused: string[] = [];
      const state = createStateClient({
        owner: new StateOwner(readView(f.db, refused), { now: f.now }),
        namespace: "forge/work",
        context: { variant: "project", actor, project: { id: "p" } },
        write: false,
        requestId: "oracle",
      });
      const before = f.snapshot();
      const cloud = await f.send(
        { ...call, op: "issue.list", input },
        { token },
      );
      const local = (() => {
        try {
          return handlers["issue.list"]!({
            input,
            config,
            services: { state },
          });
        } catch (error) {
          return { code: String(error).split(":")[1]!.trim() };
        }
      })();
      const result: unknown = cloud.json.result ?? { code: cloud.code };
      expect(result).toEqual(local);
      expect([refused, f.snapshot()]).toEqual([[], before]);
      return { items: [], truncated: false, ...(result as object) } as {
        items: { id: string }[];
        truncated: boolean;
        code?: string;
      };
    };
    const f = fixture();
    const token = await f.device();
    f.tables();
    f.put(stored({ prefix: "acme", parent: "work-2", dependsOn: ["work-2"] }));
    f.put(stored({ id: "work-2", status: "closed" }), {}, "issue:work-2");
    f.put(stored({ id: "work-3" }), {}, "issue:work-3");
    f.put(stored({ id: "work-10", title: "Issue 10" }), {}, "issue:work-10");
    f.lease({ expiresAt: iso(start + 1) }, "issue:work-3");
    f.lease({ expiresAt: iso(start - 1) }, "issue:work-2");
    // Key order, as stored: work-10 sorts before work-2.
    const order = ["forge-1", "forge-10", "forge-2", "forge-3"];
    for (const [input, count, truncated] of [
      [{}, 4, false],
      [{ limit: 1 }, 1, true],
      [{ limit: 3 }, 3, true],
      [{ limit: 4 }, 4, false],
      [{ limit: 1000 }, 4, false],
    ] as const) {
      const got = await both(f, token, input);
      expect([got.items.map((i) => i.id), got.truncated]).toEqual([
        order.slice(0, count),
        truncated,
      ]);
    }
    const all = await both(f, token, {});
    expect(all.items.map((i) => "lease" in i)).toEqual([
      false,
      false,
      false,
      true,
    ]);
    // Filters and ready:true: work-1 is blocked by a missing issue, 2 and 9 are closed, 3 is held,
    // 5 depends on itself, 6 and 7 on each other, 8 on a closed issue that depends back on it, and
    // 10 to 12 hold an expired, a just-expired and a released lease.
    const g = fixture();
    const gt = await g.device();
    g.tables();
    const put = (n: number, over: object = {}, lease?: object) => {
      g.put(stored({ id: `work-${n}`, ...over }), {}, `issue:work-${n}`);
      if (lease) g.lease(lease, `issue:work-${n}`);
    };
    put(1, {
      prefix: "acme",
      kind: "task",
      labels: ["a", "b"],
      dependsOn: ["work-99"],
    });
    put(2, { status: "closed", kind: "task" });
    put(
      3,
      {
        parent: "work-2",
        kind: "bug",
        labels: ["b"],
        createdAt: iso(start - 500),
      },
      { expiresAt: iso(start + 1) },
    );
    put(4, {
      parent: "work-2",
      kind: "task",
      labels: ["a", "b"],
      createdAt: iso(start),
      dependsOn: ["work-2"],
    });
    put(5, { dependsOn: ["work-5"] });
    put(6, { dependsOn: ["work-7"] });
    put(7, { dependsOn: ["work-6"] });
    put(8, { dependsOn: ["work-9"] });
    put(9, { status: "closed", dependsOn: ["work-8"] });
    put(10, {}, { expiresAt: iso(start - 1) });
    put(11, {}, { expiresAt: iso(start) });
    put(12, {}, { releasedAt: iso(start - 5), expiresAt: iso(start + day) });
    // The ids returned, `+` when truncated, or the code of the refusal.
    for (const [input, want] of [
      [{ ready: false }, "1,10,11,12,2,3,4,5,6,7,8,9"],
      [{ parent: "forge-2" }, "3,4"],
      [{ parent: "acme-2" }, "3,4"],
      [{ parent: "work-2" }, "3,4"],
      [{ parent: "FORGE-2" }, "3,4"],
      [{ parent: "forge-002" }, ""],
      [{ parent: "none" }, "1,10,11,12,2,5,6,7,8,9"],
      [{ parent: "zzz-2" }, "INPUT_INVALID"],
      [{ parent: "bad" }, "INPUT_INVALID"],
      [{ kind: "bug" }, "3"],
      [{ kind: "task", limit: 2 }, "1,2+"],
      [{ label: ["b"] }, "1,3,4"],
      [{ labels: ["a", "b"] }, "1,4"],
      [{ label: ["a"], labels: ["b"] }, "1,4"],
      [{ label: [], labels: [] }, "1,10,11,12,2,3,4,5,6,7,8,9"],
      [{ status: "closed" }, "2,9"],
      [{ createdSince: iso(start - 1000) }, "1,10,11,12,2,3,4,5,6,7,8,9"],
      [{ createdSince: iso(start - 500) }, "3,4"],
      [{ createdSince: iso(start) }, "4"],
      [{ createdSince: iso(start + 1) }, ""],
      [{ ready: true }, "10,11,12,4,8"],
      [{ ready: true, limit: 1 }, "10+"],
      [{ ready: true, limit: 4 }, "10,11,12,4+"],
      [{ ready: true, limit: 5 }, "10,11,12,4,8"],
      [{ ready: true, kind: "task" }, "4"],
      [{ ready: true, label: ["b"] }, "4"],
      [{ ready: true, parent: "forge-2" }, "4"],
      [{ ready: true, status: "closed" }, ""],
    ] as const) {
      const got = await both(g, gt, input);
      const ids =
        got.items.map((i) => i.id.slice(6)).join() + (got.truncated ? "+" : "");
      expect([JSON.stringify(input), got.code ?? ids]).toEqual([
        JSON.stringify(input),
        want,
      ]);
    }
    const empty = fixture();
    empty.tables();
    expect(await both(empty, await empty.device(), {})).toEqual({
      items: [],
      truncated: false,
    });
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

type Outcome = [number, string | undefined, number, number, string?];
const drop = (table: string) => (f: F) => f.db.run(`DROP TABLE ${table}`);
const elsewhere = (f: F, key: string, value: unknown) =>
  f.put(value, {}, key, "forge/other");

test("a missing table, a mode record, a mismatched row or a foreign namespace is refused as mapped, reading only what it needs", async () => {
  // status, code, exit, how many of the token, records and leases tables are probed, message
  const shows: Outcome = [200, undefined, 0, 3];
  const missing: Outcome = [404, "NOT_FOUND", 3, 2, gone];
  const unknown: Outcome = [
    400,
    "INPUT_INVALID",
    6,
    2,
    "Unknown issue id prefix",
  ];
  const mode: Outcome = [400, "INPUT_INVALID", 6, 2, unproven];
  const corrupt: Outcome = [500, "INTERNAL", 1, 2, notValid];
  const rows: [string, (f: F) => void, Outcome, object?][] = [
    ["no leases table", drop("state_leases"), shows],
    ["no records table", drop("state_records"), missing],
    [
      "no records table, alias",
      drop("state_records"),
      unknown,
      { id: "acme-1" },
    ],
    ["slots only", (f) => f.put({ count: 2 }, {}, "slots:work-1"), mode],
    ["participant only", (f) => f.put({}, {}, "participant:work-1:1"), mode],
    [
      "record key mismatch",
      (f) => replaced(f, stored(bad), { key: "issue:work-2" }),
      corrupt,
    ],
    [
      "record namespace mismatch",
      (f) => replaced(f, stored(bad), { namespace: "forge/other" }),
      corrupt,
    ],
    [
      "record id mismatch",
      (f) => replaced(f, stored({ id: "work-2", ...bad })),
      corrupt,
    ],
    [
      "lease subject mismatch",
      (f) => f.lease({ subject: "issue:work-9" }),
      [500, "INTERNAL", 1, 3, notValid],
    ],
    [
      "issue only in another namespace",
      (f) => {
        f.db.run("DELETE FROM state_records");
        elsewhere(f, "issue:work-1", stored(bad));
      },
      missing,
    ],
    [
      "mode record only in another namespace",
      (f) => elsewhere(f, "slots:work-1", { count: 2 }),
      shows,
    ],
  ];
  for (const [name, setup, outcome, input = call.input] of rows) {
    const [status, code, exit, probes, message] = outcome;
    const f = fixture();
    const token = await f.device();
    f.tables();
    f.put(stored(bad));
    setup(f);
    const before = f.snapshot();
    const got = await f.send({ ...call, input }, { token });
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

const listCall = { ...call, op: "issue.list", input: {} };
const listed = (...items: object[]) => ({ items, truncated: false });

test("list refuses corrupt or oversized storage with a fixed 500, ignores other namespaces and tolerates missing tables, reading only what it needs", async () => {
  const raw = (f: F, key: string, body: string) =>
    f.db.run(
      "INSERT INTO state_records(namespace,key,revision,body) VALUES (?,?,3,?)",
      ["forge/work", key, body],
    );
  const corrupt: Outcome = [500, "INTERNAL", 1, 2, notValid];
  const shows: Outcome = [200, undefined, 0, 3];
  const rows: [string, (f: F) => void, Outcome, object?][] = [
    ["malformed row", (f) => raw(f, "issue:work-2", "{bad"), corrupt],
    [
      "oversized row",
      (f) => raw(f, "issue:work-2", "x".repeat(2 * 1024 * 1024 + 1)),
      corrupt,
    ],
    [
      "record key mismatch",
      (f) =>
        f.put(
          stored({ id: "work-2" }),
          { key: "issue:work-3" },
          "issue:work-2",
        ),
      corrupt,
    ],
    [
      "record id mismatch",
      (f) => f.put(stored({ id: "work-3" }), {}, "issue:work-2"),
      corrupt,
    ],
    [
      "wrong-typed revision",
      (f) => f.put(stored({ id: "work-2" }), { revision: "x" }, "issue:work-2"),
      corrupt,
    ],
    [
      "lease subject mismatch",
      (f) => f.lease({ subject: "issue:work-9" }),
      [500, "INTERNAL", 1, 3, notValid],
    ],
    [
      "other namespace ignored",
      (f) => elsewhere(f, "issue:work-2", stored({ id: "work-2" })),
      shows,
      listed(shown(bad)),
    ],
    [
      "forged embedded lease",
      (f) =>
        replaced(
          f,
          stored({ ...bad, lease: grant({ expiresAt: iso(start + day) }) }),
        ),
      shows,
      listed(shown(bad)),
    ],
    ["no leases table", drop("state_leases"), shows, listed(shown(bad))],
    [
      "no records table",
      drop("state_records"),
      [200, undefined, 0, 2],
      listed(),
    ],
  ];
  for (const [name, setup, outcome, result] of rows) {
    const [status, code, exit, probes, message] = outcome;
    const f = fixture();
    const token = await f.device();
    f.tables();
    f.put(stored(bad));
    setup(f);
    const before = f.snapshot();
    const got = await f.send(listCall, { token });
    expect([name, got.status, got.code, got.exit]).toEqual([
      name,
      status,
      code,
      exit,
    ]);
    expect(readCalls(got.touched)).toEqual([]);
    expect(got.probes).toEqual(WORK_PROBES.slice(0, probes));
    if (message === undefined) expect(got.json.result).toEqual(result);
    else {
      expect(got.json.error?.message).toBe(message);
      expect(JSON.stringify(got.json)).not.toContain(marker);
    }
    expect(f.snapshot()).toBe(before);
  }
}, 60_000);

test("list checks every stored issue, even past limit, before it reads any lease", async () => {
  const rows: [string, (f: F) => void][] = [
    [
      "empty record",
      (f) =>
        f.db.run(
          "INSERT INTO state_records(namespace,key,revision,body) VALUES (?,?,3,?)",
          ["forge/work", "issue:work-2", "{}"],
        ),
    ],
    [
      "record id mismatch",
      (f) => f.put(stored({ id: "work-3" }), {}, "issue:work-2"),
    ],
    [
      "wrong-typed revision",
      (f) => f.put(stored({ id: "work-2" }), { revision: "x" }, "issue:work-2"),
    ],
  ];
  for (const [name, corrupt] of rows) {
    const f = fixture();
    const token = await f.device();
    f.tables();
    f.put(stored());
    corrupt(f);
    const got = await f.send({ ...listCall, input: { limit: 1 } }, { token });
    expect([name, got.status, got.code, got.json.error?.message]).toEqual([
      name,
      500,
      "INTERNAL",
      notValid,
    ]);
    expect(got.probes).toEqual(WORK_PROBES.slice(0, 2));
  }
}, 30_000);

test("a corrupt row is refused whatever the filter would exclude, and ready:true reads a lease only for a candidate", async () => {
  const inputs = [
    { kind: "bug" },
    { status: "closed" },
    { label: ["x"] },
    { parent: "forge-9" },
    { ready: true },
  ];
  for (const input of inputs) {
    const f = fixture();
    const token = await f.device();
    f.tables();
    f.put(stored());
    f.db.run(
      "INSERT INTO state_records(namespace,key,revision,body) VALUES (?,?,3,?)",
      ["forge/work", "issue:work-2", "{}"],
    );
    const got = await f.send({ ...listCall, input }, { token });
    const name = JSON.stringify(input);
    expect([
      name,
      got.status,
      got.code,
      got.json.error?.message,
      got.probes,
    ]).toEqual([name, 500, "INTERNAL", notValid, WORK_PROBES.slice(0, 2)]);
  }
  const lease =
    "INSERT INTO state_leases(namespace,subject,generation,body) VALUES (?,?,2,?)";
  for (const [name, setup, input, want] of [
    [
      "malformed lease on a candidate",
      (f: F) => f.db.run(lease, ["forge/work", "issue:work-1", "{bad"]),
      { ready: true },
      "500",
    ],
    [
      "live lease with no holder on a candidate",
      (f: F) => f.lease({ holder: undefined }),
      { ready: true },
      "500",
    ],
    [
      "live lease with no generation on a candidate",
      (f: F) => f.lease({ generation: undefined }),
      { ready: true },
      "500",
    ],
    [
      "lease with an invalid expiry on a candidate",
      (f: F) => f.lease({ expiresAt: "not-a-date" }),
      { ready: true },
      "500",
    ],
    [
      "wrong subject on a candidate",
      (f: F) => f.lease({ subject: "issue:work-9" }),
      { ready: true },
      "500",
    ],
    [
      "malformed lease on a closed issue",
      (f: F) => f.db.run(lease, ["forge/work", "issue:work-2", "{bad"]),
      { ready: true },
      "200 forge-1,forge-3",
    ],
    [
      "malformed lease on a filtered-out issue",
      (f: F) => f.db.run(lease, ["forge/work", "issue:work-1", "{bad"]),
      { ready: true, kind: "bug" },
      "200 forge-3",
    ],
  ] as const) {
    const f = fixture();
    const token = await f.device();
    f.tables();
    f.put(stored());
    f.put(stored({ id: "work-2", status: "closed" }), {}, "issue:work-2");
    f.put(stored({ id: "work-3", kind: "bug" }), {}, "issue:work-3");
    setup(f);
    const got = await f.send({ ...listCall, input }, { token });
    const items =
      (got.json.result as { items: { id: string }[] } | undefined)?.items ?? [];
    expect([
      name,
      `${got.status} ${items.map((i) => i.id).join()}`.trim(),
    ]).toEqual([name, want]);
    if (got.status === 500) expect(got.json.error?.message).toBe(notValid);
  }
}, 60_000);

test("list refuses bad input before any work table is probed", async () => {
  const f = fixture();
  const token = await f.device();
  f.tables();
  f.put(stored());
  const before = f.snapshot();
  const invalid = [
    { extra: 1 },
    { limit: 0 },
    { limit: 1001 },
    { limit: 1.5 },
    { createdSince: "yesterday" },
    { ready: "yes" },
    { parent: "" },
    [],
  ];
  for (const [inputs, message] of [
    [invalid, "Invalid issue list input"],
  ] as const)
    for (const input of inputs) {
      const got = await f.send({ ...listCall, input }, { token });
      const name = JSON.stringify(input);
      expect([name, got.status, got.code, got.exit]).toEqual([
        name,
        400,
        "INPUT_INVALID",
        6,
      ]);
      expect(got.json.error?.message).toBe(message);
      expect(got.probes).toEqual(TOKEN_PROBE);
    }
  expect(f.snapshot()).toBe(before);
}, 30_000);

test("a bad server prefix is refused before the operation input is checked, with no work table probed", async () => {
  for (const prefix of [undefined, "Forge"]) {
    const f = fixture({ ...vars, FORGE_CLOUD_ID_PREFIX: prefix });
    const token = await f.device();
    f.tables();
    for (const input of [{ limit: 0 }, { kind: "task" }, {}]) {
      const got = await f.send({ ...listCall, input }, { token });
      expect([got.status, got.code, got.exit, got.probes]).toEqual([
        503,
        "UNAVAILABLE",
        1,
        TOKEN_PROBE,
      ]);
    }
  }
}, 30_000);

test("list refuses a wrong project, owner headers and bad credentials before any work read", async () => {
  const f = fixture();
  const token = await f.device();
  f.tables();
  f.put(stored());
  const before = f.snapshot();
  for (const [name, options, status, code] of [
    ["other project", { token, name: "other" }, 403, "AUTH_FORBIDDEN"],
    [
      "owner header",
      { token, headers: { "X-Forge-Owner": "x" } },
      403,
      "AUTH_FORBIDDEN",
    ],
    ["no bearer", {}, 401, "AUTH_REQUIRED"],
    ["admin token", { token: vars.ADMIN_TOKEN }, 403, "AUTH_FORBIDDEN"],
    ["unknown token", { token: fakeToken }, 401, "AUTH_INVALID"],
  ] as [string, Options, number, string][]) {
    const got = await f.send(listCall, options);
    expect([name, got.status, got.code, got.exit]).toEqual([
      name,
      status,
      code,
      1,
    ]);
    expect(got.touched.filter((sql) => sql.includes("state_"))).toEqual([]);
  }
  expect(f.snapshot()).toBe(before);
}, 30_000);

test("a list response is capped at 1 MiB of UTF-8 bytes, measured on the whole envelope", async () => {
  const cap = 1_048_576;
  const f = fixture();
  const token = await f.device();
  f.tables();
  const body = 'é"\n✓\\';
  const sized = (kind: string) =>
    envelope(listed(shown({ body, kind })), "issue.list");
  const room = cap - bytesOf(sized(""));
  for (const [delta, fits] of [
    [-1, true],
    [0, true],
    [1, false],
  ] as const) {
    const kind = "k".repeat(room + delta);
    f.db.run("DELETE FROM state_records");
    f.put(stored({ body, kind }));
    const got = await f.send(listCall, { token });
    expect(got.probes).toEqual(WORK_PROBES);
    if (fits) {
      expect([got.status, got.bytes]).toEqual([200, cap + delta]);
      expect(got.json.result).toEqual(listed(shown({ body, kind })));
      expect(got.text).toBe(JSON.stringify(got.json));
    } else {
      expect([got.status, got.code, got.exit]).toEqual([503, "UNAVAILABLE", 1]);
      expect(got.json.error?.message).toBe("response too large");
    }
  }
}, 60_000);

test("a project over the row or byte budget is refused as UNAVAILABLE, even when limit 1 would return one small issue", async () => {
  const mib8 = 8 * 1024 * 1024;
  const limited = { ...listCall, input: { limit: 1 } as object };
  const rows = async (count: number) => {
    const f = fixture();
    const token = await f.device();
    f.tables();
    f.db.run(
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?) INSERT INTO state_records(namespace,key,revision,body) SELECT 'forge/work','issue:work-'||i,3,json_object('namespace','forge/work','key','issue:work-'||i,'revision',3,'value',json_object('id','work-'||i,'title','t','status','open','labels',json('[]'),'dependsOn',json('[]'),'createdAt',?),'updatedAt',?,'updatedBy',json_object('kind','agent','id','tester')) FROM n",
      [count, iso(start - 1000), iso(start - 500)],
    );
    return f.send(limited, { token });
  };
  const bytes = async (delta: number) => {
    const f = fixture();
    const token = await f.device();
    f.tables();
    f.put(stored());
    for (const n of [2, 4, 5, 6])
      f.put(
        stored({ id: `work-${n}`, kind: "k".repeat(1_900_000) }),
        {},
        `issue:work-${n}`,
      );
    f.put(stored({ id: "work-3", kind: "" }), {}, "issue:work-3");
    const { n } = f.db
      .query("SELECT sum(length(CAST(body AS BLOB))) AS n FROM state_records")
      .get() as { n: number };
    f.db.run(
      "UPDATE state_records SET body=replace(body,'\"kind\":\"\"',?) WHERE key='issue:work-3'",
      ['"kind":"' + "k".repeat(mib8 + delta - n) + '"'],
    );
    return f.send(limited, { token });
  };
  for (const [name, got, want] of [
    [
      "10,000 rows",
      await rows(10_000),
      { items: [shown({ title: "t", labels: [] })], truncated: true },
    ],
    ["10,001 rows", await rows(10_001), undefined],
    ["8 MiB", await bytes(0), { items: [shown()], truncated: true }],
    ["8 MiB and one byte", await bytes(1), undefined],
  ] as const) {
    if (want)
      expect([name, got.status, got.json.result]).toEqual([name, 200, want]);
    else
      expect([
        name,
        got.status,
        got.code,
        got.exit,
        got.json.error?.message,
      ]).toEqual([
        name,
        503,
        "UNAVAILABLE",
        1,
        "Issue list is over its read budget",
      ]);
  }
  // A selective filter or ready:true does not shrink the work: the same refusal.
  limited.input = { limit: 1, kind: "none", ready: true };
  for (const got of [await rows(10_001), await bytes(1)])
    expect([got.status, got.code, got.json.error?.message]).toEqual([
      503,
      "UNAVAILABLE",
      "Issue list is over its read budget",
    ]);
}, 120_000);

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

// issue.ready: the route and the local handler read the same rows, clock and config.
type Listed = { items: { id: string }[]; truncated: boolean };
const idsOf = ({ items, truncated }: Listed) =>
  items.map((i) => i.id.slice(6)).join() + (truncated ? "+" : "");
async function withLocal(
  body: (
    local: (f: F, input: unknown, config: object, op?: string) => unknown,
  ) => Promise<void>,
) {
  const hadFail = "fail" in globals,
    previous = globals.fail;
  globals.fail = (code: string, message: string) => {
    throw new Error(`${code}: ${message}`);
  };
  try {
    const handlers = require(
      resolve(import.meta.dirname, "../../src/blocks/work/entry.cts"),
    ) as Record<string, Handler>;
    await body((f, input, config, op = "issue.ready") => {
      const refused: string[] = [];
      const state = createStateClient({
        owner: new StateOwner(readView(f.db, refused), { now: f.now }),
        namespace: "forge/work",
        context: { variant: "project", actor, project: { id: "p" } },
        write: false,
        requestId: "oracle",
      });
      try {
        return handlers[op]!({ input, config, services: { state } });
      } catch (error) {
        return { code: String(error).split(":")[1]!.trim() };
      } finally {
        expect(refused).toEqual([]);
      }
    });
  } finally {
    if (hadFail) globals.fail = previous;
    else delete globals.fail;
  }
}
// Ready: 4, 8, 10, 11 and 12. Blocked: 1 (missing dependency), 5 (itself), 6 and 7 (each other).
// Closed: 2 and 9. Held by a live lease: 3. Leases on 10, 11 and 12 are expired, expiring now and released.
async function readyRows() {
  const f = fixture();
  const token = await f.device();
  f.tables();
  const put = (n: number, over: object = {}, lease?: object) => {
    f.put(stored({ id: `work-${n}`, ...over }), {}, `issue:work-${n}`);
    if (lease) f.lease(lease, `issue:work-${n}`);
  };
  put(1, { kind: "task", dependsOn: ["work-99"] });
  put(2, { status: "closed", kind: "task" });
  put(
    3,
    {
      parent: "work-2",
      kind: "bug",
      labels: ["b"],
      createdAt: iso(start - 500),
    },
    { expiresAt: iso(start + 1) },
  );
  put(4, {
    parent: "work-2",
    kind: "task",
    labels: ["a", "b"],
    createdAt: iso(start),
    dependsOn: ["work-2"],
  });
  put(5, { dependsOn: ["work-5"] });
  put(6, { dependsOn: ["work-7"] });
  put(7, { dependsOn: ["work-6"] });
  put(8, { kind: "bug", labels: ["b"], dependsOn: ["work-9"] });
  put(9, { status: "closed", dependsOn: ["work-8"] });
  put(10, { labels: ["c"] }, { expiresAt: iso(start - 1) });
  put(11, { labels: [] }, { expiresAt: iso(start) });
  const released = { releasedAt: iso(start - 5), expiresAt: iso(start + day) };
  put(12, { labels: ["a"] }, released);
  return { f, token };
}
const readyCall = { ...call, op: "issue.ready" };

test("the cloud issue.ready agrees with the local handler on defaults, status, filters, leases, limits and the empty labelOrder", async () => {
  await withLocal(async (local) => {
    const { f, token } = await readyRows();
    const config = { idPrefix: "forge", labelOrder: [] };
    // The ids returned, `+` when truncated. Stored order has work-10 before work-2.
    for (const [input, want] of [
      [{}, "10,11,12,4,8"],
      [{ ready: false }, "10,11,12,4,8"],
      [{ ready: true }, "10,11,12,4,8"],
      [{ status: "open" }, "10,11,12,4,8"],
      [{ status: "closed" }, ""],
      [{ status: "closed", ready: false }, ""],
      [{ status: "closed", ready: true }, ""],
      [{ parent: "forge-2" }, "4"],
      [{ parent: "work-2", ready: false }, "4"],
      [{ parent: "none" }, "10,11,12,8"],
      [{ kind: "task" }, "4"],
      [{ kind: "bug", ready: false }, "8"],
      [{ label: ["b"] }, "4,8"],
      [{ labels: ["a", "b"] }, "4"],
      [{ label: ["a"] }, "12,4"],
      [{ label: ["a"], labels: ["c"] }, ""],
      [{ createdSince: iso(start - 1000) }, "10,11,12,4,8"],
      [{ createdSince: iso(start - 500) }, "4"],
      [{ createdSince: iso(start) }, "4"],
      [{ createdSince: iso(start + 1) }, ""],
      [{ kind: "bug", label: ["b"], ready: true }, "8"],
      [{ limit: 1 }, "10+"],
      [{ limit: 4 }, "10,11,12,4+"],
      [{ limit: 5 }, "10,11,12,4,8"],
      [{ limit: 1000, ready: false }, "10,11,12,4,8"],
      [{ limit: 1, label: ["a"] }, "12+"],
      [{ limit: 2, label: ["a"] }, "12,4"],
    ] as const) {
      const name = JSON.stringify(input);
      const before = f.snapshot();
      const got = await f.send({ ...readyCall, input }, { token });
      expect([name, got.status, got.json.op, got.exit]).toEqual([
        name,
        200,
        "issue.ready",
        0,
      ]);
      expect([name, got.json.result]).toEqual([name, local(f, input, config)]);
      expect([name, idsOf(got.json.result as Listed)]).toEqual([name, want]);
      expect(readCalls(got.touched)).toEqual([]);
      expect(f.snapshot()).toBe(before);
    }
  });
}, 60_000);

test("listIssues ranks ready issues by labelOrder, keeps stored order within a rank, limits after sorting and leaves issue.list unsorted", async () => {
  await withLocal(async (local) => {
    const { f } = await readyRows();
    const views: IssueViews = {
      records: readOnlyStore(f.storage, "state_records", RECORD_READS),
      leases: readOnlyStore(f.storage, "state_leases", LEASE_READS),
    };
    for (const [labelOrder, input, want] of [
      [["b", "a"], {}, "4,8,12,10,11"],
      [["b", "a"], { limit: 1 }, "4+"],
      [["b", "a"], { limit: 3 }, "4,8,12+"],
      [["b", "a"], { limit: 5 }, "4,8,12,10,11"],
      [["a"], {}, "12,4,10,11,8"],
      [["c", "b"], { ready: false, limit: 2 }, "10,4+"],
      [["b"], { kind: "bug" }, "8"],
      [["b"], { status: "closed" }, ""],
      [["nope"], {}, "10,11,12,4,8"],
      [[], {}, "10,11,12,4,8"],
    ] as const) {
      const name = JSON.stringify([labelOrder, input]);
      const got = listIssues(views, input, f.now(), "forge", { labelOrder });
      expect([name, idsOf(got)]).toEqual([name, want]);
      const mine = { idPrefix: "forge", labelOrder };
      expect(got).toEqual(local(f, input, mine) as typeof got);
    }
    const config = { idPrefix: "forge", labelOrder: ["a"] };
    const plain = listIssues(views, { ready: true }, f.now(), "forge");
    expect(idsOf(plain)).toBe("10,11,12,4,8");
    expect(plain).toEqual(
      local(f, { ready: true }, config, "issue.list") as typeof plain,
    );
  });
}, 30_000);

test("ready refuses bad input before any work table is probed", async () => {
  const { f, token } = await readyRows();
  const before = f.snapshot();
  for (const input of [
    { extra: 1 },
    { createdSince: "yesterday" },
    { limit: 1.5 },
    { limit: 0 },
    { limit: 1001 },
  ]) {
    const got = await f.send({ ...readyCall, input }, { token });
    const name = JSON.stringify(input);
    expect([name, got.status, got.code, got.exit]).toEqual([
      name,
      400,
      "INPUT_INVALID",
      6,
    ]);
    expect(got.json.error?.message).toBe("Invalid issue list input");
    expect(got.probes).toEqual(TOKEN_PROBE);
  }
  expect(f.snapshot()).toBe(before);
}, 30_000);

test("ready refuses a corrupt row or a corrupt candidate lease with the fixed 500, reading a lease only for a candidate", async () => {
  const lease =
    "INSERT INTO state_leases(namespace,subject,generation,body) VALUES (?,?,2,?)";
  const row =
    "INSERT INTO state_records(namespace,key,revision,body) VALUES (?,?,3,?)";
  const holder = { actor, session: { id: marker } };
  // The status, the ids returned, and how many work tables were probed.
  for (const [name, setup, input, want, probes] of [
    [
      "empty row past the limit",
      (f: F) => f.db.run(row, ["forge/work", "issue:work-9", "{}"]),
      { limit: 1 },
      "500 ",
      2,
    ],
    [
      "malformed lease on a candidate",
      (f: F) => f.db.run(lease, ["forge/work", "issue:work-1", `{${marker}`]),
      {},
      "500 ",
      3,
    ],
    [
      "wrong subject on a candidate",
      (f: F) => f.lease({ subject: "issue:work-9", holder }),
      { ready: false },
      "500 ",
      3,
    ],
    [
      "malformed lease on a closed issue",
      (f: F) => f.db.run(lease, ["forge/work", "issue:work-2", `{${marker}`]),
      {},
      "200 forge-1,forge-3",
      3,
    ],
    [
      "malformed lease on a filtered-out issue",
      (f: F) => f.db.run(lease, ["forge/work", "issue:work-1", `{${marker}`]),
      { kind: "bug" },
      "200 forge-3",
      3,
    ],
  ] as const) {
    const f = fixture();
    const token = await f.device();
    f.tables();
    f.put(stored());
    f.put(stored({ id: "work-2", status: "closed" }), {}, "issue:work-2");
    f.put(stored({ id: "work-3", kind: "bug" }), {}, "issue:work-3");
    setup(f);
    const before = f.snapshot();
    const got = await f.send({ ...readyCall, input }, { token });
    const items = (got.json.result as Listed | undefined)?.items ?? [];
    expect([name, `${got.status} ${items.map((i) => i.id).join()}`]).toEqual([
      name,
      want,
    ]);
    expect(got.probes).toEqual(WORK_PROBES.slice(0, probes));
    if (got.status === 500) {
      expect([got.code, got.exit, got.json.error?.message]).toEqual([
        "INTERNAL",
        1,
        notValid,
      ]);
      expect(JSON.stringify(got.json)).not.toContain(marker);
    }
    expect(f.snapshot()).toBe(before);
  }
}, 60_000);

test("ready refuses an over-budget project as UNAVAILABLE before it loads any body, whatever the filter", async () => {
  for (const [name, fill] of [
    [
      "10,001 rows",
      (f: F) =>
        f.db.run(
          "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?) INSERT INTO state_records(namespace,key,revision,body) SELECT 'forge/work','issue:work-'||i,3,json_object('namespace','forge/work','key','issue:work-'||i,'revision',3,'value',json_object('id','work-'||i,'title','t','status','open','labels',json('[]'),'dependsOn',json('[]'),'createdAt',?),'updatedAt',?,'updatedBy',json_object('kind','agent','id','tester')) FROM n",
          [10_001, iso(start - 1000), iso(start - 500)],
        ),
    ],
    [
      "over 8 MiB",
      (f: F) => {
        for (let n = 1; n <= 5; n++)
          f.put(
            stored({ id: `work-${n}`, kind: "k".repeat(1_700_000) }),
            {},
            `issue:work-${n}`,
          );
      },
    ],
  ] as const) {
    const f = fixture();
    const token = await f.device();
    f.tables();
    fill(f);
    const before = f.snapshot();
    for (const input of [{}, { limit: 1, kind: "none", ready: true }]) {
      const got = await f.send({ ...readyCall, input }, { token });
      expect([
        name,
        got.status,
        got.code,
        got.exit,
        got.json.error?.message,
      ]).toEqual([
        name,
        503,
        "UNAVAILABLE",
        1,
        "Issue list is over its read budget",
      ]);
      expect(got.probes).toEqual(WORK_PROBES.slice(0, 2));
      // The bodies are never loaded: the row-with-body query does not run.
      expect(got.touched).not.toContain(ROWS);
    }
    expect(f.snapshot()).toBe(before);
  }
}, 120_000);

// issue.create: the route and the real local handler start from the same rows, clock and config.
const sqlOf = (db: Database): SqlDatabase => ({
  exec: (sql) => {
    db.run(sql);
  },
  run: (sql, params = []) => db.query(sql).run(...(params as never[])),
  all: (sql, params = []) =>
    db.query(sql).all(...(params as never[])) as SqlRow[],
  get: (sql, params = []) =>
    (db.query(sql).get(...(params as never[])) ?? undefined) as
      SqlRow | undefined,
  transaction: (body) => db.transaction(body)(),
});
const rowsOf = (db: Database, namespace: string) =>
  db
    .query("SELECT key, body FROM state_records WHERE namespace=? ORDER BY key")
    .all(namespace) as { key: string; body: string }[];
const eventsOf = (db: Database, namespace: string) =>
  (
    db
      .query(
        "SELECT body FROM state_events WHERE namespace=? ORDER BY sequence",
      )
      .all(namespace) as { body: string }[]
  ).map((row) => row.body);
const receiptOf = (f: F, id: string) => {
  const row = rowsOf(f.db, "forge/cloud").find(
    (r) => r.key === `request:${id}`,
  );
  return row === undefined
    ? undefined
    : (JSON.parse(row.body) as { value: Record<string, unknown> }).value;
};
// Everything a create may write: the work and receipt records and their events, never the tokens.
const writes = (f: F) =>
  JSON.stringify(
    ["forge/work", "forge/cloud"].map((ns) => [
      rowsOf(f.db, ns),
      eventsOf(f.db, ns),
    ]),
  );
const issuesIn = (f: F) =>
  rowsOf(f.db, "forge/work").filter((r) => r.key.startsWith("issue:")).length;
const make = (id: string, input: object = { title: "New" }, more = {}) => ({
  requestId: id,
  op: "issue.create",
  input,
  context: { actor },
  ...more,
});
const revoke = (f: F, token: string) =>
  f.db
    .query("UPDATE domain_cloud_tokens SET revoked_at=? WHERE id=?")
    .run(f.now(), token.slice(4, 20));
// Issues 1, 4 and 12 (gaps, the historical prefixes acme and old, 4 held by a live lease), and a
// comment record numbered 30 that is not an issue and must not move the next number.
async function createRows() {
  const f = fixture();
  const token = await f.device();
  f.tables();
  f.put(stored({ prefix: "acme" }));
  f.put(stored({ id: "work-4", prefix: "old" }), {}, "issue:work-4");
  f.put(stored({ id: "work-12" }), {}, "issue:work-12");
  f.put({ id: "work-1", body: "c" }, {}, "comment:work-1:30");
  f.lease({ expiresAt: iso(start + 1) }, "issue:work-4");
  return { f, token };
}

test("the cloud issue.create agrees with the local handler on whole results, rows and events for every kind", async () => {
  await withLocal(async () => {
    const handlers = require(
      resolve(import.meta.dirname, "../../src/blocks/work/entry.cts"),
    ) as Record<string, Handler>;
    const { f, token } = await createRows();
    const twin = Database.deserialize(f.db.serialize());
    const seeded = () =>
      JSON.stringify([
        f.db
          .query(
            "SELECT * FROM state_records WHERE key IN ('issue:work-1','issue:work-4','issue:work-12','comment:work-1:30') ORDER BY key",
          )
          .all(),
        f.db.query("SELECT * FROM state_leases").all(),
      ]);
    const before = seeded();
    const inputs = [
      { title: "T", kind: "task" },
      { title: "B", kind: "bug" },
      { title: "F", kind: "feature" },
      { title: "E", kind: "epic" },
      { title: "Full", body: 'é\n"x"', labels: ["x", "y"], kind: "task" },
      { title: "Bare" },
    ];
    for (const [i, input] of inputs.entries()) {
      const id = `c-${i}`,
        number = 13 + i;
      const got = await f.send(make(id, input), {
        token,
        via: i % 2 ? "direct" : createWorker(),
      });
      const want = handlers["issue.create"]!({
        input,
        config: { idPrefix: "forge" },
        services: {
          state: createStateClient({
            owner: new StateOwner(sqlOf(twin), { now: f.now }),
            namespace: "forge/work",
            context: { variant: "project", actor, project: { id: "p" } },
            write: true,
            requestId: id,
          }),
        },
      });
      expect([id, got.status, got.exit]).toEqual([id, 200, 0]);
      expect(got.json).toEqual({
        ok: true,
        op: "issue.create",
        status: "OK",
        result: want,
        warnings: [],
      } as never);
      expect(want).toMatchObject({
        id: `forge-${number}`,
        status: "open",
        revision: 1,
        labels: (input as { labels?: string[] }).labels ?? [],
        dependsOn: [],
      });
      const key = `issue:work-${number}`;
      expect(rowsOf(f.db, "forge/work").find((r) => r.key === key)).toEqual(
        rowsOf(twin, "forge/work").find((r) => r.key === key),
      );
    }
    expect(eventsOf(f.db, "forge/work")).toEqual(eventsOf(twin, "forge/work"));
    expect(eventsOf(f.db, "forge/work")).toHaveLength(inputs.length);
    expect(seeded()).toBe(before);
    // Eligible while unleased; the leased issue 4 is not.
    const ready = await f.send({ ...readyCall, input: {} }, { token });
    const ids = idsOf(ready.json.result as Listed).split(",");
    expect([ids.includes("13"), ids.includes("4")]).toEqual([true, false]);
  });
}, 60_000);

test("a retry returns the original result with no second issue or issue event, and a reused id with other input conflicts", async () => {
  const { f, token } = await createRows();
  const other = await f.device();
  const tablet = await f.device(day, "tablet");
  const input = { title: "Once", kind: "bug" };
  const first = await f.send(make("r-1", input), { token });
  expect([first.status, first.exit, first.json.result]).toMatchObject([
    200,
    0,
    { id: "forge-13" },
  ]);
  // One issue and its one event; the receipt adds its own record and its own event.
  expect([issuesIn(f), eventsOf(f.db, "forge/work").length]).toEqual([4, 1]);
  expect(rowsOf(f.db, "forge/cloud").map((r) => r.key)).toEqual([
    "request:r-1",
  ]);
  expect(eventsOf(f.db, "forge/cloud")).toHaveLength(1);
  const receipt = receiptOf(f, "r-1")!;
  expect(Object.keys(receipt).sort()).toEqual([
    "fingerprint",
    "outcome",
    "result",
  ]);
  expect([receipt.outcome, receipt.result]).toEqual(["ok", first.json.result]);
  const done = f.snapshot();
  for (const [via, bearer, body] of [
    ["direct", token, input],
    [createWorker(), other, { kind: "bug", title: "Once" }],
  ] as const) {
    const again = await f.send(make("r-1", body), { token: bearer, via });
    expect([again.status, again.text]).toEqual([200, first.text]);
    expect(f.snapshot()).toBe(done);
  }
  for (const [name, bearer, body] of [
    ["title", token, { title: "Twice", kind: "bug" }],
    ["kind", token, { title: "Once", kind: "task" }],
    ["labels", token, { ...input, labels: ["x"] }],
    ["device", tablet, input],
  ] as const) {
    const got = await f.send(make("r-1", body), { token: bearer });
    expect([name, got.status, got.code, got.exit]).toEqual([
      name,
      409,
      "INPUT_CONFLICT",
      4,
    ]);
    expect([name, f.snapshot()]).toEqual([name, done]);
  }
  // A replay is authenticated first: a revoked token never reads the receipt.
  revoke(f, other);
  const revoked = f.snapshot();
  const denied = await f.send(make("r-1", input), { token: other });
  expect([denied.status, denied.code]).toEqual([401, "AUTH_REVOKED"]);
  expect(denied.text).not.toContain("forge-13");
  const dry = await f.send(make("r-2", input, { dryRun: true }), { token });
  expect([dry.status, dry.code, dry.exit]).toEqual([503, "UNAVAILABLE", 1]);
  expect(f.snapshot()).toBe(revoked);
}, 60_000);

test("graph fields are refused as unsupported, recorded once for a fresh request id and never dropped", async () => {
  const { f, token } = await createRows();
  const work = () =>
    JSON.stringify([rowsOf(f.db, "forge/work"), eventsOf(f.db, "forge/work")]);
  const before = work();
  const cases = [
    { parent: "forge-1" },
    { dependsOn: ["forge-1"] },
    { dependsOn: [] },
    { parent: "forge-1", dependsOn: ["forge-4"] },
  ];
  const texts: string[] = [];
  for (const [i, extra] of cases.entries()) {
    const got = await f.send(make(`g-${i}`, { title: "New", ...extra }), {
      token,
    });
    expect([got.status, got.code, got.exit]).toEqual([400, "INPUT_INVALID", 6]);
    expect(got.json.error?.message).toContain("not supported in cloud yet");
    expect(work()).toBe(before);
    expect(receiptOf(f, `g-${i}`)).toMatchObject({
      outcome: "refused",
      result: got.json.error,
    });
    expect(eventsOf(f.db, "forge/cloud")).toHaveLength(i + 1);
    texts.push(got.text);
  }
  const done = f.snapshot();
  const again = await f.send(make("g-0", { title: "New", parent: "forge-1" }), {
    token,
  });
  expect([again.status, again.text]).toEqual([400, texts[0]!]);
  const changed = await f.send(make("g-0"), { token });
  expect([changed.status, changed.code, changed.exit]).toEqual([
    409,
    "INPUT_CONFLICT",
    4,
  ]);
  // No receipt without a valid fresh request id, and none for a dry run.
  for (const [more, status] of [
    [{ requestId: "bad id!" }, 400],
    [{ dryRun: true }, 503],
  ] as const) {
    const got = await f.send(
      make("g-9", { title: "New", parent: "forge-1" }, more),
      { token },
    );
    expect(got.status).toBe(status);
  }
  expect(f.snapshot()).toBe(done);
}, 60_000);

test("bad input is refused as INPUT_INVALID with no work record, and the schema limits hold at the boundary", async () => {
  const { f, token } = await createRows();
  const work = () =>
    JSON.stringify([rowsOf(f.db, "forge/work"), eventsOf(f.db, "forge/work")]);
  const before = work();
  const cases: [string, object][] = [
    ["unknown key", { title: "T", extra: marker }],
    ["caller id", { title: "T", id: "forge-99" }],
    ["empty title", { title: "" }],
    ["no title", {}],
    ["unknown kind", { title: "T", kind: "chore" }],
    ["kind not text", { title: "T", kind: 5 }],
    ["long title", { title: "t".repeat(501) }],
    ["long body", { title: "T", body: "b".repeat(65_537) }],
    ["repeated label", { title: "T", labels: ["a", "a"] }],
  ];
  for (const [i, [name, input]] of cases.entries()) {
    const got = await f.send(make(`b-${i}`, input), { token });
    expect([name, got.status, got.code, got.exit]).toEqual([
      name,
      400,
      "INPUT_INVALID",
      6,
    ]);
    expect(JSON.stringify(got.json)).not.toContain(marker);
    expect([name, work()]).toEqual([name, before]);
  }
  expect(eventsOf(f.db, "forge/cloud")).toHaveLength(cases.length);
  const labels = Array.from({ length: 64 }, (_, i) => `l${i}`);
  const fits = await f.send(
    make("b-ok", { title: "t".repeat(500), body: "é".repeat(65_536), labels }),
    { token },
  );
  expect([fits.status, fits.exit]).toEqual([200, 0]);
}, 60_000);

test("a create with no, wrong, revoked or expired credentials writes no work and no receipt, also during the body read", async () => {
  const { f, token } = await createRows();
  const dead = await f.device();
  revoke(f, dead);
  const before = writes(f);
  const cases: [string, Options, [number, string, number]][] = [
    ["no bearer", {}, [401, "AUTH_REQUIRED", 1]],
    ["admin token", { token: vars.ADMIN_TOKEN }, [403, "AUTH_FORBIDDEN", 1]],
    ["oauth token", { token: oauthToken }, [403, "AUTH_FORBIDDEN", 1]],
    ["unknown token", { token: fakeToken }, [401, "AUTH_INVALID", 1]],
    ["revoked token", { token: dead }, [401, "AUTH_REVOKED", 1]],
    [
      "owner header",
      { token, headers: { "X-Forge-Owner": "phone" } },
      [403, "AUTH_FORBIDDEN", 1],
    ],
  ];
  for (const [name, options, want] of cases)
    for (const via of ["direct", createWorker()] as const) {
      refusal(name, await f.send(make("a-1"), { ...options, via }), want);
      expect(writes(f)).toBe(before);
    }
  const text = JSON.stringify(make("a-2"));
  const slow = (between: () => void) =>
    new ReadableStream({
      start: (c) => c.enqueue(new TextEncoder().encode(text.slice(0, 9))),
      pull(c) {
        between();
        c.enqueue(new TextEncoder().encode(text.slice(9)));
        c.close();
      },
    });
  const late = await f.device();
  const during = await f.send(
    slow(() => revoke(f, late)),
    { token: late },
  );
  refusal("revoked during the read", during, [401, "AUTH_REVOKED", 1]);
  const fresh = await f.device();
  const expired = await f.send(
    slow(() => f.advance(2 * day)),
    { token: fresh },
  );
  refusal("expired during the read", expired, [401, "AUTH_EXPIRED", 1]);
  expect(writes(f)).toBe(before);
}, 60_000);

// issue.comment: the route and the real local handler start from the same rows, clock and config.
const note = (
  id: string,
  input: object = { id: "forge-12", body: "hello" },
  more = {},
) => make(id, input, { op: "issue.comment", ...more });
const commentsOn = (f: F, id: string) =>
  rowsOf(f.db, "forge/work").filter((r) => r.key.startsWith(`comment:${id}:`));
// createRows, plus three comments on issue 12 and a stray one on an issue 10: a number is that issue's count plus one.
async function commentRows() {
  const rows = await createRows();
  for (const key of [
    "comment:work-12:1",
    "comment:work-12:2",
    "comment:work-12:3",
    "comment:work-10:1",
  ])
    rows.f.put({ id: key.split(":")[1], body: "c" }, {}, key);
  return rows;
}

test("the cloud issue.comment agrees with the local handler on whole results, rows and events, numbering and id aliases", async () => {
  await withLocal(async () => {
    const handlers = require(
      resolve(import.meta.dirname, "../../src/blocks/work/entry.cts"),
    ) as Record<string, Handler>;
    const { f, token } = await commentRows();
    const twin = Database.deserialize(f.db.serialize());
    const kept = rowsOf(f.db, "forge/work").map((r) => r.key);
    // Every row and lease that existed before: a comment never touches an issue, a comment or a lease.
    const seeded = () =>
      JSON.stringify([
        rowsOf(f.db, "forge/work").filter((r) => kept.includes(r.key)),
        f.db.query("SELECT * FROM state_leases").all(),
      ]);
    const eligible = async () =>
      idsOf(
        (await f.send({ ...readyCall, input: {} }, { token })).json
          .result as Listed,
      );
    const before = [seeded(), await eligible()];
    const cases = [
      ["m-0", "forge-12", "plain", "comment:work-12:4"],
      ["m-1", "forge-12", 'é\n"x"', "comment:work-12:5"],
      ["m-2", "forge-1", "numbered by its own count", "comment:work-1:2"],
      ["m-3", "acme-1", "historical prefix", "comment:work-1:3"],
      ["m-4", "OLD-4", "leased, no lease needed", "comment:work-4:1"],
      ["m-5", "work-12", "the default prefix", "comment:work-12:6"],
      ["m-6", "FORGE-1", "é".repeat(65_536), "comment:work-1:4"],
    ] as const;
    for (const [i, [requestId, id, body, commentId]] of cases.entries()) {
      const input = { id, body };
      const got = await f.send(note(requestId, input), {
        token,
        via: i % 2 ? "direct" : createWorker(),
      });
      const want = handlers["issue.comment"]!({
        input,
        config: { idPrefix: "forge" },
        services: {
          state: createStateClient({
            owner: new StateOwner(sqlOf(twin), { now: f.now }),
            namespace: "forge/work",
            context: { variant: "project", actor, project: { id: "p" } },
            write: true,
            requestId,
          }),
        },
      });
      expect([requestId, got.status, got.exit]).toEqual([requestId, 200, 0]);
      expect(got.json).toEqual({
        ok: true,
        op: "issue.comment",
        status: "OK",
        result: want,
        warnings: [],
      } as never);
      expect(want).toEqual({ id: id.replace(/^.*-/, "forge-"), commentId });
    }
    expect(rowsOf(f.db, "forge/work")).toEqual(rowsOf(twin, "forge/work"));
    expect(eventsOf(f.db, "forge/work")).toEqual(eventsOf(twin, "forge/work"));
    expect(eventsOf(f.db, "forge/work")).toHaveLength(cases.length);
    expect(rowsOf(f.db, "forge/cloud")).toHaveLength(cases.length);
    expect([seeded(), await eligible()]).toEqual(before);
  });
}, 60_000);

test("a comment retry returns the original comment with no second comment or comment event, and a reused id with other input conflicts", async () => {
  const { f, token } = await commentRows();
  const other = await f.device();
  const tablet = await f.device(day, "tablet");
  const input = { id: "forge-12", body: "Once" };
  const first = await f.send(note("r-1", input), { token });
  expect([first.status, first.exit, first.json.result]).toEqual([
    200,
    0,
    { id: "forge-12", commentId: "comment:work-12:4" },
  ]);
  // One comment and its one event; the receipt adds its own record and its own event.
  expect([
    commentsOn(f, "work-12").length,
    eventsOf(f.db, "forge/work").length,
  ]).toEqual([4, 1]);
  expect(rowsOf(f.db, "forge/cloud").map((r) => r.key)).toEqual([
    "request:r-1",
  ]);
  expect(eventsOf(f.db, "forge/cloud")).toHaveLength(1);
  const receipt = receiptOf(f, "r-1")!;
  expect(Object.keys(receipt).sort()).toEqual([
    "fingerprint",
    "outcome",
    "result",
  ]);
  expect([receipt.outcome, receipt.result]).toEqual(["ok", first.json.result]);
  const done = f.snapshot();
  for (const [via, bearer, body] of [
    ["direct", token, input],
    [createWorker(), other, { body: "Once", id: "forge-12" }],
  ] as const) {
    const again = await f.send(note("r-1", body), { token: bearer, via });
    expect([again.status, again.text]).toEqual([200, first.text]);
    expect(f.snapshot()).toBe(done);
  }
  for (const [name, bearer, body] of [
    ["body", token, { id: "forge-12", body: "Twice" }],
    ["issue", token, { id: "forge-1", body: "Once" }],
    ["device", tablet, input],
  ] as const) {
    const got = await f.send(note("r-1", body), { token: bearer });
    expect([name, got.status, got.code, got.exit]).toEqual([
      name,
      409,
      "INPUT_CONFLICT",
      4,
    ]);
    expect([name, f.snapshot()]).toEqual([name, done]);
  }
  const dry = await f.send(note("r-2", input, { dryRun: true }), { token });
  expect([dry.status, dry.code, dry.exit]).toEqual([503, "UNAVAILABLE", 1]);
  expect(f.snapshot()).toBe(done);
}, 60_000);

test("a missing issue is NOT_FOUND and bad input is INPUT_INVALID: no comment, one refusal receipt per fresh request id, replayed unchanged", async () => {
  const { f, token } = await commentRows();
  const work = () =>
    JSON.stringify([rowsOf(f.db, "forge/work"), eventsOf(f.db, "forge/work")]);
  const before = work();
  const gone = [404, "NOT_FOUND", 3] as const;
  const bad = [400, "INPUT_INVALID", 6] as const;
  const cases: [string, object, readonly [number, string, number]][] = [
    ["absent issue", { id: "forge-99", body: "x" }, gone],
    ["absent historical", { id: "old-99", body: "x" }, gone],
    ["unknown prefix", { id: "zzz-1", body: "x" }, bad],
    ["malformed id", { id: "nope", body: "x" }, bad],
    ["id with a suffix", { id: "forge-1x", body: "x" }, bad],
    ["unknown key", { id: "forge-12", body: "x", extra: marker }, bad],
    ["caller key", { id: "forge-12", body: "x", key: "comment:work-1:9" }, bad],
    ["empty body", { id: "forge-12", body: "" }, bad],
    ["no body", { id: "forge-12" }, bad],
    ["body not text", { id: "forge-12", body: 5 }, bad],
    ["no id", { body: "x" }, bad],
    ["id not text", { id: 12, body: "x" }, bad],
    ["long body", { id: "forge-12", body: "b".repeat(65_537) }, bad],
  ];
  const texts: string[] = [];
  for (const [i, [name, input, want]] of cases.entries()) {
    const got = await f.send(note(`b-${i}`, input), { token });
    expect([name, got.status, got.code, got.exit]).toEqual([name, ...want]);
    expect(JSON.stringify(got.json)).not.toContain(marker);
    expect([name, work()]).toEqual([name, before]);
    expect(receiptOf(f, `b-${i}`)).toMatchObject({
      outcome: "refused",
      result: got.json.error,
    });
    expect(eventsOf(f.db, "forge/cloud")).toHaveLength(i + 1);
    texts.push(got.text);
  }
  const done = f.snapshot();
  const again = await f.send(note("b-0", cases[0]![1]), { token });
  expect([again.status, again.text]).toEqual([404, texts[0]!]);
  const changed = await f.send(note("b-0"), { token });
  expect([changed.status, changed.code, changed.exit]).toEqual([
    409,
    "INPUT_CONFLICT",
    4,
  ]);
  // No receipt without a valid fresh request id, and none for a dry run.
  for (const [more, status] of [
    [{ requestId: "bad id!" }, 400],
    [{ dryRun: true }, 503],
  ] as const)
    expect(
      (await f.send(note("b-9", cases[0]![1], more), { token })).status,
    ).toBe(status);
  expect(f.snapshot()).toBe(done);
  // The longest body the schema allows is stored whole.
  const fits = await f.send(
    note("b-ok", { id: "forge-12", body: "é".repeat(65_536) }),
    { token },
  );
  expect([fits.status, fits.exit]).toEqual([200, 0]);
}, 60_000);

// issue.update: the route and the real local handler start from the same rows, clock, config and held lease.
const holder = { actor, session: { id: "s1", device: "laptop" } };
const leased = { actor, session: { id: "s1" }, leaseGeneration: 2 };
const patch = (over: object = {}) => ({
  id: "forge-12",
  expectRevision: 3,
  title: "Edited",
  ...over,
});
const revise = (id: string, input: object = patch(), more = {}) =>
  make(id, input, { op: "issue.update", context: leased, ...more });
const issueRow = (f: F, key = "issue:work-12") =>
  rowsOf(f.db, "forge/work").find((r) => r.key === key);
const leasesOf = (f: F) =>
  JSON.stringify(f.db.query("SELECT * FROM state_leases").all());
const work = (f: F) =>
  JSON.stringify([rowsOf(f.db, "forge/work"), eventsOf(f.db, "forge/work")]);
const unsupported = "not supported in cloud yet";
// createRows, plus issue 20 (a kind, a parent and a dependency); issues 1, 12 and 20 are held by laptop session s1 at generation 2.
async function updateRows() {
  const rows = await createRows();
  rows.f.put(
    stored({
      id: "work-20",
      kind: "bug",
      parent: "work-1",
      dependsOn: ["work-12"],
    }),
    {},
    "issue:work-20",
  );
  for (const n of [1, 12, 20]) rows.f.lease({ holder }, `issue:work-${n}`);
  return rows;
}
// The real local issue.update against `twin`, as session s1 on `device` holding `generation`.
function localUpdate(
  twin: Database,
  f: F,
  requestId: string,
  input: object,
  who: { generation?: number; device?: string } = {},
): { result?: unknown; error?: unknown } {
  const handlers = require(
    resolve(import.meta.dirname, "../../src/blocks/work/entry.cts"),
  ) as Record<string, Handler>;
  try {
    return {
      result: handlers["issue.update"]!({
        input,
        config: { idPrefix: "forge" },
        services: {
          state: createStateClient({
            owner: new StateOwner(sqlOf(twin), { now: f.now }),
            namespace: "forge/work",
            context: {
              variant: "leased",
              leaseMode: "held",
              actor,
              session: { id: "s1", device: who.device ?? "laptop" },
              project: { id: "p" },
              leaseGeneration: who.generation ?? 2,
            },
            write: true,
            requestId,
          }),
        },
      }),
    };
  } catch (error) {
    return { error: (error as { error?: unknown }).error ?? String(error) };
  }
}

test("the cloud issue.update agrees with the local handler on whole results, rows and events, aliases and kept graph", async () => {
  await withLocal(async () => {
    const { f, token } = await updateRows();
    const twin = Database.deserialize(f.db.serialize());
    const touched = ["issue:work-1", "issue:work-12", "issue:work-20"];
    const others = () =>
      JSON.stringify(
        rowsOf(f.db, "forge/work").filter((r) => !touched.includes(r.key)),
      );
    const eligible = async () =>
      idsOf(
        (await f.send({ ...readyCall, input: {} }, { token })).json
          .result as Listed,
      );
    const before = [others(), leasesOf(f), await eligible()];
    const cases: [string, object][] = [
      ["u-0", patch()],
      ["u-1", patch({ expectRevision: 4, body: 'é\n"x"', labels: ["x", "y"] })],
      ["u-2", patch({ id: "acme-1", title: "Historical" })],
      ["u-3", patch({ id: "FORGE-1", labels: [], expectRevision: 4 })],
      [
        "u-4",
        patch({ id: "work-12", title: "t".repeat(500), expectRevision: 5 }),
      ],
      ["u-5", patch({ id: "forge-20", title: "Graph kept" })],
      ["u-6", { id: "forge-12", expectRevision: 6 }],
    ];
    for (const [i, [requestId, input]] of cases.entries()) {
      const got = await f.send(revise(requestId, input), {
        token,
        via: i % 2 ? "direct" : createWorker(),
      });
      const want = localUpdate(twin, f, requestId, input);
      expect([requestId, got.status, got.exit]).toEqual([requestId, 200, 0]);
      expect(got.json).toEqual({
        ok: true,
        op: "issue.update",
        status: "OK",
        result: want.result,
        warnings: [],
      } as never);
    }
    expect(eventsOf(f.db, "forge/work")).toEqual(eventsOf(twin, "forge/work"));
    expect(rowsOf(f.db, "forge/work")).toEqual(rowsOf(twin, "forge/work"));
    expect(eventsOf(f.db, "forge/work")).toHaveLength(cases.length);
    expect(rowsOf(f.db, "forge/cloud")).toHaveLength(cases.length);
    // Issue 20 keeps its kind, parent and dependency; the live lease stays and is shown.
    const graph = JSON.parse(issueRow(f, "issue:work-20")!.body) as {
      value: object;
    };
    expect(graph.value).toMatchObject({
      title: "Graph kept",
      kind: "bug",
      parent: "work-1",
      dependsOn: ["work-12"],
    });
    expect([others(), leasesOf(f), await eligible()]).toEqual(before);
  });
}, 60_000);

test("a stale expectRevision is REVISION_CONFLICT with the local code and message, and the issue is untouched", async () => {
  await withLocal(async () => {
    const { f, token } = await updateRows();
    const twin = Database.deserialize(f.db.serialize());
    const before = writes(f);
    for (const [name, expectRevision] of [
      ["lower", 2],
      ["higher", 4],
      ["much higher", 99],
    ] as const) {
      const input = patch({ expectRevision });
      const got = await f.send(revise(`s-${expectRevision}`, input), { token });
      const want = localUpdate(twin, f, `s-${expectRevision}`, input);
      expect([name, got.status, got.code, got.exit]).toEqual([
        name,
        409,
        "REVISION_CONFLICT",
        4,
      ]);
      expect([name, got.json.error]).toEqual([name, want.error as never]);
      expect([name, writes(f)]).toEqual([name, before]);
      // Like every refusal thrown inside the write, it is not recorded: a retry runs again and refuses the same.
      const again = await f.send(revise(`s-${expectRevision}`, input), {
        token,
      });
      expect([name, again.text]).toEqual([name, got.text]);
      expect([name, writes(f)]).toEqual([name, before]);
    }
  });
}, 60_000);

test("a missing, zero or invalid expectRevision, a missing issue and bad input write nothing, record one refusal per fresh request id and replay unchanged", async () => {
  const { f, token } = await updateRows();
  const before = work(f);
  const bad = [400, "INPUT_INVALID", 6] as const;
  const gone = [404, "NOT_FOUND", 3] as const;
  const cases: [string, object, readonly [number, string, number]][] = [
    ["no revision", { id: "forge-12", title: "x" }, bad],
    ["zero revision", patch({ expectRevision: 0 }), bad],
    ["negative revision", patch({ expectRevision: -1 }), bad],
    ["fractional revision", patch({ expectRevision: 1.5 }), bad],
    ["revision as text", patch({ expectRevision: "3" }), bad],
    ["unknown key", patch({ extra: marker }), bad],
    ["caller key", patch({ key: "issue:work-1" }), bad],
    ["empty title", patch({ title: "" }), bad],
    ["long title", patch({ title: "t".repeat(501) }), bad],
    ["long body", patch({ body: "b".repeat(65_537) }), bad],
    ["repeated label", patch({ labels: ["a", "a"] }), bad],
    ["malformed id", patch({ id: "nope" }), bad],
    ["unknown prefix", patch({ id: "zzz-1" }), bad],
    ["no id", { expectRevision: 3, title: "x" }, bad],
    ["absent issue", patch({ id: "forge-99" }), gone],
    ["absent historical", patch({ id: "old-99" }), gone],
  ];
  const texts: string[] = [];
  for (const [i, [name, input, want]] of cases.entries()) {
    const got = await f.send(revise(`b-${i}`, input), { token });
    expect([name, got.status, got.code, got.exit]).toEqual([name, ...want]);
    expect(JSON.stringify(got.json)).not.toContain(marker);
    expect([name, work(f)]).toEqual([name, before]);
    expect(receiptOf(f, `b-${i}`)).toMatchObject({
      outcome: "refused",
      result: got.json.error,
    });
    expect(eventsOf(f.db, "forge/cloud")).toHaveLength(i + 1);
    texts.push(got.text);
  }
  const done = f.snapshot();
  const again = await f.send(revise("b-0", cases[0]![1]), { token });
  expect([again.status, again.text]).toEqual([400, texts[0]!]);
  const changed = await f.send(revise("b-0"), { token });
  expect([changed.status, changed.code, changed.exit]).toEqual([
    409,
    "INPUT_CONFLICT",
    4,
  ]);
  // No receipt without a valid fresh request id, and none for a dry run.
  for (const [more, status] of [
    [{ requestId: "bad id!" }, 400],
    [{ dryRun: true }, 503],
  ] as const)
    expect(
      (await f.send(revise("b-9", cases[0]![1], more), { token })).status,
    ).toBe(status);
  expect(f.snapshot()).toBe(done);
  // The longest title and body the schema allows are stored whole.
  const fits = await f.send(
    revise("b-ok", patch({ title: "t".repeat(500), body: "é".repeat(65_536) })),
    { token },
  );
  expect([fits.status, fits.exit]).toEqual([200, 0]);
}, 60_000);

test("kind, parent and dependsOn are refused as unsupported, recorded once for a fresh request id and never dropped", async () => {
  const { f, token } = await updateRows();
  const before = work(f);
  const cases = [
    { kind: "bug" },
    { parent: "forge-1" },
    { parent: null },
    { dependsOn: ["forge-1"] },
    { dependsOn: [] },
    { kind: "task", parent: "forge-1", dependsOn: ["forge-4"] },
  ];
  const texts: string[] = [];
  for (const [i, extra] of cases.entries()) {
    const got = await f.send(revise(`g-${i}`, patch(extra)), { token });
    expect([got.status, got.code, got.exit]).toEqual([400, "INPUT_INVALID", 6]);
    expect(got.json.error?.message).toContain(unsupported);
    expect(work(f)).toBe(before);
    expect(receiptOf(f, `g-${i}`)).toMatchObject({
      outcome: "refused",
      result: got.json.error,
    });
    expect(eventsOf(f.db, "forge/cloud")).toHaveLength(i + 1);
    texts.push(got.text);
  }
  const done = f.snapshot();
  const again = await f.send(revise("g-0", patch({ kind: "bug" })), { token });
  expect([again.status, again.text]).toEqual([400, texts[0]!]);
  for (const more of [{ requestId: "bad id!" }, { dryRun: true }])
    await f.send(revise("g-9", patch({ kind: "bug" }), more), { token });
  expect(f.snapshot()).toBe(done);
}, 60_000);

test("a caller that does not hold the live lease generation is refused with the local lease code, and nothing is written", async () => {
  await withLocal(async () => {
    const at = (over: object) => (f: F) =>
      f.lease({ holder, ...over }, "issue:work-12");
    const sessionOf = (device: string, id = "s1") => ({
      holder: { actor, session: { id, device } },
    });
    const none = () => {};
    const cases: [string, (f: F) => void, object, string][] = [
      [
        "no lease",
        (f) =>
          f.db.run("DELETE FROM state_leases WHERE subject='issue:work-12'"),
        {},
        "laptop",
      ],
      ["another device", at(sessionOf("tablet")), {}, "laptop"],
      ["another session", at(sessionOf("laptop", "s2")), {}, "laptop"],
      ["older generation", none, { leaseGeneration: 1 }, "laptop"],
      ["newer generation", none, { leaseGeneration: 3 }, "laptop"],
      ["expired", at({ expiresAt: iso(start - 1) }), {}, "laptop"],
      ["exactly at expiry", at({ expiresAt: iso(start) }), {}, "laptop"],
      ["released", at({ releasedAt: iso(start - 10) }), {}, "laptop"],
      ["another device's token", none, {}, "tablet"],
    ];
    for (const [name, setup, over, who] of cases) {
      const { f, token: laptop } = await updateRows();
      const token = who === "laptop" ? laptop : await f.device(day, who);
      setup(f);
      const twin = Database.deserialize(f.db.serialize());
      const before = writes(f);
      const context = { ...leased, ...over };
      const got = await f.send(revise("f-1", patch(), { context }), { token });
      const want = localUpdate(twin, f, "f-1", patch(), {
        generation: context.leaseGeneration,
        device: who,
      });
      expect([name, got.status, got.exit]).toEqual([name, 409, 4]);
      expect(want.error).toBeDefined();
      expect([name, got.json.error]).toEqual([name, want.error as never]);
      expect([name, writes(f)]).toEqual([name, before]);
      const again = await f.send(revise("f-1", patch(), { context }), {
        token,
      });
      expect([name, again.text]).toEqual([name, got.text]);
      expect([name, writes(f)]).toEqual([name, before]);
    }
    // No refusal receipt blocks a retry once the caller holds the lease again.
    {
      const { f, token } = await updateRows();
      f.db.run("DELETE FROM state_leases WHERE subject='issue:work-12'");
      expect((await f.send(revise("f-3"), { token })).code).toBe(
        "LEASE_NOT_HELD",
      );
      f.lease({ holder }, "issue:work-12");
      const retry = await f.send(revise("f-3"), { token });
      expect([retry.status, retry.json.result]).toMatchObject([
        200,
        { title: "Edited" },
      ]);
    }
    // The device is the token's: a body that names another one is refused outright.
    const { f, token } = await updateRows();
    const before = writes(f);
    const named = await f.send(
      revise("f-2", patch(), {
        context: { ...leased, session: { id: "s1", device: "tablet" } },
      }),
      { token },
    );
    expect([named.status, named.code]).toEqual([403, "AUTH_DEVICE_MISMATCH"]);
    expect(writes(f)).toBe(before);
  });
}, 120_000);

test("a retry with the lease still held returns the original result with no second update or update event, and a reused id with other input, fence or device conflicts", async () => {
  const { f, token } = await updateRows();
  const other = await f.device();
  const tablet = await f.device(day, "tablet");
  const first = await f.send(revise("r-1"), { token });
  expect([first.status, first.exit, first.json.result]).toMatchObject([
    200,
    0,
    { title: "Edited", revision: 4 },
  ]);
  // One update and its one event; the receipt adds its own record and its own event.
  expect(eventsOf(f.db, "forge/work")).toHaveLength(1);
  expect(rowsOf(f.db, "forge/cloud").map((r) => r.key)).toEqual([
    "request:r-1",
  ]);
  expect(eventsOf(f.db, "forge/cloud")).toHaveLength(1);
  const receipt = receiptOf(f, "r-1")!;
  expect([receipt.outcome, receipt.result]).toEqual(["ok", first.json.result]);
  const done = f.snapshot();
  for (const [via, bearer] of [
    ["direct", token],
    [createWorker(), other],
  ] as const) {
    const again = await f.send(revise("r-1"), { token: bearer, via });
    expect([again.status, again.text]).toEqual([200, first.text]);
    expect(f.snapshot()).toBe(done);
  }
  // A later update moves the issue on; the replay still answers with the original.
  const next = await f.send(
    revise("r-2", patch({ expectRevision: 4, title: "Later" })),
    { token },
  );
  expect(next.status).toBe(200);
  const later = f.snapshot();
  const again = await f.send(revise("r-1"), { token });
  expect([again.status, again.text]).toEqual([200, first.text]);
  expect(f.snapshot()).toBe(later);
  const sent = JSON.stringify(receiptOf(f, "r-1"));
  for (const [name, bearer, body, context] of [
    ["title", token, patch({ title: "Twice" }), leased],
    ["revision", token, patch({ expectRevision: 4 }), leased],
    ["issue", token, patch({ id: "forge-1" }), leased],
    ["generation", token, patch(), { ...leased, leaseGeneration: 3 }],
    ["session", token, patch(), { ...leased, session: { id: "s2" } }],
    ["device", tablet, patch(), leased],
  ] as const) {
    const got = await f.send(revise("r-1", body, { context }), {
      token: bearer,
    });
    expect([name, got.status, got.code, got.exit]).toEqual([
      name,
      409,
      "INPUT_CONFLICT",
      4,
    ]);
    expect([name, f.snapshot(), JSON.stringify(receiptOf(f, "r-1"))]).toEqual([
      name,
      later,
      sent,
    ]);
  }
  // A replay is authenticated first: a revoked token never reads the receipt.
  revoke(f, other);
  const revoked = f.snapshot();
  const denied = await f.send(revise("r-1"), { token: other });
  expect([denied.status, denied.code]).toEqual([401, "AUTH_REVOKED"]);
  expect(denied.text).not.toContain("Edited");
  const dry = await f.send(revise("r-3", patch(), { dryRun: true }), { token });
  expect([dry.status, dry.code, dry.exit]).toEqual([503, "UNAVAILABLE", 1]);
  expect(f.snapshot()).toBe(revoked);
}, 60_000);

test("a replay after the lease was released, expired or taken over is LEASE_STALE and never the historical result", async () => {
  const takeover = (id: string, device: string) => (f: F) =>
    f.lease(
      { holder: { actor, session: { id, device } }, generation: 3 },
      "issue:work-12",
    );
  for (const [name, lose] of [
    [
      "released",
      (f: F) => f.lease({ holder, releasedAt: iso(start) }, "issue:work-12"),
    ],
    ["expired", (f: F) => f.advance(1001)],
    ["exactly at expiry", (f: F) => f.advance(1000)],
    ["taken over", takeover("s2", "laptop")],
    ["taken over by another device", takeover("s1", "tablet")],
    [
      "gone",
      (f: F) =>
        f.db.run("DELETE FROM state_leases WHERE subject='issue:work-12'"),
    ],
  ] as const) {
    const { f, token } = await updateRows();
    const first = await f.send(revise("r-1"), { token });
    expect([name, first.status]).toEqual([name, 200]);
    lose(f);
    const done = f.snapshot();
    for (const via of ["direct", createWorker()] as const) {
      const got = await f.send(revise("r-1"), { token, via });
      expect([name, got.status, got.code, got.exit]).toEqual([
        name,
        409,
        "LEASE_STALE",
        4,
      ]);
      expect(got.text).not.toContain("Edited");
      expect([name, f.snapshot()]).toEqual([name, done]);
    }
    // Other input under the id is a conflict whatever the lease is, and never replaces the receipt.
    const changed = await f.send(revise("r-1", patch({ title: "Twice" })), {
      token,
    });
    expect([name, changed.code]).toEqual([name, "INPUT_CONFLICT"]);
    expect([name, f.snapshot()]).toEqual([name, done]);
  }
}, 120_000);

test("the shared write path takes a project context for create and comment and a leased one for update, and refuses the other as INTERNAL", async () => {
  const { f } = await updateRows();
  const db = sqlOf(f.db);
  const owner = new StateOwner(db, { now: f.now });
  const project = { variant: "project", actor, project: { id: "p" } } as const;
  const lease = {
    variant: "leased",
    leaseMode: "held",
    actor,
    session: { id: "s1", device: "laptop" },
    project: { id: "p" },
    leaseGeneration: 2,
  } as const;
  const before = f.snapshot();
  for (const [op, run, context, want] of [
    ["issue.create", createIssue, lease, "project"],
    ["issue.comment", commentIssue, lease, "project"],
    ["issue.update", updateIssue, project, "leased"],
  ] as const) {
    expect(() =>
      run(db, owner, {
        requestId: "x-1",
        input: {},
        context,
        device: "laptop",
        prefix: "forge",
        recheck: () => {},
      }),
    ).toThrow(`${op} needs a ${want} context`);
  }
  expect(f.snapshot()).toBe(before);
}, 30_000);

// The receipt scenarios every write shares, run for create, comment and update, each with its own rows.
type Sent = Awaited<ReturnType<F["send"]>>;
interface Write {
  name: string;
  rows: () => Promise<{ f: F; token: string }>;
  /** The envelope for a request id; the input is the write's default unless given. */
  send: (id: string, input?: object) => object;
  /** Input its check refuses, recorded as a refusal, and the refusal it gets. */
  bad: object;
  badWant: readonly [number, string];
  /** Input the schema refuses, for the dump. */
  empty: object;
  /** Input for the dump's accepted write, when the default is not it. */
  ok?: object;
  /** A valid fresh request after the first write, when the default is no longer valid. */
  next?: object;
  /** The work record a successful write leaves in the dump. */
  record: string;
  /** What the first successful write returns, after a failed receipt write was rolled back. */
  result: (f: F, got: Sent) => void;
}
const WRITES: Write[] = [
  {
    name: "create",
    rows: createRows,
    send: make,
    bad: { title: "New", parent: "forge-1" },
    badWant: [400, "INPUT_INVALID"],
    empty: { title: "" },
    ok: { title: "New", kind: "task" },
    record: "forge/work/issue:work-13",
    result: (_f, got) =>
      expect([got.status, got.json.result]).toMatchObject([
        200,
        { id: "forge-13" },
      ]),
  },
  {
    name: "comment",
    rows: commentRows,
    send: note,
    bad: { id: "forge-99", body: "x" },
    badWant: [404, "NOT_FOUND"],
    empty: { id: "forge-12", body: "" },
    record: "forge/work/comment:work-12:4",
    result: (_f, got) =>
      expect([got.status, got.json.result]).toEqual([
        200,
        { id: "forge-12", commentId: "comment:work-12:4" },
      ]),
  },
  {
    name: "update",
    rows: updateRows,
    send: revise,
    bad: patch({ id: "forge-99" }),
    badWant: [404, "NOT_FOUND"],
    empty: patch({ title: "" }),
    next: patch({ expectRevision: 4 }),
    record: "forge/work/issue:work-12",
    result: (f, got) => {
      expect([got.status, got.json.result]).toMatchObject([
        200,
        { title: "Edited", revision: 4 },
      ]);
      expect(eventsOf(f.db, "forge/work")).toHaveLength(1);
    },
  },
];

for (const w of WRITES) {
  test(`a request id that carries a device token is refused for ${w.name} before any lookup or write, and no part of the token is stored or echoed`, async () => {
    const { f, token } = await w.rows();
    const before = f.snapshot();
    const secret = token.split(".")[1]!;
    const texts: string[] = [];
    for (const [name, id, input] of [
      ["valid input", token, undefined],
      ["refused input", token, w.bad],
      ["upper case", token.toUpperCase(), undefined],
      ["inside other text", `x-${token}`, undefined],
    ] as const) {
      const got = await f.send(w.send(id, input), { token });
      expect([name, got.status, got.code, got.exit]).toEqual([
        name,
        400,
        "INPUT_INVALID",
        6,
      ]);
      expect(got.json.error?.message).toBe(
        "requestId must not carry a credential",
      );
      texts.push(got.text);
    }
    expect(f.snapshot()).toBe(before);
    texts.push(await f.dump());
    for (const text of texts)
      for (const part of [token, secret])
        expect(text.toLowerCase()).not.toContain(part.toLowerCase());
  }, 30_000);

  test(`a token that expires between the route's check and the transaction writes and records nothing, for a ${w.name} and for a refusal`, async () => {
    for (const input of [undefined, w.bad]) {
      const { f, token } = await w.rows();
      const before = writes(f);
      const real = f.storage.sql.exec.bind(f.storage.sql);
      let tripped = false;
      // The first statement after the route's checks is the receipt lookup: the clock passes expiry there.
      f.storage.sql.exec = (sql, ...bindings) => {
        if (!tripped && bindings.includes("request:e-1")) {
          tripped = true;
          f.advance(2 * day);
        }
        return real(sql, ...bindings);
      };
      const got = await f.send(w.send("e-1", input), { token });
      expect([tripped, got.status, got.code, got.exit]).toEqual([
        true,
        401,
        "AUTH_EXPIRED",
        1,
      ]);
      expect(writes(f)).toBe(before);
    }
  }, 30_000);

  test(`at the receipt limit a fresh ${w.name} is refused, a refusal records nothing more, and a replay still answers`, async () => {
    const { f, token } = await w.rows();
    const first = await f.send(w.send("l-0"), { token });
    expect(first.status).toBe(200);
    f.db.run(
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < ?) INSERT INTO state_records(namespace,key,revision,body) SELECT 'forge/cloud', 'request:fill-' || i, 1, '{}' FROM n",
      [MAX_RECEIPTS - 1],
    );
    const full = f.snapshot();
    const got = await f.send(w.send("l-1", w.next), { token });
    expect([got.status, got.code, got.exit]).toEqual([503, "UNAVAILABLE", 1]);
    expect(got.json.error?.message).toContain("receipts");
    expect(f.snapshot()).toBe(full);
    const refused = await f.send(w.send("l-2", w.bad), { token });
    expect([refused.status, refused.code]).toEqual([...w.badWant]);
    expect(f.snapshot()).toBe(full);
    const again = await f.send(w.send("l-0"), { token });
    expect([again.status, again.text]).toEqual([200, first.text]);
    expect(f.snapshot()).toBe(full);
  }, 60_000);

  test(`a failed receipt write rolls the whole ${w.name} back, and the retry applies it once`, async () => {
    const { f, token } = await w.rows();
    const before = writes(f);
    f.db.run(
      "CREATE TRIGGER no_receipt BEFORE INSERT ON state_records WHEN NEW.namespace='forge/cloud' BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    const quiet = spyOn(console, "error").mockImplementation(() => {});
    try {
      const got = await f.send(w.send("t-1"), { token });
      expect([got.status, got.code, got.exit]).toEqual([500, "INTERNAL", 1]);
    } finally {
      quiet.mockRestore();
    }
    expect(writes(f)).toBe(before);
    f.db.run("DROP TRIGGER no_receipt");
    w.result(f, await f.send(w.send("t-1"), { token }));
  }, 30_000);

  test(`a ${w.name} leaves its record, event and receipt in the dump, and no credential or login state anywhere`, async () => {
    const { f, token } = await w.rows();
    const ok = await f.send(w.send("s-1", w.ok), { token });
    const bad = await f.send(w.send("s-2", w.empty), { token });
    expect([ok.status, bad.status]).toEqual([200, 400]);
    const dump = await f.dump();
    const { value } = JSON.parse(dump) as {
      value: { tables: Record<string, { namespace?: string; key?: string }[]> };
    };
    expect(Object.keys(value.tables).sort()).toEqual([
      "domain_cloud_requests",
      "state_events",
      "state_leases",
      "state_records",
      "state_requests",
    ]);
    const at = (table: string) =>
      (value.tables[table] ?? []).map((r) => `${r.namespace}/${r.key ?? ""}`);
    for (const record of [
      w.record,
      "forge/cloud/request:s-1",
      "forge/cloud/request:s-2",
    ])
      expect(at("state_records")).toContain(record);
    expect(
      at("state_events")
        .map((row) => row.split("/").slice(0, 2).join("/"))
        .sort(),
    ).toEqual(["forge/cloud", "forge/cloud", "forge/work"]);
    // The token is the canary: it is in no response, receipt, dump or row of the project.
    const secret = token.split(".")[1]!;
    const rows = JSON.stringify(
      ["forge/work", "forge/cloud"].map((ns) => rowsOf(f.db, ns)),
    );
    for (const text of [ok.text, bad.text, dump, rows])
      for (const canary of [token, secret, "authorization", "fct_"])
        expect([
          canary,
          text.toLowerCase().includes(canary.toLowerCase()),
        ]).toEqual([canary, false]);
  }, 60_000);
}

// A token bound to a session proves it: a body that names another session, on the same device, is refused.
test("a session-bound token cannot act as another session, on a first write or a replay, and a sessionless token keeps the device as the boundary", async () => {
  const { f, token: sessionless } = await updateRows();
  const s1 = await f.device(day, "laptop", "s1");
  const s2 = await f.device(day, "laptop", "s2");
  const before = writes(f);
  // The holder is laptop session s1 at generation 2: a token bound to s2 cannot name s1.
  for (const [name, send] of [
    ["update", revise("m-1")],
    [
      "create",
      make(
        "m-2",
        { title: "New" },
        { context: { actor, session: { id: "s1" } } },
      ),
    ],
    [
      "comment",
      note(
        "m-3",
        { id: "forge-12", body: "x" },
        { context: { actor, session: { id: "s1" } } },
      ),
    ],
  ] as const) {
    const got = await f.send(send, { token: s2 });
    expect([name, got.status, got.code, got.exit]).toEqual([
      name,
      403,
      "AUTH_DEVICE_MISMATCH",
      1,
    ]);
    expect(got.json.error?.message).toBe(
      "The request names a session other than the token's",
    );
    expect([name, writes(f)]).toEqual([name, before]);
  }
  // A matching session passes; so does a token with no session, which names s1 itself.
  const first = await f.send(revise("m-4"), { token: s1 });
  expect([first.status, first.json.result]).toMatchObject([
    200,
    { title: "Edited", revision: 4 },
  ]);
  const kept = f.snapshot();
  // A replay is checked the same way: s2 cannot read or repeat the s1 result.
  const forged = await f.send(revise("m-4"), { token: s2 });
  expect([forged.status, forged.code]).toEqual([403, "AUTH_DEVICE_MISMATCH"]);
  expect(forged.text).not.toContain("Edited");
  expect(f.snapshot()).toBe(kept);
  const again = await f.send(revise("m-4"), { token: s1 });
  expect([again.status, again.text]).toEqual([200, first.text]);
  const open = await f.send(
    revise("m-5", patch({ expectRevision: 4, title: "Open" })),
    { token: sessionless },
  );
  expect([open.status, open.json.result]).toMatchObject([
    200,
    { title: "Open", revision: 5 },
  ]);
}, 60_000);
