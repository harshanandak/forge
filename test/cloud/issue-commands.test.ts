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
import { depIssue } from "../../cloud/src/issue-dep.ts";
import { linkIssue } from "../../cloud/src/issue-link.ts";
import { closeIssue } from "../../cloud/src/issue-close.ts";
import { claimIssue } from "../../cloud/src/issue-claim.ts";
import { releaseIssue, renewIssue } from "../../cloud/src/issue-lease.ts";
import {
  LEASE_READS,
  MAX_RECORD_BYTES,
  parseBody,
  RECORD_READS,
  ROWS,
  SCAN,
  shownItem,
  type IssueViews,
} from "../../cloud/src/issue-read.ts";
import { createWorker } from "../../cloud/src/worker.ts";
import manifest from "../../src/blocks/work/forge.block.json" with { type: "json" };
import { createStateClient } from "../../src/assembly/state-client.ts";
import { StateOwner } from "../../src/core/state/index.ts";
import { refuse } from "../../src/core/trust/index.ts";
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
const needsId = "input must be { id } with a valid issue id";
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
  /** The route under the project: `command` unless a raw lease route is meant. */
  path?: string;
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
  // Opt-in (`on`): what the work-record statements hand back, as the Worker would receive it. A row of
  // numbers only is an aggregate counter; every other column of a row counts, as UTF-8 bytes of its text.
  const meter = { on: false, bytes: 0, cells: [] as string[] };
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
        if (meter.on && sql.includes("state_records") && sql !== TABLE_PROBE)
          for (const row of rows) {
            const cells = Object.values(row).filter((v) => v !== null);
            if (cells.every((v) => typeof v === "number")) continue;
            for (const cell of cells) {
              const text =
                typeof cell === "string" ? cell : JSON.stringify(cell);
              meter.cells.push(text);
              meter.bytes += new TextEncoder().encode(text).length;
            }
          }
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
      `https://w.example/p/${o.name ?? name}/${o.path ?? "command"}`,
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
    meter,
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
    // The browser attempt counters came with the next migration, so an object older than login lacks them too.
    "DROP TABLE domain_cloud_browser_attempts",
    "DELETE FROM state_migrations WHERE id='004_cloud_browser_attempts'",
    "DELETE FROM state_domains WHERE table_name='domain_cloud_browser_attempts'",
  ])
    f.db.query(sql).run();
  const before = f.snapshot();
  expect(before).not.toContain("domain_cloud_login");
  for (const absent of [
    "domain_cloud_browser_attempts",
    "003_cloud_login",
    "004_cloud_browser_attempts",
  ])
    expect(before).not.toContain(absent);
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

test("issue.comments passes the envelope and context checks and is answered, not refused", async () => {
  const { f, token, before } = await begin();
  const named = {
    actor,
    session: { id: "s1", device: "laptop" },
    device: { id: "laptop" },
    project: { id: "p" },
  };
  for (const context of [{ actor }, named]) {
    const got = await f.send(
      { ...call, op: "issue.comments", context },
      { token },
    );
    expect([got.status, got.code, got.exit]).toEqual([404, "NOT_FOUND", 3]);
    expect(got.json.error?.message).toBe("Issue forge-1 was not found");
    // A missing issue is a work read, not a refusal before one: exactly the issue's own row from the fixed
    // read-only set, no comment scan, no lease table (as show's NOT_FOUND above).
    expect(strayCalls(got.touched)).toHaveLength(1);
    expect(readCalls(got.touched)).toEqual([]);
    expect(got.touched).not.toContain(SCAN);
    expect(got.touched).not.toContain(ROWS);
    expect(got.probes).toEqual([TOKENS, "state_records"]);
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
  const ops = ["issue.delete", "lane.show", "constructor.constructor"];
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
    ["issue.claim", { actor }],
    ["issue.renew", { actor, session: { id: "s1" } }],
    ["issue.release", { actor, leaseGeneration: 3 }],
    ["issue.link", { actor, session: { id: "s1" } }],
    ["issue.link", { actor, leaseGeneration: 3 }],
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
    ["32 levels", deep(31), needsId],
    ["33 levels", deep(32), "maxDepth limit of 32"],
    ["5000 values", new Array(4992).fill(0), needsId],
    ["5001 values", new Array(4993).fill(0), "maxNodes limit of 5000"],
    ["brackets inside a string", `${"[".repeat(100)}\\"{`, needsId],
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
    ["issue.comments", { actor }],
    ["issue.links", { actor }],
    ["issue.update", {}],
    ["issue.claim", { actor, session: { id: "s1" } }],
    ["issue.renew", {}],
    ["issue.release", { actor, session: { id: "s1" } }],
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
  // An acquisition names no generation: the one the caller sent is not carried.
  expect(prepared("issue.claim", loose).context).toEqual({
    variant: "leased",
    leaseMode: "acquire",
    actor,
    session: { id: "s1", agent: "a", harness: "h", device: "laptop" },
    project: { id: "p" },
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
async function barrier(body: object, probes = WORK_PROBES) {
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
    expect([got.status, got.json.ok, got.probes]).toEqual([200, true, probes]);
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

for (const op of ["issue.show", "issue.list", "issue.comments", "issue.links"])
  test(
    `a token revoked or expired after the first check, while the ${op} body is held, ends the command before any work read`,
    () =>
      barrier(
        { ...call, op, input: op === "issue.list" ? {} : call.input },
        // A comments or links read never builds the lease view.
        op === "issue.comments" || op === "issue.links"
          ? [TOKENS, "state_records"]
          : WORK_PROBES,
      ),
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

test("a project over the row budget is refused as UNAVAILABLE, even when limit 1 would return one small issue", async () => {
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
  const fits = await rows(10_000);
  expect([fits.status, fits.json.result]).toEqual([
    200,
    { items: [shown({ title: "t", labels: [] })], truncated: true },
  ]);
  // A selective filter or ready:true does not shrink the work: the same refusal.
  for (const input of [{ limit: 1 }, { limit: 1, kind: "none", ready: true }]) {
    limited.input = input;
    const got = await rows(10_001);
    expect([got.status, got.code, got.exit, got.json.error?.message]).toEqual([
      503,
      "UNAVAILABLE",
      1,
      "Issue list is over its read budget",
    ]);
  }
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

// issue.blocked and issue.stale: the route and the local handler read the same rows, clock and config.
// Rows 1 to 12 are readyRows. Added: 13 is closed, depends on the open work-1 and holds an expired
// lease. 14 is open, depends on a closed and an open issue and holds an expired lease. 15 is open,
// depends on a missing issue and holds a live lease.
// Blocked: 1, 14, 15, 5, 6 and 7. Stale (expired and not released): 10, 11 and 14.
async function modeRows() {
  const { f } = await readyRows();
  // The clock moves a day and more, so the caller's token must outlive that.
  const token = await f.device(4 * day, "late");
  const put = (n: number, over: object, lease: object) => {
    f.put(stored({ id: `work-${n}`, ...over }), {}, `issue:work-${n}`);
    f.lease(lease, `issue:work-${n}`);
  };
  put(
    13,
    { status: "closed", kind: "task", dependsOn: ["work-1"] },
    { expiresAt: iso(start - 10) },
  );
  put(
    14,
    {
      parent: "work-2",
      kind: "task",
      labels: ["a", "c"],
      createdAt: iso(start + 10),
      dependsOn: ["work-2", "work-4"],
    },
    { expiresAt: iso(start - 100) },
  );
  put(
    15,
    {
      kind: "bug",
      labels: ["b"],
      createdAt: iso(start - 500),
      dependsOn: ["work-99"],
    },
    { expiresAt: iso(start + day) },
  );
  return { f, token };
}
// Each row is an input and the ids it returns, `+` when truncated. `ready` is ignored in both modes,
// and a labelOrder in the local config never sorts them.
const MODES = {
  "issue.blocked": {
    rows: [
      [{}, "1,14,15,5,6,7"],
      [{ ready: false }, "1,14,15,5,6,7"],
      [{ ready: true }, "1,14,15,5,6,7"],
      [{ status: "open" }, "1,14,15,5,6,7"],
      [{ status: "closed" }, ""],
      [{ status: "closed", ready: true }, ""],
      [{ parent: "forge-2" }, "14"],
      [{ parent: "none" }, "1,15,5,6,7"],
      [{ kind: "task" }, "1,14"],
      [{ kind: "bug", ready: true }, "15"],
      [{ label: ["a"] }, "1,14,5,6,7"],
      [{ labels: ["a", "c"] }, "14"],
      [{ label: ["c"], labels: ["a"] }, "14"],
      [{ labels: ["b"], kind: "task" }, ""],
      [{ createdSince: iso(start - 1000) }, "1,14,15,5,6,7"],
      [{ createdSince: iso(start - 500) }, "14,15"],
      [{ createdSince: iso(start + 10) }, "14"],
      [{ createdSince: iso(start + 11) }, ""],
      [{ limit: 1 }, "1+"],
      [{ limit: 3 }, "1,14,15+"],
      [{ limit: 6 }, "1,14,15,5,6,7"],
      [{ limit: 2, label: ["a"] }, "1,14+"],
      [{ limit: 5, label: ["a"] }, "1,14,5,6,7"],
    ],
    // Advance the clock, then ask: 15's lease expires, which changes nothing for blocked.
    later: [
      [2, {}, "1,14,15,5,6,7"],
      [day, {}, "1,14,15,5,6,7"],
      [0, { limit: 2 }, "1,14+"],
    ],
  },
  "issue.stale": {
    rows: [
      [{}, "10,11,14"],
      [{ ready: false }, "10,11,14"],
      [{ ready: true }, "10,11,14"],
      [{ status: "open" }, "10,11,14"],
      [{ status: "closed" }, ""],
      [{ status: "closed", ready: true }, ""],
      [{ parent: "forge-2" }, "14"],
      [{ parent: "none" }, "10,11"],
      [{ kind: "task" }, "14"],
      [{ kind: "bug" }, ""],
      [{ label: ["c"] }, "10,14"],
      [{ labels: ["a", "c"] }, "14"],
      [{ label: ["a"] }, "14"],
      [{ createdSince: iso(start - 1000) }, "10,11,14"],
      [{ createdSince: iso(start) }, "14"],
      [{ createdSince: iso(start + 11) }, ""],
      [{ limit: 1 }, "10+"],
      [{ limit: 2 }, "10,11+"],
      [{ limit: 3 }, "10,11,14"],
      [{ limit: 1, label: ["c"] }, "10+"],
      [{ limit: 2, label: ["c"] }, "10,14"],
    ],
    // Work-3 expires at start + 1 and work-15 at start + one day; work-12 was released and never turns stale.
    later: [
      [2, {}, "10,11,14,3"],
      [day, {}, "10,11,14,15,3"],
      [0, { limit: 1, label: ["b"] }, "15+"],
      [0, { label: ["b"] }, "15,3"],
    ],
  },
} as const;

for (const [op, { rows, later }] of Object.entries(MODES))
  test(`the cloud ${op} agrees with the local handler on filters, leases, a fixed clock, order and limits, and writes nothing`, async () => {
    await withLocal(async (local) => {
      const { f, token } = await modeRows();
      const config = { idPrefix: "forge", labelOrder: ["c", "b"] };
      const ask = async (input: object, want: string) => {
        const name = JSON.stringify([op, input, f.now() - start]);
        const before = f.snapshot();
        const got = await f.send({ ...call, op, input }, { token });
        expect([name, got.status, got.json.op, got.exit]).toEqual([
          name,
          200,
          op,
          0,
        ]);
        expect([name, got.json.result]).toEqual([
          name,
          local(f, input, config, op),
        ]);
        expect([name, idsOf(got.json.result as Listed)]).toEqual([name, want]);
        expect(readCalls(got.touched)).toEqual([]);
        expect(f.snapshot()).toBe(before);
      };
      for (const [input, want] of rows) await ask(input, want);
      for (const [ms, input, want] of later) {
        f.advance(ms);
        await ask(input, want);
      }
    });
  }, 60_000);

test("blocked and stale refuse bad input before any work table is probed", async () => {
  const { f, token } = await modeRows();
  const before = f.snapshot();
  for (const op of Object.keys(MODES))
    for (const input of [
      { extra: 1 },
      { createdSince: "yesterday" },
      { limit: 1.5 },
      { limit: 0 },
      { limit: 1001 },
    ]) {
      const got = await f.send({ ...call, op, input }, { token });
      const name = JSON.stringify([op, input]);
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

test("blocked and stale refuse a corrupt row, and a corrupt lease only where one is read, with the fixed 500", async () => {
  const lease =
    "INSERT INTO state_leases(namespace,subject,generation,body) VALUES (?,?,2,?)";
  const row =
    "INSERT INTO state_records(namespace,key,revision,body) VALUES (?,?,3,?)";
  const holder = { actor, session: { id: marker } };
  const broken = (subject: string) => (f: F) =>
    f.db.run(lease, ["forge/work", subject, `{${marker}`]);
  // Work-1 is open and unblocked, work-2 is closed, work-3 is open and blocked by a missing issue.
  // The op, the status and the ids returned, and how many work tables were probed.
  for (const [op, name, setup, input, want, probes] of [
    [
      "issue.blocked",
      "empty row past the limit",
      (f: F) => f.db.run(row, ["forge/work", "issue:work-9", "{}"]),
      { limit: 1 },
      "500 ",
      2,
    ],
    [
      "issue.stale",
      "empty row past the limit",
      (f: F) => f.db.run(row, ["forge/work", "issue:work-9", "{}"]),
      { limit: 1 },
      "500 ",
      2,
    ],
    [
      "issue.stale",
      "malformed lease on a candidate",
      broken("issue:work-1"),
      {},
      "500 ",
      3,
    ],
    [
      "issue.stale",
      "wrong subject on a candidate",
      (f: F) => f.lease({ subject: "issue:work-9", holder }),
      {},
      "500 ",
      3,
    ],
    [
      "issue.stale",
      "malformed lease on a closed issue",
      broken("issue:work-2"),
      {},
      "200 ",
      3,
    ],
    [
      "issue.stale",
      "malformed lease on a filtered-out issue",
      broken("issue:work-1"),
      { kind: "bug" },
      "200 ",
      3,
    ],
    [
      "issue.blocked",
      "malformed lease on a returned issue",
      broken("issue:work-3"),
      {},
      "500 ",
      3,
    ],
    [
      "issue.blocked",
      "malformed lease on an issue that is not blocked",
      broken("issue:work-1"),
      {},
      "200 forge-3",
      3,
    ],
    [
      "issue.blocked",
      "malformed lease on a closed issue",
      broken("issue:work-2"),
      {},
      "200 forge-3",
      3,
    ],
  ] as const) {
    const f = fixture();
    const token = await f.device();
    f.tables();
    f.put(stored());
    f.put(stored({ id: "work-2", status: "closed" }), {}, "issue:work-2");
    f.put(
      stored({ id: "work-3", kind: "bug", dependsOn: ["work-99"] }),
      {},
      "issue:work-3",
    );
    setup(f);
    const before = f.snapshot();
    const got = await f.send({ ...call, op, input }, { token });
    const items = (got.json.result as Listed | undefined)?.items ?? [];
    const label = `${op}: ${name}`;
    expect([label, `${got.status} ${items.map((i) => i.id).join()}`]).toEqual([
      label,
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

test("blocked and stale refuse an over-budget project as UNAVAILABLE before they load any body, whatever the filter", async () => {
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
    for (const op of Object.keys(MODES))
      for (const input of [{}, { limit: 1, kind: "none", ready: true }]) {
        const got = await f.send({ ...call, op, input }, { token });
        expect([
          name,
          op,
          got.status,
          got.code,
          got.exit,
          got.json.error?.message,
        ]).toEqual([
          name,
          op,
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

// issue.list read budget: a body outside the returned page costs nothing. The compact rows (metadata and
// size, body blanked) and the selected full records share one 8 MiB payload, counted as the work-record
// statements return it (the `meter` in fixture). The local handler is the oracle for every result.
const MIB8 = 8 * 1024 * 1024;
const storedJsonBytes = (f: F) =>
  (
    f.db
      .query("SELECT sum(length(CAST(body AS BLOB))) AS n FROM state_records")
      .get() as { n: number }
  ).n;
// `count` open issues: odd ones tasks, the rest bugs, every fifth blocked by the one before it, every 11th with
// an expired lease and every 13th with a live one. A body is `size` (a SQL expression over i) characters, led by
// `b<i>:` and filled with `fill`.
function bulk(f: F, count: number, size: string, fill: string) {
  f.db.run(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?) INSERT INTO state_records(namespace,key,revision,body) SELECT 'forge/work','issue:work-'||i,3,json_object('namespace','forge/work','key','issue:work-'||i,'revision',3,'value',json_object('id','work-'||i,'title','t'||i,'status','open','kind',CASE WHEN i%2=1 THEN 'task' ELSE 'bug' END,'labels',json('[]'),'dependsOn',CASE WHEN i%5=0 THEN json_array('work-'||(i-1)) ELSE json('[]') END,'createdAt',?,'body',substr('b'||i||':'||replace(hex(zeroblob(32768)),'0','${fill}'),1,${size})),'updatedAt',?,'updatedBy',json_object('kind','agent','id','tester')) FROM n`,
    [count, iso(start - 1000), iso(start - 500)],
  );
  for (let i = 11; i <= count; i += 11)
    f.lease({ expiresAt: iso(start - 1) }, `issue:work-${i}`);
  for (let i = 13; i <= count; i += 13)
    f.lease({ expiresAt: iso(start + day) }, `issue:work-${i}`);
}
const bigProject = async (count: number, size: string, fill = "x") => {
  const f = fixture();
  const token = await f.device();
  f.tables();
  bulk(f, count, size, fill);
  expect(storedJsonBytes(f)).toBeGreaterThan(MIB8);
  return { f, token };
};
const LIST_OPS = ["issue.list", "issue.ready", "issue.blocked", "issue.stale"];
type Bodied = { items: { id: string; body: string }[]; truncated: boolean };

// One test per mode, from this table, so a failing mode never hides the next: the input rows and the ids each
// returns over the 130-issue project, in key order.
const BIG_ROWS = {
  "issue.list": [
    [{ limit: 1 }, "1+"],
    [{ kind: "bug", limit: 2 }, "10,100+"],
  ],
  "issue.ready": [[{ limit: 1, ready: false }, "1+"]],
  "issue.blocked": [[{ limit: 1 }, "10+"]],
  "issue.stale": [[{ limit: 1 }, "11+"]],
} as const;
for (const [op, rows] of Object.entries(BIG_ROWS))
  test(`${op} returns the requested page of a project whose stored JSON is over 8 MiB, equal to the local handler`, async () => {
    await withLocal(async (local) => {
      const { f, token } = await bigProject(130, "65536");
      const config = { idPrefix: "forge", labelOrder: [] };
      const before = f.snapshot();
      for (const [input, want] of rows) {
        const name = JSON.stringify([op, input]);
        const got = await f.send({ ...call, op, input }, { token });
        expect([name, got.status, got.exit]).toEqual([name, 200, 0]);
        const result = got.json.result as Bodied;
        expect([name, result]).toEqual([
          name,
          local(f, input, config, op) as typeof result,
        ]);
        expect([name, idsOf(result)]).toEqual([name, want]);
        // Each body is whole: 65,536 characters led by its own marker.
        for (const { id, body } of result.items)
          expect([
            name,
            body.length,
            body.startsWith(`b${id.slice(6)}:x`),
          ]).toEqual([name, 65_536, true]);
        expect(readCalls(got.touched)).toEqual([]);
      }
      expect(f.snapshot()).toBe(before);
    });
  }, 120_000);

for (const op of LIST_OPS)
  test(`${op} lists an import-sized tracker of 1,300 issues with mixed long bodies, equal to the local handler`, async () => {
    await withLocal(async (local) => {
      const { f, token } = await bigProject(1300, "1000+(i%10)*1500");
      const config = { idPrefix: "forge", labelOrder: [] };
      const before = f.snapshot();
      for (const limit of [1, 25]) {
        const input = { limit };
        const name = JSON.stringify([op, input]);
        const got = await f.send({ ...call, op, input }, { token });
        expect([name, got.status, got.exit]).toEqual([name, 200, 0]);
        const result = got.json.result as Listed;
        expect([name, result]).toEqual([
          name,
          local(f, input, config, op) as typeof result,
        ]);
        expect([name, result.items.length, result.truncated]).toEqual([
          name,
          limit,
          true,
        ]);
      }
      expect(f.snapshot()).toBe(before);
    });
  }, 180_000);

// The SQL meter table: the same page of a project over 8 MiB with one-byte and two-byte characters.
for (const [name, count, fill] of [
  ["ASCII bodies", 130, "x"],
  ["multibyte bodies, 65 issues of 65,536 characters", 65, "é"],
] as const)
  test(`only the selected page loads full records, ${name}: the SQL results are compact rows plus one record, within 8 MiB`, async () => {
    await withLocal(async (local) => {
      const { f, token } = await bigProject(count, "65536", fill);
      const input = { kind: "bug", limit: 1 };
      f.meter.on = true;
      const got = await f.send({ ...listCall, input }, { token });
      f.meter.on = false;
      expect([got.status, got.exit]).toEqual([200, 0]);
      expect(got.json.result).toEqual(
        local(f, input, { idPrefix: "forge", labelOrder: [] }, "issue.list"),
      );
      // Matches outside the page are counted (truncated), but only one body ever left SQL.
      expect(idsOf(got.json.result as Listed)).toBe("10+");
      expect(
        f.meter.cells.join("").match(new RegExp(`b\\d+:${fill}`, "g")),
      ).toEqual([`b10:${fill}`]);
      expect(f.meter.bytes).toBeLessThan(262_144);
      expect(got.touched).not.toContain(ROWS);
    });
  }, 120_000);

test("the list byte budget charges the compact rows and the selected page together: exactly 8 MiB is read, one byte more is refused before the page loads", async () => {
  const body = 'sel☃é"\n';
  // Rows 2 to 6 are never returned (limit 1); their `kind` padding is metadata the compact rows keep, so it moves M alone.
  const run = async (extra: number) => {
    const f = fixture();
    const token = await f.device();
    f.tables();
    f.put(stored({ body }));
    f.put(
      stored({
        id: "work-2",
        title: "✓".repeat(500),
        labels: ["é".repeat(100)],
        kind: "k".repeat(1_000_000),
      }),
      {},
      "issue:work-2",
    );
    for (const n of [3, 4, 5, 6]) {
      const more = Math.min(900_000, Math.max(0, extra - (n - 3) * 900_000));
      f.put(
        stored({ id: `work-${n}`, kind: "k".repeat(1_000_000 + more) }),
        {},
        `issue:work-${n}`,
      );
    }
    f.meter.on = true;
    const got = await f.send({ ...listCall, input: { limit: 1 } }, { token });
    return { got, meter: f.meter };
  };
  // The calibration run measures M + P; the padding then lands the total exactly on the budget.
  const base = await run(0);
  const extra = MIB8 - base.meter.bytes;
  base.meter.cells.length = 0;
  expect(extra).toBeGreaterThan(0);
  expect(extra).toBeLessThanOrEqual(3_600_000);
  for (const [name, add, fits] of [
    ["exactly 8 MiB", 0, true],
    ["one byte over", 1, false],
    ["compact rows alone over", 10_000, false],
  ] as const) {
    const { got, meter } = await run(extra + add);
    if (fits)
      expect([name, meter.bytes, got.status, got.json.result]).toEqual([
        name,
        MIB8,
        200,
        { items: [shown({ body })], truncated: true },
      ]);
    else {
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
      // The selected page's body never left SQL.
      expect([name, meter.cells.some((c) => c.includes("sel☃"))]).toEqual([
        name,
        false,
      ]);
    }
    meter.cells.length = 0;
  }
}, 180_000);

// A raw stored issue; `over` is raw JSON appended to the value's fields.
const rawIssue = (id: string, over = "") =>
  `{"namespace":"forge/work","key":"issue:${id}","revision":3,"value":{"id":"${id}","title":"t","status":"open","labels":[],"dependsOn":[],"createdAt":"${iso(start - 1000)}"${over}},"updatedAt":"${iso(start - 500)}","updatedBy":{"kind":"agent","id":"tester"}}`;
const insertRaw = (f: F, key: string, body: string) =>
  f.db.run(
    "INSERT INTO state_records(namespace,key,revision,body) VALUES ('forge/work',?,3,?)",
    [key, body],
  );

test("list refuses a stored issue with a bad body, unknown field, nesting or node count with the fixed 500, whatever the filter or limit excludes", async () => {
  // `closeReason` is dropped before the item schema runs, so only the parse bounds can refuse these two rows.
  const nested = `${"[".repeat(8)}"leak-me"${"]".repeat(8)}`;
  const nodes = `[${'"l",'.repeat(1_100)}"l"]`;
  for (const [name, text] of [
    ["unknown field", rawIssue("work-2", ',"extra":"leak-me"')],
    ["body is a number", rawIssue("work-2", ',"body":5')],
    ["body is null", rawIssue("work-2", ',"body":null')],
    ["body is an array", rawIssue("work-2", ',"body":["leak-me"]')],
    ["body is an object", rawIssue("work-2", ',"body":{"a":"leak-me"}')],
    [
      "body of 65,537 characters",
      rawIssue("work-2", `,"body":"${"x".repeat(65_537)}"`),
    ],
    [
      "body of 65,537 astral characters",
      rawIssue("work-2", `,"body":"${"𝒳".repeat(65_537)}"`),
    ],
    ["nesting over 8", rawIssue("work-2", `,"closeReason":${nested}`)],
    ["over 1,024 nodes", rawIssue("work-2", `,"closeReason":${nodes}`)],
  ] as const)
    for (const input of [{ limit: 1 }, { kind: "bug" }, { ready: true }]) {
      const f = fixture();
      const token = await f.device();
      f.tables();
      f.put(stored());
      insertRaw(f, "issue:work-2", text);
      const got = await f.send({ ...listCall, input }, { token });
      const label = JSON.stringify([name, input]);
      expect([label, got.status, got.code, got.json.error?.message]).toEqual([
        label,
        500,
        "INTERNAL",
        notValid,
      ]);
      expect(got.probes).toEqual(WORK_PROBES.slice(0, 2));
      expect(JSON.stringify(got.json)).not.toContain("leak-me");
    }
}, 120_000);

test("list reads a stored body as the existing parser does: ceiling, escapes, astral characters and duplicate fields", async () => {
  const oracle = (text: string) => {
    try {
      return shownItem(
        parseBody(text, MAX_RECORD_BYTES),
        "work-1",
        undefined,
        start,
        "forge",
      );
    } catch {
      return undefined;
    }
  };
  const long = "x".repeat(65_537);
  for (const [name, over] of [
    ["absent body", ""],
    ["empty body", ',"body":""'],
    ["quotes and escapes", ',"body":"a\\"b\\\\c\\n\\t\\u00e9\\ud835\\udcb3"'],
    ["lone surrogate escape", ',"body":"\\ud835"'],
    ["astral at the ceiling", `,"body":"${"𝒳".repeat(65_536)}"`],
    ["astral over the ceiling", `,"body":"${"𝒳".repeat(65_537)}"`],
    [
      "escaped astral at the ceiling",
      `,"body":"${"\\ud835\\udcb3".repeat(65_536)}"`,
    ],
    ["escaped NUL at the ceiling", `,"body":"${"\\u0000".repeat(65_536)}"`],
    ["escaped NUL over the ceiling", `,"body":"${"\\u0000".repeat(65_537)}"`],
    ["duplicate body, long first", `,"body":"${long}","body":"ok"`],
    ["duplicate body, long last", `,"body":"ok","body":"${long}"`],
    ["duplicate title", ',"title":"again"'],
  ] as const) {
    const text = rawIssue("work-1", over);
    const f = fixture();
    const token = await f.device();
    f.tables();
    insertRaw(f, "issue:work-1", text);
    const got = await f.send(listCall, { token });
    const item = oracle(text);
    const want =
      item === undefined
        ? [500, notValid]
        : [200, { items: [item], truncated: false }];
    expect([
      name,
      got.status,
      got.json.result ?? got.json.error?.message,
    ]).toEqual([name, ...want]);
  }
}, 120_000);

test("a record or a candidate lease at its byte cap is read, and one byte over is the fixed 500", async () => {
  const padded = (text: string, bytes: number) =>
    text + " ".repeat(bytes - bytesOf(text));
  const lease = (f: F, body: string) =>
    f.db.run(
      "INSERT INTO state_leases(namespace,subject,generation,body) VALUES ('forge/work','issue:work-1',2,?)",
      [body],
    );
  const expired = JSON.stringify(grant({ expiresAt: iso(start - 1) }));
  const record = (bytes: number) => (f: F) =>
    insertRaw(f, "issue:work-2", padded(rawIssue("work-2"), bytes));
  const [mib2, kib16] = [2 * 1024 * 1024, 16 * 1024];
  for (const [name, setup, input, want] of [
    ["record at 2 MiB", record(mib2), { limit: 1 }, "200 forge-1"],
    ["record one byte over", record(mib2 + 1), { limit: 1 }, "500 "],
    [
      "lease at 16 KiB",
      (f: F) => lease(f, padded(expired, kib16)),
      { ready: true },
      "200 forge-1",
    ],
    [
      "lease one byte over",
      (f: F) => lease(f, padded(expired, kib16 + 1)),
      { ready: true },
      "500 ",
    ],
  ] as const) {
    const f = fixture();
    const token = await f.device();
    f.tables();
    f.put(stored());
    setup(f);
    const got = await f.send({ ...listCall, input }, { token });
    const items = (got.json.result as Listed | undefined)?.items ?? [];
    expect([name, `${got.status} ${items.map((i) => i.id).join()}`]).toEqual([
      name,
      want,
    ]);
    if (got.status === 500) expect(got.json.error?.message).toBe(notValid);
  }
}, 60_000);

test("list reads only the issue key interval: a floor record, comments, links and other namespaces never reach the scan, count or output", async () => {
  await withLocal(async (local) => {
    const { f, token } = await readyRows();
    const comment = {
      id: "work-1",
      body: "x".repeat(1_900_000) + "comment-marker",
    };
    f.put({ note: "floor-marker" }, {}, "allocation:issue:work-");
    f.put(comment, {}, "comment:work-1:1");
    f.put({ id: "work-1", note: "link-marker" }, {}, "link:work-1:1");
    for (const key of ["issue", "issue;", "issue;0"])
      f.put({ note: "edge-marker" }, {}, key);
    for (let n = 101; n <= 109; n++) {
      const id = `work-${n}`;
      elsewhere(f, `issue:${id}`, stored({ id, kind: "k".repeat(1_500_000) }));
    }
    const config = { idPrefix: "forge", labelOrder: [] };
    const before = f.snapshot();
    f.meter.on = true;
    for (const [input, want] of [
      [{}, "1,10,11,12,2,3,4,5,6,7,8,9"],
      [{ limit: 2 }, "1,10+"],
      [{ ready: true }, "10,11,12,4,8"],
    ] as const) {
      const name = JSON.stringify(input);
      const got = await f.send({ ...listCall, input }, { token });
      expect([name, got.status, got.exit]).toEqual([name, 200, 0]);
      expect([name, got.json.result]).toEqual([
        name,
        local(f, input, config, "issue.list"),
      ]);
      expect([name, idsOf(got.json.result as Listed)]).toEqual([name, want]);
    }
    expect(f.meter.cells.join("")).not.toMatch(
      /floor-marker|comment-marker|link-marker|edge-marker/,
    );
    expect(f.snapshot()).toBe(before);
  });
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
// Everything a write may change: the work and receipt records and their events, and the leases, never the tokens.
const writes = (f: F) =>
  JSON.stringify([
    ...["forge/work", "forge/cloud"].map((ns) => [
      rowsOf(f.db, ns),
      eventsOf(f.db, ns),
    ]),
    f.db.query("SELECT * FROM state_leases ORDER BY subject").all(),
  ]);
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

// issue.comments: the route and the real local handler read the same rows, clock and config.
const readNotes = (input: object, more = {}) => ({
  ...call,
  op: "issue.comments",
  input,
  ...more,
});
const noteRecord = (
  n: number,
  value: object = { id: "work-12", body: `c${n}` },
  id = "work-12",
) => ({
  namespace: "forge/work",
  key: `comment:${id}:${n}`,
  revision: 3,
  value,
  updatedAt: iso(start - 500),
  updatedBy: actor,
});
const suffixes = (result: unknown) =>
  (result as { records: { key: string }[] }).records.map((r) =>
    Number(r.key.split(":")[2]),
  );
// Issues 1 (acme), 3 (held by another session, no comments), 12 and 007 (old), and comments numbered 1, 2 and 10
// on issue 12 whose clocks and writers sort the other way round, one with a structured value. Issue 9 has comments but no issue.
async function noteRows() {
  const f = fixture();
  const token = await f.device();
  f.tables();
  f.put(stored({ prefix: "acme" }));
  f.put(stored({ id: "work-3" }), {}, "issue:work-3");
  f.put(stored({ id: "work-12" }), {}, "issue:work-12");
  f.put(stored({ id: "work-007", prefix: "old" }), {}, "issue:work-007");
  for (const [n, age] of [
    [10, 5000],
    [2, 3000],
    [1, 1000],
  ] as const)
    f.put(
      n === 2
        ? { id: "work-12", body: "é\n", tags: ["x", { y: [1] }] }
        : { id: "work-12", body: `c${n}` },
      {
        updatedAt: iso(start - age),
        updatedBy: { kind: "agent", id: `device-${n}` },
      },
      `comment:work-12:${n}`,
    );
  for (const key of [
    "comment:work-1:1",
    "comment:work-1:2",
    "comment:work-007:1",
    "comment:work-9:1",
  ])
    f.put({ id: key.split(":")[1], body: "other" }, {}, key);
  f.lease({ expiresAt: iso(start + 1000) }, "issue:work-3");
  return { f, token };
}

test("the cloud issue.comments agrees with the local handler on whole records, numeric order, aliases and missing issues, and reads write nothing", async () => {
  await withLocal(async (local) => {
    const { f, token } = await noteRows();
    const before = f.snapshot();
    const ids = [
      ...["forge-12", "FORGE-12", "work-12", "forge-1", "acme-1", "ACME-1"],
      ...["old-007", "forge-007", "forge-3"],
      ...["forge-9", "FORGE-9", "forge-7", "forge-0012", "zzz-1"],
    ];
    const outcomes: Record<string, unknown>[] = [];
    for (const [i, id] of ids.entries()) {
      const got = await f.send(readNotes({ id }), {
        token,
        via: i % 2 ? "direct" : createWorker(),
      });
      const want = local(f, { id }, { idPrefix: "forge" }, "issue.comments");
      const here = got.json.ok ? got.json.result : { code: got.code };
      expect([id, here]).toEqual([id, want]);
      if (got.json.ok)
        expect(got.json).toEqual({
          ok: true,
          op: "issue.comments",
          status: "OK",
          result: want,
          warnings: [],
        } as never);
      else if (got.code === "NOT_FOUND") {
        expect(got.json.error?.message).toBe(`Issue ${id} was not found`);
        // A missing issue is found before any comment is scanned.
        expect(got.touched).not.toContain(ROWS);
      }
      outcomes.push(here as Record<string, unknown>);
    }
    expect(outcomes.filter((o) => "records" in o)).toHaveLength(9);
    expect(outcomes.map((o) => ("code" in o ? o.code : "")).join()).toBe(
      ",,,,,,,,,NOT_FOUND,NOT_FOUND,NOT_FOUND,NOT_FOUND,INPUT_INVALID",
    );
    // Append numbers, never lexical order (1, 10, 2) or the clocks (10, 2, 1); other issues' comments stay out.
    expect(suffixes(outcomes[0])).toEqual([1, 2, 10]);
    expect(suffixes(outcomes[8])).toEqual([]);
    expect(outcomes[0]).toEqual({
      records: [
        {
          ...noteRecord(1),
          updatedAt: iso(start - 1000),
          updatedBy: { kind: "agent", id: "device-1" },
        },
        expect.objectContaining({
          value: { id: "work-12", body: "é\n", tags: ["x", { y: [1] }] },
        }),
        expect.objectContaining({ key: "comment:work-12:10" }),
      ],
    });
    expect(f.snapshot()).toBe(before);
  });
}, 60_000);

test("after A1 and B1 each append a comment, A1, A2 and B1 all read both in append order, as the local handler does", async () => {
  await withLocal(async (local) => {
    const f = fixture();
    f.tables();
    f.put(stored({ id: "work-12" }), {}, "issue:work-12");
    const a1 = await f.device(day, "laptop", "s1");
    const a2 = await f.device(day, "laptop", "s2");
    const b1 = await f.device(day, "tablet", "s1");
    for (const [id, token] of [
      ["w-1", a1],
      ["w-2", b1],
    ] as const)
      expect(
        (
          await f.send(note(id, { id: "forge-12", body: `from ${id}` }), {
            token,
          })
        ).status,
      ).toBe(200);
    const after = writes(f);
    const want = local(
      f,
      { id: "forge-12" },
      { idPrefix: "forge" },
      "issue.comments",
    );
    for (const token of [a1, a2, b1]) {
      const got = await f.send(readNotes({ id: "forge-12" }), { token });
      expect([got.status, got.json.result]).toEqual([200, want]);
      expect(got.text).not.toContain(token);
    }
    expect(
      (want as { records: { value: { body: string } }[] }).records.map(
        (r) => r.value.body,
      ),
    ).toEqual(["from w-1", "from w-2"]);
    expect(suffixes(want)).toEqual([1, 2]);
    // Every row, lease, receipt and event the writes left is unchanged by three reads.
    expect(writes(f)).toBe(after);
  });
}, 60_000);

test("comments need no lease, claim or show: another session's lease and a competing issue change nothing, and the lease table is never read", async () => {
  const { f, token } = await noteRows();
  f.put({ slots: [] }, {}, "slots:work-3");
  const s1 = await f.device(day, "laptop", "s1");
  const before = f.snapshot();
  for (const as of [token, s1])
    for (const [id, want] of [
      ["forge-3", []],
      ["forge-12", [1, 2, 10]],
    ] as [string, number[]][]) {
      const got = await f.send(readNotes({ id }), { token: as });
      expect([id, got.status, got.exit]).toEqual([id, 200, 0]);
      expect(suffixes(got.json.result)).toEqual(want);
      if (want.length === 0) expect(got.json.result).toEqual({ records: [] });
      expect(got.probes).toEqual([TOKENS, "state_records"]);
      expect(got.touched.filter((sql) => sql.includes("state_leases"))).toEqual(
        [],
      );
      expect(readCalls(got.touched)).toEqual([]);
    }
  expect(f.snapshot()).toBe(before);
}, 30_000);

test("bad comments input is INPUT_INVALID with no scan, whatever the extra key names, and nothing is written", async () => {
  const { f, token } = await noteRows();
  const before = f.snapshot();
  const cases: [string, unknown, string][] = [
    ["no id", {}, needsId],
    ["an extra field", { id: "forge-12", extra: 1 }, needsId],
    ["limit", { id: "forge-12", limit: 1 }, needsId],
    ["cursor", { id: "forge-12", cursor: "c" }, needsId],
    ["offset", { id: "forge-12", offset: 1 }, needsId],
    ["an id that is not text", { id: 12 }, needsId],
    ["an empty id", { id: "" }, needsId],
    ["an id over 200 characters", { id: "f".repeat(201) }, needsId],
    ["an input that is not an object", [marker], needsId],
    ["an invalid id", { id: "forge-x" }, "Invalid issue id"],
    ["an unknown prefix", { id: "zzz-1" }, "Unknown issue id prefix"],
  ];
  for (const [name, input, message] of cases) {
    const got = await f.send(readNotes(input as object), { token });
    expect([
      name,
      got.status,
      got.code,
      got.exit,
      got.json.error?.message,
    ]).toEqual([name, 400, "INPUT_INVALID", 6, message]);
    expect(got.touched).not.toContain(ROWS);
    expect(got.text).not.toContain(marker);
  }
  expect(f.snapshot()).toBe(before);
}, 30_000);

test("a comments read is refused for a session-bound token naming another session, and for another project, an owner header, an admin or an OAuth token, before any work read", async () => {
  const { f, token } = await begin();
  const s1 = await f.device(day, "laptop", "s1");
  const other = readNotes(
    { id: "forge-12" },
    { context: { actor, session: { id: marker } } },
  );
  const bad = await f.send(other, { token: s1 });
  refusal("session", bad, [403, "AUTH_DEVICE_MISMATCH", 1]);
  expect(bad.text).not.toContain(marker);
  expect(bad.text).not.toContain(s1);
  const kept = f.snapshot();
  for (const [name, options, direct] of [
    ["other project", { token, name: "other" }, true],
    ["owner header", { token, headers: { "X-Forge-Owner": "phone" } }, true],
    ["admin token", { token: vars.ADMIN_TOKEN }, true],
    ["OAuth token", { token: oauthToken }, false],
  ] as const)
    for (const via of direct
      ? (["direct", createWorker()] as const)
      : [createWorker()]) {
      const got = await f.send(readNotes({ id: "forge-12" }), {
        ...options,
        via,
      });
      expect([name, got.status, got.code, got.exit]).toEqual([
        name,
        403,
        "AUTH_FORBIDDEN",
        1,
      ]);
      expect(strayCalls(got.touched)).toEqual([]);
    }
  expect(f.snapshot()).toBe(kept);
}, 30_000);

test("a comments response is capped at 1 MiB of UTF-8 bytes, measured on the whole envelope", async () => {
  const cap = 1_048_576;
  const f = fixture();
  const token = await f.device();
  f.tables();
  f.put(stored({ id: "work-12" }), {}, "issue:work-12");
  const body = 'é"\n✓\\';
  const record = (pad: string) =>
    noteRecord(1, { id: "work-12", body: body + pad });
  const room =
    cap - bytesOf(envelope({ records: [record("")] }, "issue.comments"));
  for (const [delta, fits] of [
    [-1, true],
    [0, true],
    [1, false],
  ] as const) {
    const pad = "k".repeat(room + delta);
    f.db.run("DELETE FROM state_records WHERE key LIKE 'comment:%'");
    f.put({ id: "work-12", body: body + pad }, {}, "comment:work-12:1");
    const got = await f.send(readNotes({ id: "forge-12" }), { token });
    if (fits) {
      expect([got.status, got.bytes]).toEqual([200, cap + delta]);
      expect(got.json.result).toEqual({ records: [record(pad)] });
      expect(got.text).toBe(JSON.stringify(got.json));
    } else {
      expect([got.status, got.code, got.exit]).toEqual([503, "UNAVAILABLE", 1]);
      expect(got.json.error?.message).toBe("response too large");
      expect(got.text).not.toContain("records");
    }
  }
}, 60_000);

test("an issue over 10,000 comments or 1 MiB of them is refused as UNAVAILABLE before any body is loaded, and other issues' comments are not counted", async () => {
  const cap = 1_048_576;
  const budget = "Issue comments are over their read budget";
  const start12 = async () => {
    const f = fixture();
    const token = await f.device();
    f.tables();
    f.put(stored({ id: "work-12" }), {}, "issue:work-12");
    f.put(stored(), {}, "issue:work-1");
    return { f, token };
  };
  const rows = async (count: number) => {
    const { f, token } = await start12();
    f.db.run(
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?) INSERT INTO state_records(namespace,key,revision,body) SELECT 'forge/work','comment:work-12:'||i,3,json_object('namespace','forge/work','key','comment:work-12:'||i,'revision',3,'value',json_object('id','work-12','body',''),'updatedAt',?,'updatedBy',json_object('kind','agent','id','tester')) FROM n",
      [count, iso(start - 500)],
    );
    for (const n of [1, 2, 3, 4, 5])
      f.put({ id: "work-1", body: "" }, {}, `comment:work-1:${n}`);
    return f.send(readNotes({ id: "forge-12" }), { token });
  };
  const bytes = async (delta: number) => {
    const { f, token } = await start12();
    f.put({ id: "work-12", body: "" }, {}, "comment:work-12:1");
    // Another issue's comments, over the cap on their own, are not counted.
    for (const n of [1, 2])
      f.put(
        { id: "work-1", body: "k".repeat(1_900_000) },
        {},
        `comment:work-1:${n}`,
      );
    const { n } = f.db
      .query(
        "SELECT sum(length(CAST(body AS BLOB))) AS n FROM state_records WHERE key LIKE 'comment:work-12:%'",
      )
      .get() as { n: number };
    f.db.run(
      "UPDATE state_records SET body=replace(body,'\"body\":\"\"',?) WHERE key='comment:work-12:1'",
      ['"body":"' + "k".repeat(cap + delta - n) + '"'],
    );
    return f.send(readNotes({ id: "forge-12" }), { token });
  };
  // Even empty records are over 1 MiB well before 10,000 of them, so the byte bound decides first. At 1 MiB the bodies
  // are loaded and the response cap decides; one byte over is refused unread.
  for (const [name, got, fits] of [
    ["10,001 rows", await rows(10_001), false],
    ["1 MiB", await bytes(0), true],
    ["1 MiB and one byte", await bytes(1), false],
  ] as const) {
    expect([
      name,
      got.status,
      got.code,
      got.exit,
      got.json.error?.message,
      got.touched.includes(ROWS),
    ]).toEqual([
      name,
      503,
      "UNAVAILABLE",
      1,
      fits ? "response too large" : budget,
      fits,
    ]);
  }
}, 120_000);

test("a corrupt, mismatched or oversized stored comment is a fixed INTERNAL for the whole read, never a partial result", async () => {
  const good = { id: "work-12", body: "good-body" };
  const insert = (body: string) => (f: F) =>
    f.db.run(
      "INSERT INTO state_records(namespace,key,revision,body) VALUES ('forge/work','comment:work-12:3',3,?)",
      [body],
    );
  const cases: [string, (f: F) => void][] = [
    ["not JSON", insert("{")],
    ["not an object", insert("[]")],
    ["no wrapper", insert(JSON.stringify(good))],
    [
      "a record that fails StateRecord",
      (f) => f.put(good, { revision: "x" }, "comment:work-12:3"),
    ],
    [
      "another key",
      (f) => f.put(good, { key: "comment:work-12:9" }, "comment:work-12:3"),
    ],
    [
      "another namespace",
      (f) => f.put(good, { namespace: "forge/cloud" }, "comment:work-12:3"),
    ],
    [
      "over the 2 MiB record bound",
      (f) =>
        f.put(
          { id: "work-12", body: "k".repeat(2 * 1024 * 1024) },
          {},
          "comment:work-12:3",
        ),
    ],
  ];
  for (const [name, corrupt] of cases) {
    const f = fixture();
    const token = await f.device();
    f.tables();
    f.put(stored({ id: "work-12" }), {}, "issue:work-12");
    for (const n of [1, 2]) f.put(good, {}, `comment:work-12:${n}`);
    corrupt(f);
    const before = f.snapshot();
    const got = await f.send(readNotes({ id: "forge-12" }), { token });
    expect([
      name,
      got.status,
      got.code,
      got.exit,
      got.json.error?.message,
    ]).toEqual([name, 500, "INTERNAL", 1, notValid]);
    expect(got.text).not.toContain("good-body");
    expect(f.snapshot()).toBe(before);
  }
}, 60_000);

// issue.links: the route and the real local handler read the same rows, clock and config.
const readLinks = (input: object, more = {}) => ({
  ...call,
  op: "issue.links",
  input,
  ...more,
});
const linkValue = (id: string, n: number) => ({
  id,
  relation: n % 2 ? "delivers" : "references",
  url: `https://e.example/${id}/${n}`,
});
const linkNumbers = (result: unknown) =>
  (result as { records: { key: string }[] }).records.map((r) =>
    Number(r.key.split(":")[2]),
  );
const budgetOfLinks = "Issue links are over their read budget";
// Issues 1 (acme, one link), 3 (no links), 12 (links 1 to 11, stored out of order, with clocks and writers that sort the
// other way round) and 007 (old, one link). Rows that look like issue 12's links and are not: its comment, another
// issue's link, issue 120's link, and link 99 under issue 12 in another namespace. Issue 9 has a link but no issue.
async function linkSeed() {
  const f = fixture();
  const token = await f.device();
  f.tables();
  f.put(stored({ prefix: "acme" }));
  for (const id of ["work-3", "work-12"])
    f.put(stored({ id }), {}, `issue:${id}`);
  f.put(stored({ id: "work-007", prefix: "old" }), {}, "issue:work-007");
  for (const n of [10, 2, 11, 1, 9, 3, 8, 4, 7, 5, 6])
    f.put(
      linkValue("work-12", n),
      {
        updatedAt: iso(start - n * 1000),
        updatedBy: { kind: "agent", id: `device-${n}` },
      },
      `link:work-12:${n}`,
    );
  for (const [id, n] of [
    ["work-1", 1],
    ["work-007", 1],
    ["work-9", 1],
    ["work-120", 1],
  ] as const)
    f.put(linkValue(id, n), {}, `link:${id}:${n}`);
  f.put({ id: "work-12", body: "note" }, {}, "comment:work-12:1");
  f.put(linkValue("work-12", 99), {}, "link:work-12:99", "forge/cloud");
  return { f, token };
}

test("the cloud issue.links agrees with the local handler on whole records, numeric order, aliases and missing issues, and reads write nothing", async () => {
  await withLocal(async (local) => {
    const { f, token } = await linkSeed();
    const before = f.snapshot();
    const ids = [
      ...["forge-12", "FORGE-12", "work-12", "forge-1", "acme-1", "ACME-1"],
      ...["old-007", "forge-007", "forge-3"],
      ...["forge-9", "FORGE-9", "forge-7", "forge-0012", "zzz-1"],
    ];
    const outcomes: Record<string, unknown>[] = [];
    for (const [i, id] of ids.entries()) {
      const got = await f.send(readLinks({ id }), {
        token,
        via: i % 2 ? "direct" : createWorker(),
      });
      const want = local(f, { id }, { idPrefix: "forge" }, "issue.links");
      const here = got.json.ok ? got.json.result : { code: got.code };
      expect([id, here]).toEqual([id, want]);
      if (got.json.ok)
        expect(got.json).toEqual({
          ok: true,
          op: "issue.links",
          status: "OK",
          result: want,
          warnings: [],
        } as never);
      else if (got.code === "NOT_FOUND") {
        expect([got.status, got.exit]).toEqual([404, 3]);
        expect(got.json.error?.message).toBe(`Issue ${id} was not found`);
        // A missing issue is found before any link is scanned.
        expect(got.touched).not.toContain(ROWS);
      }
      outcomes.push(here as Record<string, unknown>);
    }
    expect(outcomes.filter((o) => "records" in o)).toHaveLength(9);
    expect(outcomes.map((o) => ("code" in o ? o.code : "")).join()).toBe(
      ",,,,,,,,,NOT_FOUND,NOT_FOUND,NOT_FOUND,NOT_FOUND,INPUT_INVALID",
    );
    // Link numbers, never lexical order (1, 10, 11, 2) or the clocks (11 first); other rows stay out.
    expect(linkNumbers(outcomes[0])).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
    expect(linkNumbers(outcomes[3])).toEqual([1]);
    expect(linkNumbers(outcomes[8])).toEqual([]);
    expect(outcomes[8]).toEqual({ records: [] });
    expect((outcomes[0] as { records: unknown[] }).records[0]).toEqual({
      namespace: "forge/work",
      key: "link:work-12:1",
      revision: 3,
      value: linkValue("work-12", 1),
      updatedAt: iso(start - 1000),
      updatedBy: { kind: "agent", id: "device-1" },
    });
    expect(f.snapshot()).toBe(before);
  });
}, 60_000);

test("issue.links passes the envelope and context checks and is answered by the route, not refused", async () => {
  const { f, token, before } = await begin();
  const named = {
    actor,
    session: { id: "s1" },
    device: { id: "laptop" },
    project: { id: "p" },
  };
  for (const context of [{ actor }, named]) {
    const got = await f.send(
      { ...call, op: "issue.links", context },
      { token },
    );
    expect([got.status, got.code, got.exit]).toEqual([404, "NOT_FOUND", 3]);
    expect(got.json.error?.message).toBe("Issue forge-1 was not found");
    expect(got.probes).toEqual([TOKENS, "state_records"]);
  }
  expect(f.snapshot()).toBe(before);
}, 30_000);

test("bad links input is INPUT_INVALID with no scan, whatever the extra key names, and nothing is written", async () => {
  const { f, token } = await linkSeed();
  const before = f.snapshot();
  const cases: [string, unknown, string][] = [
    ["no id", {}, needsId],
    ["an extra field", { id: "forge-12", extra: 1 }, needsId],
    ["limit", { id: "forge-12", limit: 1 }, needsId],
    ["cursor", { id: "forge-12", cursor: "c" }, needsId],
    ["an id that is not text", { id: 12 }, needsId],
    ["an empty id", { id: "" }, needsId],
    ["an input that is not an object", [marker], needsId],
    ["an invalid id", { id: "forge-x" }, "Invalid issue id"],
    ["an unknown prefix", { id: "zzz-1" }, "Unknown issue id prefix"],
  ];
  for (const [name, input, message] of cases) {
    const got = await f.send(readLinks(input as object), { token });
    expect([
      name,
      got.status,
      got.code,
      got.exit,
      got.json.error?.message,
    ]).toEqual([name, 400, "INPUT_INVALID", 6, message]);
    expect(got.touched).not.toContain(ROWS);
    expect(got.text).not.toContain(marker);
  }
  expect(f.snapshot()).toBe(before);
}, 30_000);

test("an issue over 10,000 links or 1 MiB of them is refused as UNAVAILABLE before any body is loaded, and other issues' links are not counted", async () => {
  const start12 = async () => {
    const f = fixture();
    const token = await f.device();
    f.tables();
    f.put(stored({ id: "work-12" }), {}, "issue:work-12");
    f.put(stored(), {}, "issue:work-1");
    f.put(
      { ...linkValue("work-1", 1), url: `https://h/${"k".repeat(2_000_000)}` },
      {},
      "link:work-1:1",
    );
    return { f, token };
  };
  const count = async () => {
    const { f, token } = await start12();
    f.db.run(
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?) INSERT INTO state_records(namespace,key,revision,body) SELECT 'forge/work','link:work-12:'||i,3,json_object('namespace','forge/work','key','link:work-12:'||i,'revision',3,'value',json_object('id','work-12','relation','x','url','https://h'),'updatedAt',?,'updatedBy',json_object('kind','agent','id','tester')) FROM n",
      [10_001, iso(start - 500)],
    );
    expect(
      f.db
        .query(
          "SELECT count(*) AS n FROM state_records WHERE key LIKE 'link:work-12:%'",
        )
        .get(),
    ).toEqual({ n: 10_001 });
    return f.send(readLinks({ id: "forge-12" }), { token });
  };
  const bytes = async () => {
    const { f, token } = await start12();
    for (const n of [1, 2])
      f.put(
        { ...linkValue("work-12", n), url: `https://h/${"k".repeat(600_000)}` },
        {},
        `link:work-12:${n}`,
      );
    return f.send(readLinks({ id: "forge-12" }), { token });
  };
  for (const [name, got] of [
    ["10,001 rows", await count()],
    ["two rows over 1 MiB together", await bytes()],
  ] as const) {
    expect([
      name,
      got.status,
      got.code,
      got.exit,
      got.json.error?.message,
      got.touched.includes(ROWS),
    ]).toEqual([name, 503, "UNAVAILABLE", 1, budgetOfLinks, false]);
  }
}, 120_000);

test("a corrupt, mismatched or oversized stored link is a fixed INTERNAL for the whole read, never a partial result", async () => {
  const good = linkValue("work-12", 3);
  const at = "link:work-12:3";
  const pristine = JSON.stringify({
    namespace: "forge/work",
    key: at,
    revision: 3,
    value: good,
    updatedAt: iso(start - 500),
    updatedBy: actor,
  });
  const insert = (body: string) => (f: F) =>
    f.db.run(
      "INSERT INTO state_records(namespace,key,revision,body) VALUES ('forge/work',?,3,?)",
      [at, body],
    );
  const cases: [string, (f: F) => void][] = [
    ["not JSON", insert("{")],
    ["not an object", insert("[]")],
    ["no wrapper", insert(JSON.stringify(good))],
    [
      "a record that fails StateRecord",
      (f) => f.put(good, { revision: "x" }, at),
    ],
    ["another key", (f) => f.put(good, { key: "link:work-12:9" }, at)],
    ["another namespace", (f) => f.put(good, { namespace: "forge/cloud" }, at)],
    [
      "over the 2 MiB record bound",
      (f) =>
        f.put(
          { ...good, url: `https://h/${"k".repeat(2 * 1024 * 1024)}` },
          {},
          at,
        ),
    ],
  ];
  for (const [name, corrupt] of cases) {
    const f = fixture();
    const token = await f.device();
    f.tables();
    f.put(stored({ id: "work-12" }), {}, "issue:work-12");
    for (const n of [1, 2])
      f.put(linkValue("work-12", n), {}, `link:work-12:${n}`);
    corrupt(f);
    // Read back the tampered row: three rows are scanned, and the one at the third key is not the good record.
    const row = f.db
      .query(
        "SELECT body FROM state_records WHERE namespace='forge/work' AND key=?",
      )
      .get(at) as { body: string } | null;
    expect([name, row === null]).toEqual([name, false]);
    expect([name, row?.body === pristine]).toEqual([name, false]);
    const scanned = f.db
      .query(
        "SELECT count(*) AS n FROM state_records WHERE namespace='forge/work' AND key LIKE 'link:work-12:%'",
      )
      .get();
    expect([name, scanned]).toEqual([name, { n: 3 }]);
    const before = f.snapshot();
    const got = await f.send(readLinks({ id: "forge-12" }), { token });
    expect([
      name,
      got.status,
      got.code,
      got.exit,
      got.json.error?.message,
    ]).toEqual([name, 500, "INTERNAL", 1, notValid]);
    expect(got.text).not.toContain("e.example");
    expect(f.snapshot()).toBe(before);
  }
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

test("the shared write path takes a project context for create and comment and a leased one for update and claim, and refuses the other as INTERNAL", async () => {
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
    ["issue.dep", depIssue, project, "leased"],
    ["issue.link", linkIssue, project, "leased"],
    ["issue.close", closeIssue, project, "leased"],
    ["issue.claim", claimIssue, project, "leased"],
    ["issue.renew", renewIssue, project, "leased"],
    ["issue.release", releaseIssue, project, "leased"],
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
  // A claim takes an acquire context: a held one is refused after the input is read, and writes nothing.
  expect(() =>
    claimIssue(db, owner, {
      requestId: "x-2",
      input: { id: "forge-12" },
      context: lease,
      device: "laptop",
      prefix: "forge",
      recheck: () => {},
    }),
  ).toThrow("issue.claim needs an acquire lease context");
  // Renew and release take a held context: an acquire one is refused after the input is read, and writes nothing.
  for (const [op, run] of [
    ["issue.renew", renewIssue],
    ["issue.release", releaseIssue],
  ] as const)
    expect(() =>
      run(db, owner, {
        requestId: "x-3",
        input: { id: "forge-12" },
        context: { ...lease, leaseMode: "acquire" } as never,
        device: "laptop",
        prefix: "forge",
        recheck: () => {},
      }),
    ).toThrow(`${op} needs a held lease context`);
  expect(f.snapshot()).toBe(before);
}, 30_000);

// issue.claim: the route and the real local handler start from the same rows, clock, config and holder.
const claim = (id: string, input: object = { id: "forge-12" }, more = {}) =>
  make(id, input, {
    op: "issue.claim",
    context: { actor, session: { id: "s1" } },
    ...more,
  });
const asSession = (id: string) => ({ context: { actor, session: { id } } });
const leasesIn = (db: Database) =>
  JSON.stringify(db.query("SELECT * FROM state_leases ORDER BY subject").all());
const requestsIn = (db: Database) =>
  JSON.stringify(
    db
      .query("SELECT * FROM state_requests ORDER BY namespace, request_id")
      .all(),
  );
// createRows, with issue 4 held by laptop session s1 until start + 1, plus issue 20 (blocked by 21, open with an
// expired lease nobody released, by the absent 99, and by 22, closed and so no blocker), 23 closed, 24, 25 and 26
// with a live, an expired and a malformed cleanup reservation, 27 with an expired lease, 28 (blocked and held by
// laptop session s2), a live reservation on the absent issue 98, and 29 and 30 as a competing and a collaborative issue.
async function claimRows() {
  const rows = await createRows();
  const { f } = rows;
  const issue = (n: number, over: object = {}) =>
    f.put(stored({ id: `work-${n}`, ...over }), {}, `issue:work-${n}`);
  f.lease({ holder, expiresAt: iso(start + 1) }, "issue:work-4");
  issue(20, { dependsOn: ["work-21", "work-99", "work-22"] });
  issue(28, { dependsOn: ["work-99"] });
  for (const n of [21, 24, 25, 26, 27]) issue(n);
  for (const n of [22, 23]) issue(n, { status: "closed" });
  f.lease({ holder, expiresAt: iso(start - 1) }, "issue:work-21");
  f.lease({ expiresAt: iso(start - 1) }, "issue:work-27");
  const other = { actor, session: { id: "s2", device: "laptop" } };
  f.lease({ holder: other, expiresAt: iso(start + 1) }, "issue:work-28");
  for (const n of [29, 30]) issue(n);
  f.put({ count: 1 }, {}, "slots:work-29");
  f.put({ holder }, {}, "participant:work-30:1");
  for (const [n, expiresAt] of [
    [24, iso(start + 5000)],
    [25, iso(start - 1)],
    [26, "junk"],
    [98, iso(start + 5000)],
  ] as const)
    f.put({ expiresAt }, {}, `cleanup:work-${n}`);
  return rows;
}
// The real local issue.claim against `twin`, as session s1 on the laptop unless given, with the runtime's own refusals.
function localClaim(
  twin: Database,
  f: F,
  requestId: string,
  input: object,
  who: { session?: string; device?: string } = {},
): { result?: unknown; error?: unknown } {
  const had = "fail" in globals,
    previous = globals.fail;
  globals.fail = refuse;
  try {
    const handlers = require(
      resolve(import.meta.dirname, "../../src/blocks/work/entry.cts"),
    ) as Record<string, Handler>;
    return {
      result: handlers["issue.claim"]!({
        input,
        config: { idPrefix: "forge" },
        services: {
          state: createStateClient({
            owner: new StateOwner(sqlOf(twin), { now: f.now }),
            namespace: "forge/work",
            context: {
              variant: "leased",
              leaseMode: "acquire",
              actor,
              session: {
                id: who.session ?? "s1",
                device: who.device ?? "laptop",
              },
              project: { id: "p" },
            },
            write: true,
            requestId,
          }),
        },
      }),
    };
  } catch (error) {
    return { error: (error as { error?: unknown }).error ?? String(error) };
  } finally {
    if (had) globals.fail = previous;
    else delete globals.fail;
  }
}
// The cloud refusal is the local one without its repair text, which names options the cloud does not take.
const withoutRepair = (error: unknown) => {
  const { repair: _repair, ...rest } = error as Record<string, unknown>;
  return rest;
};
const readyIds = async (f: F, token: string) =>
  idsOf(
    (await f.send({ ...readyCall, input: {} }, { token })).json
      .result as Listed,
  ).split(",");
// Releases issue `n` at `generation` through the raw lease route, as session s1 on the token's device.
const release = (f: F, token: string, n: number, generation: number) =>
  f.send(
    {
      subject: `issue:work-${n}`,
      holder: { actor, session: { id: "s1" } },
      generation,
      requestId: `rel-${n}-${generation}`,
    },
    { token, path: "release" },
  );

// issue.renew and issue.release: the same rows, clock, config and held lease, for the route and the local handlers.
const renewal = (id: string, input: object = { id: "forge-12" }, more = {}) =>
  make(id, input, { op: "issue.renew", context: leased, ...more });
const giveUp = (id: string, input: object = { id: "forge-12" }, more = {}) =>
  make(id, input, { op: "issue.release", context: leased, ...more });
// The real local handler for `op` against `twin`, as session s1 on the laptop holding generation 2 unless given.
const heldServices = (
  twin: Database,
  f: F,
  requestId: string,
  who: { generation?: number; session?: string },
) => ({
  state: createStateClient({
    owner: new StateOwner(sqlOf(twin), { now: f.now }),
    namespace: "forge/work",
    context: {
      variant: "leased",
      leaseMode: "held",
      actor,
      session: { id: who.session ?? "s1", device: "laptop" },
      project: { id: "p" },
      leaseGeneration: who.generation ?? 2,
    },
    write: true,
    requestId,
  }),
});
function localLease(
  op: "issue.renew" | "issue.release" | "issue.dep" | "issue.link",
  twin: Database,
  f: F,
  requestId: string,
  input: object,
  who: { generation?: number; session?: string } = {},
): { result?: unknown; error?: unknown } {
  const had = "fail" in globals,
    previous = globals.fail;
  globals.fail = refuse;
  try {
    const handlers = require(
      resolve(import.meta.dirname, "../../src/blocks/work/entry.cts"),
    ) as Record<string, Handler>;
    return {
      result: handlers[op]!({
        input,
        config: { idPrefix: "forge" },
        services: heldServices(twin, f, requestId, who),
      }),
    };
  } catch (error) {
    return { error: (error as { error?: unknown }).error ?? String(error) };
  } finally {
    if (had) globals.fail = previous;
    else delete globals.fail;
  }
}
// The real local issue.close, which is async, as localLease runs the others.
async function localClose(
  twin: Database,
  f: F,
  requestId: string,
  input: object,
  who: { generation?: number; session?: string } = {},
): Promise<{ result?: unknown; error?: unknown }> {
  const had = "fail" in globals,
    previous = globals.fail;
  globals.fail = refuse;
  try {
    const handlers = require(
      resolve(import.meta.dirname, "../../src/blocks/work/entry.cts"),
    ) as Record<string, Handler>;
    return {
      result: await handlers["issue.close"]!({
        input,
        config: { idPrefix: "forge" },
        services: heldServices(twin, f, requestId, who),
      }),
    };
  } catch (error) {
    return { error: (error as { error?: unknown }).error ?? String(error) };
  } finally {
    if (had) globals.fail = previous;
    else delete globals.fail;
  }
}

// issue.dep: the route and the real local handler start from the same rows, clock, config and held lease.
const depIn = (over: object = {}) => ({
  id: "forge-12",
  target: "forge-1",
  action: "add",
  expectRevision: 3,
  ...over,
});
const depCall = (id: string, input: object = depIn(), more = {}) =>
  make(id, input, { op: "issue.dep", context: leased, ...more });
const pile = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `work-${from + i}`);
// fenceRows, plus held open issues 40 (41 depends on it), 45 (43 depends on 44, 44 on 45), 46 (on 12), 47 (on the
// absent 99), 51 (on 99 and 1) and 52; 100 to 355 open; and held 48 and 49 on 100 to 355 (256) and 100 to 354 (255).
async function depRows() {
  const rows = await fenceRows();
  const { f } = rows;
  const put = (n: number, over: object = {}, held = false) => {
    f.put(stored({ id: `work-${n}`, ...over }), {}, `issue:work-${n}`);
    if (held) f.lease({ holder }, `issue:work-${n}`);
  };
  put(40, {}, true);
  put(41, { dependsOn: ["work-40"] });
  put(43, { dependsOn: ["work-44"] });
  put(44, { dependsOn: ["work-45"] });
  put(45, {}, true);
  put(46, { dependsOn: ["work-12"] }, true);
  put(47, { dependsOn: ["work-99"] }, true);
  put(51, { dependsOn: ["work-99", "work-1"] }, true);
  put(52, {}, true);
  for (let n = 100; n < 356; n++) put(n);
  put(48, { dependsOn: pile(100, 355) }, true);
  put(49, { dependsOn: pile(100, 354) }, true);
  return rows;
}

test("the cloud issue.dep agrees with the local handler on whole results, rows, leases and events, for adds, removes, repeats, aliases, a dangling removal and the 256th dependency", async () => {
  const { f, token } = await depRows();
  const twin = Database.deserialize(f.db.serialize());
  const cases: [string, object][] = [
    ["d-0", depIn()],
    ["d-1", depIn({ id: "forge-20", target: "forge-12" })],
    ["d-2", depIn({ id: "forge-1", target: "forge-4", action: "remove" })],
    ["d-3", depIn({ id: "forge-46", target: "forge-12", action: "remove" })],
    ["d-4", depIn({ id: "acme-40", target: "old-4" })],
    ["d-5", depIn({ id: "FORGE-45", target: "WORK-12" })],
    ["d-6", depIn({ id: "work-52", target: "Acme-1" })],
    ["d-7", depIn({ id: "forge-47", target: "forge-99", action: "remove" })],
    ["d-8", depIn({ id: "forge-49", target: "forge-12" })],
  ];
  const touched = [12, 20, 1, 46, 40, 45, 52, 47, 49].map(
    (n) => `issue:work-${n}`,
  );
  const others = () =>
    JSON.stringify(
      rowsOf(f.db, "forge/work").filter((r) => !touched.includes(r.key)),
    );
  const before = [others(), leasesIn(f.db)];
  for (const [i, [requestId, input]] of cases.entries()) {
    const got = await f.send(depCall(requestId, input), {
      token,
      via: i % 2 ? "direct" : createWorker(),
    });
    const want = localLease("issue.dep", twin, f, requestId, input);
    expect([requestId, got.status, got.exit]).toEqual([requestId, 200, 0]);
    expect(got.json).toEqual({
      ok: true,
      op: "issue.dep",
      status: "OK",
      result: want.result,
      warnings: [],
    } as never);
  }
  expect(eventsOf(f.db, "forge/work")).toEqual(eventsOf(twin, "forge/work"));
  expect(eventsOf(f.db, "forge/work")).toHaveLength(cases.length);
  expect(rowsOf(f.db, "forge/work")).toEqual(rowsOf(twin, "forge/work"));
  expect(rowsOf(f.db, "forge/cloud")).toHaveLength(cases.length);
  expect([others(), leasesIn(f.db)]).toEqual(before);
  const row = (n: number) =>
    (
      JSON.parse(issueRow(f, `issue:work-${n}`)!.body) as {
        value: { dependsOn: string[] };
      }
    ).value.dependsOn;
  expect([row(12), row(46), row(47)]).toEqual([["work-1"], [], []]);
  expect(row(49)).toHaveLength(256);
}, 60_000);

test("an added dependency blocks its issue until it is removed, and a removed one makes it eligible again", async () => {
  const { f, token } = await depRows();
  const free = () =>
    f.db.run("DELETE FROM state_leases WHERE subject='issue:work-12'");
  const hold = () => f.lease({ holder }, "issue:work-12");
  const ready = () => readyIds(f, token);
  free();
  expect(await ready()).toContain("12");
  hold();
  expect((await f.send(depCall("e-1"), { token })).status).toBe(200);
  free();
  expect(await ready()).not.toContain("12");
  hold();
  const removed = await f.send(
    depCall("e-2", depIn({ action: "remove", expectRevision: 4 })),
    { token },
  );
  expect(removed.status).toBe(200);
  free();
  expect(await ready()).toContain("12");
}, 60_000);

test("issue.dep refuses a missing target, a cycle, a self dependency, the 257th dependency, a stale revision and every lease the caller does not hold with the local code and message, writes nothing and records nothing, so a retry runs again", async () => {
  const { f, token } = await depRows();
  const twin = Database.deserialize(f.db.serialize());
  const before = writes(f);
  const gone = [404, "NOT_FOUND", 3] as const;
  const clash = [409, "INPUT_CONFLICT", 4] as const;
  const held = [409, "LEASE_NOT_HELD", 4] as const;
  const stale = [409, "LEASE_STALE", 4] as const;
  type Who = { generation?: number; session?: string };
  const refusals: [string, object, Who, readonly [number, string, number]][] = [
    ["missing target", depIn({ target: "forge-99" }), {}, gone],
    ["missing target, as written", depIn({ target: "FORGE-99" }), {}, gone],
    [
      "removal while another dependency is missing",
      depIn({ id: "forge-51", target: "forge-1", action: "remove" }),
      {},
      gone,
    ],
    ["direct cycle", depIn({ id: "forge-40", target: "forge-41" }), {}, clash],
    ["longer cycle", depIn({ id: "forge-45", target: "forge-43" }), {}, clash],
    ["self dependency", depIn({ target: "forge-12" }), {}, clash],
    [
      "the 257th dependency",
      depIn({ id: "forge-48" }),
      {},
      [400, "INPUT_INVALID", 6],
    ],
    [
      "stale revision",
      depIn({ expectRevision: 4 }),
      {},
      [409, "REVISION_CONFLICT", 4],
    ],
    ["no lease", depIn({ id: "forge-31" }), {}, held],
    ["another device", depIn({ id: "forge-32" }), {}, held],
    ["another session", depIn({ id: "forge-33" }), {}, held],
    ["the caller names another session", depIn(), { session: "s2" }, held],
    ["an older generation", depIn(), { generation: 1 }, stale],
    ["a newer generation", depIn(), { generation: 3 }, stale],
    ["expired", depIn({ id: "forge-34" }), {}, [409, "LEASE_EXPIRED", 4]],
    ["released", depIn({ id: "forge-35" }), {}, held],
  ];
  for (const [i, [name, input, who, want]] of refusals.entries()) {
    const context = {
      actor,
      session: { id: who.session ?? "s1" },
      leaseGeneration: who.generation ?? 2,
    };
    const run = () => f.send(depCall(`f-${i}`, input, { context }), { token });
    const got = await run();
    const local = localLease("issue.dep", twin, f, `f-${i}`, input, who);
    expect([name, got.status, got.code, got.exit]).toEqual([name, ...want]);
    expect(local.error).toBeDefined();
    expect([name, got.json.error]).toEqual([
      name,
      withoutRepair(local.error),
    ] as never);
    expect([name, writes(f)]).toEqual([name, before]);
    const again = await run();
    expect([name, again.text]).toEqual([name, got.text]);
    expect([name, writes(f)]).toEqual([name, before]);
  }
  // No refusal receipt blocks a retry: the same request id works once the caller holds the lease.
  f.lease({ holder }, "issue:work-31");
  const retry = await f.send(
    depCall("f-0", depIn({ id: "forge-31" }), { context: leased }),
    { token },
  );
  expect(retry.status).toBe(200);
}, 120_000);

test("an absent issue is NOT_FOUND with the id as written, even when the target is malformed, and is recorded once per request id", async () => {
  const { f, token } = await depRows();
  const twin = Database.deserialize(f.db.serialize());
  const before = work(f);
  const cases: [string, object][] = [
    ["absent", depIn({ id: "forge-98" })],
    ["absent, as written", depIn({ id: "FORGE-98" })],
    ["absent, historical prefix", depIn({ id: "old-98" })],
    ["absent, malformed target", depIn({ id: "forge-98", target: "nope" })],
    [
      "absent, unknown target prefix",
      depIn({ id: "forge-98", target: "zzz-1" }),
    ],
  ];
  for (const [i, [name, input]] of cases.entries()) {
    const run = () => f.send(depCall(`a-${i}`, input), { token });
    const got = await run();
    const local = localLease("issue.dep", twin, f, `a-${i}`, input);
    expect([name, got.status, got.code, got.exit]).toEqual([
      name,
      404,
      "NOT_FOUND",
      3,
    ]);
    expect([name, got.json.error]).toEqual([
      name,
      withoutRepair(local.error),
    ] as never);
    expect([name, work(f)]).toEqual([name, before]);
    expect(receiptOf(f, `a-${i}`)).toMatchObject({
      outcome: "refused",
      result: got.json.error,
    });
    expect([name, (await run()).text]).toEqual([name, got.text]);
  }
}, 60_000);

test("a dependency walk over 10,000 issues is answered, 10,001 is refused as UNAVAILABLE, and a long chain never overflows the stack", async () => {
  for (const [length, want] of [
    [10_000, 200],
    [10_001, 503],
  ] as const) {
    const { f, token } = await updateRows();
    // Issues 1000 to 999 + length, each depending on the next; the held issue 52 joins the head.
    f.db.run(
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?) INSERT INTO state_records(namespace,key,revision,body) SELECT 'forge/work','issue:work-'||(999+i),3,json_object('namespace','forge/work','key','issue:work-'||(999+i),'revision',3,'value',json_object('id','work-'||(999+i),'title','t','status','open','labels',json('[]'),'dependsOn',json(CASE WHEN i<? THEN json_array('work-'||(1000+i)) ELSE '[]' END),'createdAt',?),'updatedAt',?,'updatedBy',json_object('kind','agent','id','tester')) FROM n",
      [length, length, iso(start - 1000), iso(start - 500)],
    );
    f.put(stored({ id: "work-52" }), {}, "issue:work-52");
    f.lease({ holder }, "issue:work-52");
    const before = writes(f);
    const got = await f.send(
      depCall("w-1", depIn({ id: "forge-52", target: "forge-1000" })),
      { token },
    );
    expect([length, got.status]).toEqual([length, want]);
    if (want === 200)
      expect(got.json.result).toMatchObject({ dependsOn: ["forge-1000"] });
    else {
      expect(got.code).toBe("UNAVAILABLE");
      expect(writes(f)).toBe(before);
    }
  }
}, 120_000);

test("bad issue.dep input is refused as INPUT_INVALID with one refusal receipt per fresh request id, replayed unchanged, and nothing is written", async () => {
  const { f, token } = await updateRows();
  const before = work(f);
  const cases: [string, object][] = [
    ["no id", { target: "forge-1", action: "add", expectRevision: 3 }],
    ["no target", { id: "forge-12", action: "add", expectRevision: 3 }],
    ["no action", { id: "forge-12", target: "forge-1", expectRevision: 3 }],
    ["no revision", { id: "forge-12", target: "forge-1", action: "add" }],
    ["unknown action", depIn({ action: "toggle" })],
    ["unknown key", depIn({ extra: marker })],
    ["caller key", depIn({ key: "issue:work-12" })],
    ["dependsOn", depIn({ dependsOn: ["forge-1"] })],
    ["zero revision", depIn({ expectRevision: 0 })],
    ["fractional revision", depIn({ expectRevision: 1.5 })],
    ["revision as text", depIn({ expectRevision: "3" })],
    ["empty target", depIn({ target: "" })],
    ["target not text", depIn({ target: 1 })],
    ["malformed id", depIn({ id: "nope" })],
    ["unknown id prefix", depIn({ id: "zzz-1" })],
    ["malformed target", depIn({ target: "nope" })],
    ["unknown target prefix", depIn({ target: "zzz-1" })],
  ];
  const texts: string[] = [];
  for (const [i, [name, input]] of cases.entries()) {
    const got = await f.send(depCall(`b-${i}`, input), { token });
    expect([name, got.status, got.code, got.exit]).toEqual([
      name,
      400,
      "INPUT_INVALID",
      6,
    ]);
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
  const again = await f.send(depCall("b-0", cases[0]![1]), { token });
  expect([again.status, again.text]).toEqual([400, texts[0]!]);
  const changed = await f.send(depCall("b-0"), { token });
  expect([changed.status, changed.code, changed.exit]).toEqual([
    409,
    "INPUT_CONFLICT",
    4,
  ]);
  const unnamed = depCall("b-99", cases[0]![1], { requestId: "bad id!" });
  expect((await f.send(unnamed, { token })).status).toBe(400);
  expect(f.snapshot()).toBe(done);
}, 60_000);

// issue.close without a receipt: the route and the real local handler start from the same rows, clock, config and held lease.
const closeIn = (over: object = {}) => ({
  id: "forge-12",
  withoutReceipt: "done",
  ...over,
});
const closeCall = (id: string, input: object = closeIn(), more = {}) =>
  make(id, input, { op: "issue.close", context: leased, ...more });
const noReceipt = "issue.close with a receipt is not supported in cloud yet";
const valueOf = (f: F, n: number) =>
  (
    JSON.parse(issueRow(f, `issue:work-${n}`)!.body) as {
      value: Record<string, unknown>;
    }
  ).value;
// fenceRows, plus held issues 60 (closed, an old receipt and reason), 61 (an old exemption), 62 (slots and a selection),
// 63 (slots, no selection) and 65 (an old receipt), and 64 (slots, no selection) that nobody holds.
async function closeRows() {
  const rows = await fenceRows();
  const { f } = rows;
  const put = (n: number, over: object = {}, held = true) => {
    f.put(stored({ id: `work-${n}`, ...over }), {}, `issue:work-${n}`);
    if (held) f.lease({ holder }, `issue:work-${n}`);
  };
  put(60, { status: "closed", receipt: "forge-9", closeReason: "old" });
  put(61, { withoutReceipt: "old exemption" });
  put(62);
  put(63);
  put(64, {}, false);
  put(65, { receipt: "forge-9" });
  for (const n of [62, 63, 64])
    f.put({ count: 2, next: 0 }, {}, `slots:work-${n}`);
  f.put({ attempt: "attempt-1", reason: "r" }, {}, "selection:work-62");
  return rows;
}

test("the cloud issue.close agrees with the local handler on whole results, rows, leases and events, for a reason, a replaced receipt or exemption, a closed issue, a selected competing issue and every id form", async () => {
  const { f, token } = await closeRows();
  const twin = Database.deserialize(f.db.serialize());
  const cases: [string, object][] = [
    ["x-0", closeIn()],
    ["x-1", closeIn({ id: "acme-1", reason: 'é\n"x"' })],
    [
      "x-2",
      closeIn({
        id: "FORGE-20",
        withoutReceipt: "w".repeat(2000),
        reason: "r".repeat(2000),
      }),
    ],
    ["x-3", closeIn({ id: "work-60" })],
    ["x-4", closeIn({ id: "forge-61", reason: "again" })],
    ["x-5", closeIn({ id: "forge-65" })],
    ["x-6", closeIn({ id: "forge-62" })],
  ];
  const touched = [12, 1, 20, 60, 61, 65, 62].map((n) => `issue:work-${n}`);
  const others = () =>
    JSON.stringify(
      rowsOf(f.db, "forge/work").filter((r) => !touched.includes(r.key)),
    );
  const before = [others(), leasesIn(f.db)];
  for (const [i, [requestId, input]] of cases.entries()) {
    const got = await f.send(closeCall(requestId, input), {
      token,
      via: i % 2 ? "direct" : createWorker(),
    });
    const want = await localClose(twin, f, requestId, input);
    expect([requestId, got.status, got.exit]).toEqual([requestId, 200, 0]);
    expect(got.json).toEqual({
      ok: true,
      op: "issue.close",
      status: "OK",
      result: want.result,
      warnings: [],
    } as never);
  }
  expect(eventsOf(f.db, "forge/work")).toEqual(eventsOf(twin, "forge/work"));
  expect(eventsOf(f.db, "forge/work")).toHaveLength(cases.length);
  expect(rowsOf(f.db, "forge/work")).toEqual(rowsOf(twin, "forge/work"));
  expect(rowsOf(f.db, "forge/cloud")).toHaveLength(cases.length);
  // Every lease stays held, and no other issue moves.
  expect([others(), leasesIn(f.db)]).toEqual(before);
  expect(leasesIn(f.db)).toBe(leasesIn(twin));
  // The reason is stored and never shown; a new exemption replaces the old receipt and exemption.
  expect(valueOf(f, 12)).toMatchObject({
    status: "closed",
    withoutReceipt: "done",
  });
  expect(valueOf(f, 12)).not.toHaveProperty("closeReason");
  expect(valueOf(f, 1)).toMatchObject({ closeReason: 'é\n"x"' });
  for (const n of [60, 65]) expect(valueOf(f, n)).not.toHaveProperty("receipt");
  expect(valueOf(f, 61)).toMatchObject({ withoutReceipt: "done" });
}, 60_000);

test("a closed issue is no longer eligible, and the caller still holds its lease and can close it again", async () => {
  const { f, token } = await closeRows();
  const free = () =>
    f.db.run("DELETE FROM state_leases WHERE subject='issue:work-12'");
  const hold = () => f.lease({ holder }, "issue:work-12");
  free();
  expect(await readyIds(f, token)).toContain("12");
  hold();
  const held = leasesIn(f.db);
  const first = await f.send(closeCall("e-1"), { token });
  expect([first.status, first.json.result]).toMatchObject([
    200,
    { status: "closed", lease: { generation: 2 } },
  ]);
  expect(leasesIn(f.db)).toBe(held);
  const again = await f.send(closeCall("e-2", closeIn({ reason: "twice" })), {
    token,
  });
  expect([again.status, again.json.result]).toMatchObject([
    200,
    { status: "closed", revision: 5 },
  ]);
  expect(leasesIn(f.db)).toBe(held);
  free();
  expect(await readyIds(f, token)).not.toContain("12");
}, 60_000);

test("issue.close refuses no reason, a competing issue and every lease the caller does not hold with the local code, message and repair, writes nothing and records nothing, so a retry runs again", async () => {
  const { f, token } = await closeRows();
  const twin = Database.deserialize(f.db.serialize());
  const before = writes(f);
  const clash = [409, "INPUT_CONFLICT", 4] as const;
  const held = [409, "LEASE_NOT_HELD", 4] as const;
  const stale = [409, "LEASE_STALE", 4] as const;
  const needed = [400, "RECEIPT_REQUIRED", 1] as const;
  type Who = { generation?: number; session?: string };
  const refusals: [string, object, Who, readonly [number, string, number]][] = [
    ["no reason", { id: "forge-12" }, {}, needed],
    ["no reason, no lease", { id: "forge-31" }, {}, needed],
    ["no reason, competing", { id: "forge-63" }, {}, clash],
    ["no reason, competing, no lease", { id: "forge-64" }, {}, held],
    ["competing", closeIn({ id: "forge-63" }), {}, clash],
    ["competing, no lease", closeIn({ id: "forge-64" }), {}, held],
    ["no lease", closeIn({ id: "forge-31" }), {}, held],
    ["another device", closeIn({ id: "forge-32" }), {}, held],
    ["another session", closeIn({ id: "forge-33" }), {}, held],
    ["the caller names another session", closeIn(), { session: "s2" }, held],
    ["an older generation", closeIn(), { generation: 1 }, stale],
    ["a newer generation", closeIn(), { generation: 3 }, stale],
    ["expired", closeIn({ id: "forge-34" }), {}, [409, "LEASE_EXPIRED", 4]],
    ["released", closeIn({ id: "forge-35" }), {}, held],
  ];
  for (const [i, [name, input, who, want]] of refusals.entries()) {
    const context = {
      actor,
      session: { id: who.session ?? "s1" },
      leaseGeneration: who.generation ?? 2,
    };
    const run = () =>
      f.send(closeCall(`f-${i}`, input, { context }), { token });
    const got = await run();
    const local = await localClose(twin, f, `f-${i}`, input, who);
    expect([name, got.status, got.code, got.exit]).toEqual([name, ...want]);
    expect(local.error).toBeDefined();
    // The competing refusal carries its repair; the lease engine's refusals have none to match.
    expect([name, got.json.error]).toEqual([
      name,
      want === clash ? local.error : withoutRepair(local.error),
    ] as never);
    expect([name, writes(f)]).toEqual([name, before]);
    const again = await run();
    expect([name, again.text]).toEqual([name, got.text]);
    expect([name, writes(f)]).toEqual([name, before]);
  }
  // No refusal receipt blocks a retry: the same request id works once the caller holds the lease.
  f.lease({ holder }, "issue:work-31");
  const retry = await f.send(
    closeCall("f-6", closeIn({ id: "forge-31" }), { context: leased }),
    { token },
  );
  expect(retry.status).toBe(200);
}, 120_000);

test("an absent issue is NOT_FOUND with the id as written, and is recorded once per request id", async () => {
  const { f, token } = await closeRows();
  const twin = Database.deserialize(f.db.serialize());
  const before = work(f);
  const cases: [string, object][] = [
    ["absent", closeIn({ id: "forge-98" })],
    ["absent, as written", closeIn({ id: "FORGE-98" })],
    ["absent, historical prefix", closeIn({ id: "old-98" })],
    ["absent, no reason", { id: "forge-98" }],
  ];
  for (const [i, [name, input]] of cases.entries()) {
    const run = () => f.send(closeCall(`a-${i}`, input), { token });
    const got = await run();
    const local = await localClose(twin, f, `a-${i}`, input);
    expect([name, got.status, got.code, got.exit]).toEqual([
      name,
      404,
      "NOT_FOUND",
      3,
    ]);
    expect([name, got.json.error]).toEqual([
      name,
      withoutRepair(local.error),
    ] as never);
    expect([name, work(f)]).toEqual([name, before]);
    expect(receiptOf(f, `a-${i}`)).toMatchObject({
      outcome: "refused",
      result: got.json.error,
    });
    expect([name, (await run()).text]).toEqual([name, got.text]);
  }
}, 60_000);

test("bad issue.close input and a receipt are refused as INPUT_INVALID with one refusal receipt per fresh request id, replayed unchanged, and nothing is written", async () => {
  const { f, token } = await closeRows();
  const before = work(f);
  const id = "forge-12";
  const cases: [string, object, boolean][] = [
    ["no id", { withoutReceipt: "x" }, false],
    ["blank exemption", closeIn({ withoutReceipt: "  \n" }), false],
    ["empty exemption", closeIn({ withoutReceipt: "" }), false],
    ["exemption not text", closeIn({ withoutReceipt: 1 }), false],
    [
      "over-long exemption",
      closeIn({ withoutReceipt: "x".repeat(2001) }),
      false,
    ],
    ["over-long reason", closeIn({ reason: "x".repeat(2001) }), false],
    ["reason not text", closeIn({ reason: 1 }), false],
    ["unknown key", closeIn({ extra: marker }), false],
    ["caller key", closeIn({ key: "issue:work-12" }), false],
    ["revision", closeIn({ expectRevision: 3 }), false],
    ["malformed id", closeIn({ id: "nope" }), false],
    ["unknown id prefix", closeIn({ id: "zzz-1" }), false],
    ["id not text", closeIn({ id: 12 }), false],
    ["a receipt", { id, receipt: "forge-5" }, true],
    ["a receipt and an exemption", closeIn({ receipt: "forge-5" }), true],
    [
      "a receipt on an absent issue",
      { id: "forge-98", receipt: "forge-5" },
      true,
    ],
    ["a malformed receipt", { id, receipt: "nope" }, true],
    ["a null receipt", { id, receipt: null }, true],
  ];
  const texts: string[] = [];
  for (const [i, [name, input, byName]] of cases.entries()) {
    const got = await f.send(closeCall(`b-${i}`, input), { token });
    expect([name, got.status, got.code, got.exit]).toEqual([
      name,
      400,
      "INPUT_INVALID",
      6,
    ]);
    // A receipt is refused by name; no refusal repeats what the caller sent.
    expect([name, got.json.error?.message === noReceipt]).toEqual([
      name,
      byName,
    ]);
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
  const again = await f.send(closeCall("b-0", cases[0]![1]), { token });
  expect([again.status, again.text]).toEqual([400, texts[0]!]);
  const changed = await f.send(closeCall("b-0"), { token });
  expect([changed.status, changed.code, changed.exit]).toEqual([
    409,
    "INPUT_CONFLICT",
    4,
  ]);
  const unnamed = closeCall("b-99", cases[0]![1], { requestId: "bad id!" });
  expect((await f.send(unnamed, { token })).status).toBe(400);
  expect(f.snapshot()).toBe(done);
}, 60_000);

// issue.link: the route and the real local handler start from the same rows, clock, config and held lease.
const linkIn = (over: object = {}) => ({
  id: "forge-12",
  relation: "delivers",
  url: "https://github.com/o/r/pull/1",
  ...over,
});
const linkCall = (id: string, input: object = linkIn(), more = {}) =>
  make(id, input, { op: "issue.link", context: leased, ...more });
const linkKey = (n: number, i: number) => `link:work-${n}:${i}`;
const linkShape =
  "input must be { id, relation, url } with a valid issue id, relation and URL";
const linkUrl = "Links require an http or https URL";
const readback =
  "Accepted write did not match its readback; reconcile before retrying";
const linksOf = (f: F, n: number) =>
  rowsOf(f.db, "forge/work").filter((r) => r.key.startsWith(`link:work-${n}:`));
// fenceRows, plus held issues 70 (closed), 71 (slots, no selection), 72 (a participant), 73 (links 1 and 3) and 74
// (links 1 to 9), 75 (link 1, a lease on that link alone), and a lease on issue 4 so its old prefix can be named.
async function linkRows() {
  const rows = await fenceRows();
  const { f } = rows;
  const put = (n: number, over: object = {}, held = true) => {
    f.put(stored({ id: `work-${n}`, ...over }), {}, `issue:work-${n}`);
    if (held) f.lease({ holder }, `issue:work-${n}`);
  };
  const seed = (n: number, ...at: number[]) => {
    for (const i of at)
      f.put(
        {
          id: `work-${n}`,
          relation: "references",
          url: `https://e.example/${i}`,
        },
        {},
        linkKey(n, i),
      );
  };
  put(70, { status: "closed" });
  put(71);
  put(72);
  f.put({ count: 2, next: 0 }, {}, "slots:work-71");
  f.put({ holder }, {}, "participant:work-72:1");
  put(73);
  seed(73, 1, 3);
  put(74);
  seed(74, 1, 2, 3, 4, 5, 6, 7, 8, 9);
  put(75, {}, false);
  seed(75, 1);
  f.lease({ holder }, linkKey(75, 1));
  f.lease({ holder }, "issue:work-4");
  return rows;
}
// The local pattern /^https?:\/\/[^\s/]+(?:\/[^\s]*)?$/ decides, with no trimming, parsing or host policy.
const URLS: [string, string, boolean][] = [
  ["a bare host", "https://h", true],
  ["a root path", "http://h/", true],
  ["credentials, port, query and fragment", "https://u:p@h:8080/p?q=1#f", true],
  ["a query on the host", "https://h?q=1", true],
  ["an upper case scheme", "HTTPS://h/a", false],
  ["ftp", "ftp://h/a", false],
  ["a relative URL", "/a/b", false],
  ["an empty authority", "https:///a", false],
  ["no host", "https://", false],
  ["whitespace within", "https://h/a b", false],
  ["a leading space", " https://h", false],
  ["a terminal line break", "https://h/a\n", false],
];

test("the cloud issue.link agrees with the local handler on whole records, rows, leases and events, for duplicates, aliases, any issue state, suffixes past 9 and every URL the local pattern accepts or refuses", async () => {
  const { f, token } = await linkRows();
  const twin = Database.deserialize(f.db.serialize());
  const issues = () =>
    JSON.stringify(
      rowsOf(f.db, "forge/work").filter((r) => r.key.startsWith("issue:")),
    );
  const before = [issues(), leasesIn(f.db)];
  const long = `a${"b".repeat(49)}`;
  const cases: [string, object, boolean][] = [
    ["delivers", linkIn(), true],
    [
      "references over http",
      linkIn({ relation: "references", url: "http://h.example/a" }),
      true,
    ],
    ["a relation of 50 characters", linkIn({ relation: long }), true],
    ["the same value again", linkIn(), true],
    ["a historical prefix", linkIn({ id: "acme-1" }), true],
    ["the old prefix", linkIn({ id: "old-4" }), true],
    ["the work prefix", linkIn({ id: "work-20" }), true],
    ["upper case", linkIn({ id: "FORGE-20" }), true],
    ["a closed issue", linkIn({ id: "forge-70" }), true],
    ["slots and no selection", linkIn({ id: "forge-71" }), true],
    ["a participant", linkIn({ id: "forge-72" }), true],
    ["past suffix 9", linkIn({ id: "forge-74" }), true],
    [
      "a URL of 2000 characters",
      linkIn({ url: `https://h/${"a".repeat(1990)}` }),
      true,
    ],
    ...URLS.map(([name, url, ok]): [string, object, boolean] => [
      name,
      linkIn({ url }),
      ok,
    ]),
  ];
  const keys: string[] = [];
  for (const [i, [name, input, ok]] of cases.entries()) {
    const requestId = `k-${i}`;
    const got = await f.send(linkCall(requestId, input), {
      token,
      via: i % 2 ? "direct" : createWorker(),
    });
    const want = localLease("issue.link", twin, f, requestId, input);
    if (ok) {
      expect([name, got.status, got.exit]).toEqual([name, 200, 0]);
      expect([name, got.json]).toEqual([
        name,
        {
          ok: true,
          op: "issue.link",
          status: "OK",
          result: want.result,
          warnings: [],
        },
      ] as never);
      keys.push((want.result as { key: string }).key);
    } else {
      expect([name, got.status, got.code, got.exit]).toEqual([
        name,
        400,
        "INPUT_INVALID",
        6,
      ]);
      expect([name, got.json.error]).toEqual([
        name,
        withoutRepair(want.error),
      ] as never);
      expect([name, got.json.error?.message]).toEqual([name, linkUrl]);
    }
  }
  // Each accepted request appended at the count plus one under the stored id, the duplicate included.
  expect(keys).toEqual([
    ...[1, 2, 3, 4].map((i) => linkKey(12, i)),
    linkKey(1, 1),
    linkKey(4, 1),
    linkKey(20, 1),
    linkKey(20, 2),
    linkKey(70, 1),
    linkKey(71, 1),
    linkKey(72, 1),
    linkKey(74, 10),
    linkKey(12, 5),
    ...URLS.filter(([, , ok]) => ok).map((_, i) => linkKey(12, 6 + i)),
  ]);
  expect(JSON.parse(linksOf(f, 12)[0]!.body)).toEqual({
    namespace: "forge/work",
    key: linkKey(12, 1),
    revision: 1,
    value: { id: "work-12", relation: "delivers", url: linkIn().url },
    updatedAt: iso(start),
    updatedBy: actor,
  });
  expect(eventsOf(f.db, "forge/work")).toEqual(eventsOf(twin, "forge/work"));
  expect(eventsOf(f.db, "forge/work")).toHaveLength(keys.length);
  expect(rowsOf(f.db, "forge/work")).toEqual(rowsOf(twin, "forge/work"));
  expect(leasesIn(f.db)).toBe(leasesIn(twin));
  expect(rowsOf(f.db, "forge/cloud")).toHaveLength(cases.length);
  // A link changes no issue row, revision or lease, so nothing becomes eligible or blocked.
  expect([issues(), leasesIn(f.db)]).toEqual(before);
}, 120_000);

test("issue.link refuses an absent issue, a bad URL, a bad id and bad input in the local order, records one refusal per fresh request id, replays it unchanged and writes nothing", async () => {
  const { f, token } = await linkRows();
  const twin = Database.deserialize(f.db.serialize());
  const before = work(f);
  const gone = [404, "NOT_FOUND", 3] as const;
  const bad = [400, "INPUT_INVALID", 6] as const;
  const padded = (n: number) => `forge-${"0".repeat(n - 8)}12`;
  const base = { relation: "delivers", url: "https://h" };
  // [name, input, [status, code, exit], "local" for the local refusal, else the cloud's fixed message]
  const cases: [string, object, readonly [number, string, number], string][] = [
    ["absent", linkIn({ id: "forge-99" }), gone, "local"],
    ["absent, as written", linkIn({ id: "FORGE-99" }), gone, "local"],
    ["absent, 200 characters", linkIn({ id: padded(200) }), gone, "local"],
    [
      "absent and a bad URL",
      linkIn({ id: "FORGE-99", url: "ftp://h" }),
      gone,
      "local",
    ],
    [
      "a bad URL and no lease",
      linkIn({ id: "forge-31", url: "ftp://h" }),
      bad,
      "local",
    ],
    ["a malformed id", linkIn({ id: "nope" }), bad, "Invalid issue id"],
    [
      "a foreign prefix",
      linkIn({ id: "zzz-1" }),
      bad,
      "Unknown issue id prefix",
    ],
    ["no id", base, bad, linkShape],
    ["no relation", { id: "forge-12", url: "https://h" }, bad, linkShape],
    ["no url", { id: "forge-12", relation: "delivers" }, bad, linkShape],
    ["id not text", linkIn({ id: 12 }), bad, linkShape],
    ["relation not text", linkIn({ relation: 1 }), bad, linkShape],
    ["url not text", linkIn({ url: null }), bad, linkShape],
    ["id of 201 characters", linkIn({ id: padded(201) }), bad, linkShape],
    ["an empty relation", linkIn({ relation: "" }), bad, linkShape],
    [
      "an upper case relation",
      linkIn({ relation: "Delivers" }),
      bad,
      linkShape,
    ],
    [
      "a relation that starts with a digit",
      linkIn({ relation: "1a" }),
      bad,
      linkShape,
    ],
    [
      "a relation with an underscore",
      linkIn({ relation: "a_b" }),
      bad,
      linkShape,
    ],
    [
      "a relation of 51 characters",
      linkIn({ relation: `a${"b".repeat(50)}` }),
      bad,
      linkShape,
    ],
    ["an empty url", linkIn({ url: "" }), bad, linkShape],
    [
      "a url of 2001 characters",
      linkIn({ url: `https://h/${"a".repeat(1991)}` }),
      bad,
      linkShape,
    ],
    ["an unknown key", linkIn({ extra: marker }), bad, linkShape],
    ["a subject", linkIn({ subject: "issue:work-12" }), bad, linkShape],
    ["a namespace", linkIn({ namespace: "forge/work" }), bad, linkShape],
    ["a key", linkIn({ key: linkKey(12, 1) }), bad, linkShape],
    ["a revision", linkIn({ expectRevision: 0 }), bad, linkShape],
  ];
  for (const [i, [name, input, want, check]] of cases.entries()) {
    const run = () => f.send(linkCall(`b-${i}`, input), { token });
    const got = await run();
    expect([name, got.status, got.code, got.exit]).toEqual([name, ...want]);
    if (check === "local") {
      const local = localLease("issue.link", twin, f, `b-${i}`, input);
      expect(local.error).toBeDefined();
      expect([name, got.json.error]).toEqual([
        name,
        withoutRepair(local.error),
      ] as never);
    } else expect([name, got.json.error?.message]).toEqual([name, check]);
    expect(JSON.stringify(got.json)).not.toContain(marker);
    expect([name, work(f)]).toEqual([name, before]);
    expect(receiptOf(f, `b-${i}`)).toMatchObject({
      outcome: "refused",
      result: got.json.error,
    });
    expect([name, (await run()).text]).toEqual([name, got.text]);
  }
  expect(rowsOf(f.db, "forge/cloud")).toHaveLength(cases.length);
  // The cloud's id messages are fixed text; the local handler gives the same code.
  for (const id of ["nope", "zzz-1"])
    expect(
      localLease("issue.link", twin, f, "l-0", linkIn({ id })).error,
    ).toMatchObject({ code: "INPUT_INVALID" });
}, 120_000);

test("issue.link refuses every lease the caller does not hold, a lease on a link key alone and a count that collides with an existing link, with the local code and message, writes nothing and records nothing, so a retry runs again", async () => {
  const { f, token } = await linkRows();
  const twin = Database.deserialize(f.db.serialize());
  const before = writes(f);
  const held = [409, "LEASE_NOT_HELD", 4] as const;
  const stale = [409, "LEASE_STALE", 4] as const;
  type Who = { generation?: number; session?: string };
  const refusals: [string, object, Who, readonly [number, string, number]][] = [
    ["no lease", linkIn({ id: "forge-31" }), {}, held],
    ["another device", linkIn({ id: "forge-32" }), {}, held],
    ["another session", linkIn({ id: "forge-33" }), {}, held],
    ["the caller names another session", linkIn(), { session: "s2" }, held],
    ["an older generation", linkIn(), { generation: 1 }, stale],
    ["a newer generation", linkIn(), { generation: 3 }, stale],
    ["expired", linkIn({ id: "forge-34" }), {}, [409, "LEASE_EXPIRED", 4]],
    ["released", linkIn({ id: "forge-35" }), {}, held],
    ["a lease on the link key alone", linkIn({ id: "forge-75" }), {}, held],
    [
      "a count that collides with suffix 3",
      linkIn({ id: "forge-73" }),
      {},
      [409, "REVISION_CONFLICT", 4],
    ],
  ];
  for (const [i, [name, input, who, want]] of refusals.entries()) {
    const context = {
      actor,
      session: { id: who.session ?? "s1" },
      leaseGeneration: who.generation ?? 2,
    };
    const run = () => f.send(linkCall(`f-${i}`, input, { context }), { token });
    const got = await run();
    const local = localLease("issue.link", twin, f, `f-${i}`, input, who);
    expect([name, got.status, got.code, got.exit]).toEqual([name, ...want]);
    expect(local.error).toBeDefined();
    expect([name, got.json.error]).toEqual([
      name,
      withoutRepair(local.error),
    ] as never);
    expect([name, writes(f)]).toEqual([name, before]);
    const again = await run();
    expect([name, again.text]).toEqual([name, got.text]);
    expect([name, writes(f)]).toEqual([name, before]);
  }
  // The existing links stay, and no refusal receipt blocks a retry once the caller holds the lease.
  expect(linksOf(f, 73).map((r) => r.key)).toEqual([
    linkKey(73, 1),
    linkKey(73, 3),
  ]);
  f.lease({ holder }, "issue:work-31");
  const retry = await f.send(
    linkCall("f-0", linkIn({ id: "forge-31" }), { context: leased }),
    { token },
  );
  expect([retry.status, linksOf(f, 31).length]).toEqual([200, 1]);
}, 120_000);

test("a lease lost after the input was read refuses the link with the local lease code and leaves no link, event or receipt", async () => {
  const other = { actor, session: { id: "s2", device: "laptop" } };
  const taken = (over: object) =>
    grant({ subject: "issue:work-12", generation: 3, holder: other, ...over });
  const cases: [string, (f: F) => void, (twin: Database) => void][] = [
    ["expired", (f) => f.advance(1001), () => {}],
    [
      "taken over",
      (f) => f.lease({ holder: other, generation: 3 }, "issue:work-12"),
      (twin) => {
        twin.run(
          "UPDATE state_leases SET generation=3, body=? WHERE subject='issue:work-12'",
          [JSON.stringify(taken({}))],
        );
      },
    ],
  ];
  for (const [name, lose, loseTwin] of cases) {
    const { f, token } = await linkRows();
    const twin = Database.deserialize(f.db.serialize());
    const before = writes(f);
    const real = f.storage.sql.exec.bind(f.storage.sql);
    let tripped = false;
    // The count that numbers the link is the first statement after the input was read: the authority changes there.
    f.storage.sql.exec = (sql, ...bindings) => {
      if (!tripped && bindings.includes("link:work-12:")) {
        tripped = true;
        lose(f);
      }
      return real(sql, ...bindings);
    };
    const got = await f.send(linkCall("z-1"), { token });
    loseTwin(twin);
    const local = localLease("issue.link", twin, f, "z-1", linkIn());
    expect([name, tripped, got.status, got.exit]).toEqual([name, true, 409, 4]);
    expect(local.error).toBeDefined();
    expect([name, got.json.error]).toEqual([
      name,
      withoutRepair(local.error),
    ] as never);
    expect([name, writes(f)]).toEqual([name, before]);
  }
}, 60_000);

test("a readback that is missing or different refuses the link with the local INTERNAL message, rolls the link, event and receipt back, and a retry appends once", async () => {
  for (const [name, change] of [
    [
      "different",
      "UPDATE state_records SET body=replace(body,'\"delivers\"','\"references\"') WHERE namespace=NEW.namespace AND key=NEW.key",
    ],
    [
      "missing",
      "DELETE FROM state_records WHERE namespace=NEW.namespace AND key=NEW.key",
    ],
  ] as const) {
    const { f, token } = await linkRows();
    const twin = Database.deserialize(f.db.serialize());
    const before = writes(f);
    const trigger = `CREATE TRIGGER skew AFTER INSERT ON state_records WHEN NEW.key='link:work-12:1' BEGIN ${change}; END`;
    f.db.run(trigger);
    twin.run(trigger);
    const got = await f.send(linkCall("rb-1"), { token });
    const local = localLease("issue.link", twin, f, "rb-1", linkIn());
    expect([name, got.status, got.code, got.exit]).toEqual([
      name,
      500,
      "INTERNAL",
      1,
    ]);
    expect([name, got.json.error?.message]).toEqual([name, readback]);
    expect([name, got.json.error]).toEqual([
      name,
      withoutRepair(local.error),
    ] as never);
    expect([name, writes(f)]).toEqual([name, before]);
    f.db.run("DROP TRIGGER skew");
    const retry = await f.send(linkCall("rb-1"), { token });
    expect([name, retry.status]).toEqual([name, 200]);
    expect(linksOf(f, 12).map((r) => r.key)).toEqual([linkKey(12, 1)]);
    expect(eventsOf(f.db, "forge/work")).toHaveLength(1);
    expect(rowsOf(f.db, "forge/cloud")).toHaveLength(1);
  }
}, 60_000);

test("a recorded link whose stored value is no longer valid is refused as INTERNAL on replay, with the lease still held, and nothing changes", async () => {
  // Each row edits one field of the stored record (the receipt's result): the value's relation or url, or the wrapper's revision.
  // The bad scheme passes the input schema and fails only the URL pattern; the bad revision fails only the output schema.
  for (const [name, path, to] of [
    ["relation", "$.value.result.value.relation", "Delivers"],
    ["url", "$.value.result.value.url", ""],
    ["scheme", "$.value.result.value.url", "ftp://h"],
    ["wrapper", "$.value.result.revision", 0],
  ] as const) {
    const { f, token } = await linkRows();
    const first = await f.send(linkCall("v-1"), { token });
    expect([name, first.status]).toEqual([name, 200]);
    const stored = (at: string) =>
      (
        f.db
          .query(
            "SELECT json_extract(body, ?) AS v FROM state_records WHERE namespace='forge/cloud' AND key='request:v-1'",
          )
          .get(at) as { v: unknown }
      ).v;
    const was = stored(path);
    // json_set would create a missing path, so the field must exist before and differ from the edit.
    expect([name, was != null && was !== to]).toEqual([name, true]);
    expect([
      name,
      f.db.run(
        "UPDATE state_records SET body=json_set(body, ?, ?) WHERE namespace='forge/cloud' AND key='request:v-1'",
        [path, to],
      ).changes,
      stored(path),
    ]).toEqual([name, 1, to]);
    const done = f.snapshot();
    for (const via of ["direct", createWorker()] as const) {
      const got = await f.send(linkCall("v-1"), { token, via });
      expect([name, got.status, got.code, got.exit]).toEqual([
        name,
        500,
        "INTERNAL",
        1,
      ]);
      expect([name, got.json.error?.message, got.json.result]).toEqual([
        name,
        "Stored link is not valid",
        undefined,
      ]);
      expect([name, f.snapshot()]).toEqual([name, done]);
    }
  }
}, 60_000);

test("a link record that fails the declared output schema, even when its readback is the same record, is refused before the receipt commits and leaves no link, event or receipt", async () => {
  const { f } = await linkRows();
  const db = sqlOf(f.db);
  const owner = new StateOwner(db, { now: f.now });
  const context = {
    variant: "leased",
    leaseMode: "held",
    actor,
    session: { id: "s1", device: "laptop" },
    project: { id: "p" },
    leaseGeneration: 2,
  } as const;
  const run = (requestId: string, via: StateOwner) =>
    linkIssue(db, via, {
      requestId,
      input: linkIn(),
      context,
      device: "laptop",
      prefix: "forge",
      recheck: () => {},
    });
  // The seam bends every link record the owner puts or reads to the same malformed one: the clock is a number.
  const bend = (record: unknown) => ({
    ...(record as object),
    updatedAt: 5,
  });
  const seam = new Proxy(owner, {
    get(target, name) {
      const member = Reflect.get(target, name, target) as unknown;
      if (typeof member !== "function") return member;
      const call = member as (...args: unknown[]) => unknown;
      if (name === "put")
        return (...args: unknown[]) => bend(call.apply(target, args));
      if (name === "get")
        return (namespace: string, key: string) => {
          const record = call.call(target, namespace, key);
          return record !== undefined && key.startsWith("link:")
            ? bend(record)
            : record;
        };
      return call.bind(target);
    },
  });
  const before = writes(f);
  expect(() => run("o-1", seam)).toThrow("Link result is not valid");
  expect(writes(f)).toBe(before);
  // Without the seam the same request appends the first link: nothing of the refused one was kept.
  expect(run("o-2", owner)).toMatchObject({ key: linkKey(12, 1), revision: 1 });
  expect(linksOf(f, 12)).toHaveLength(1);
  expect(eventsOf(f.db, "forge/work")).toHaveLength(1);
  expect(receiptOf(f, "o-1")).toBeUndefined();
}, 30_000);

// The replay scenarios update, claim, renew and release share: a leased write is answered from its receipt only while
// the caller still holds the lease (a committed release always, as it grants nothing), and a reused id with other input conflicts.
type Lose = (f: F, token: string) => Promise<void> | void;
interface Replay {
  name: string;
  rows: () => Promise<{ f: F; token: string }>;
  /** The default request for an id, or the same request with other input or fields. */
  send: (id: string, input?: object, more?: object) => object;
  /** What the first request returns. */
  result: object;
  /** Text only the old result carries: no refusal or failed login may contain it. */
  old: string;
  /** Changes the issue or the lease so that the recorded answer is no longer the current state, while the grant holds. */
  moveOn: (f: F, token: string) => Promise<void> | void;
  /** Other input, fence or device under the same request id: [name, on the tablet's token, input, fields]. */
  conflicts: [string, boolean, object?, object?][];
  /** Ways the caller can lose the lease. */
  losses: [string, Lose][];
  /** A recorded answer that stays valid after each loss, as a release's does. */
  kept?: true;
}
const takeover = (id: string, device: string) => (f: F) =>
  f.lease(
    { holder: { actor, session: { id, device } }, generation: 3 },
    "issue:work-12",
  );
const REPLAYS: Replay[] = [
  {
    name: "link",
    rows: linkRows,
    send: (id, input = linkIn(), more = {}) => linkCall(id, input, more),
    result: { key: linkKey(12, 1), revision: 1 },
    old: `"url":"${linkIn().url}"`,
    // A later link moves the issue's count on; the replay still answers with the original record.
    moveOn: async (f, token) => {
      const next = await f.send(
        linkCall("r-2", linkIn({ url: "https://github.com/o/r/pull/2" })),
        { token },
      );
      expect([next.status, linksOf(f, 12).length]).toEqual([200, 2]);
    },
    conflicts: [
      ["relation", false, linkIn({ relation: "references" })],
      ["url", false, linkIn({ url: "https://github.com/o/r/pull/2" })],
      ["issue", false, linkIn({ id: "forge-1" })],
      [
        "generation",
        false,
        linkIn(),
        { context: { ...leased, leaseGeneration: 3 } },
      ],
      [
        "session",
        false,
        linkIn(),
        { context: { ...leased, session: { id: "s2" } } },
      ],
      ["device", true],
    ],
    losses: [
      [
        "released",
        (f) => f.lease({ holder, releasedAt: iso(start) }, "issue:work-12"),
      ],
      ["expired", (f) => f.advance(1001)],
      ["exactly at expiry", (f) => f.advance(1000)],
      ["taken over", takeover("s2", "laptop")],
      ["taken over by another device", takeover("s1", "tablet")],
      [
        "gone",
        (f) => {
          f.db.run("DELETE FROM state_leases WHERE subject='issue:work-12'");
        },
      ],
    ],
  },
  {
    name: "update",
    rows: updateRows,
    send: (id, input = patch(), more = {}) => revise(id, input, more),
    result: { title: "Edited", revision: 4 },
    old: "Edited",
    moveOn: async (f, token) => {
      // A later update moves the issue on; the replay still answers with the original.
      const next = await f.send(
        revise("r-2", patch({ expectRevision: 4, title: "Later" })),
        { token },
      );
      expect(next.status).toBe(200);
    },
    conflicts: [
      ["title", false, patch({ title: "Twice" })],
      ["revision", false, patch({ expectRevision: 4 })],
      ["issue", false, patch({ id: "forge-1" })],
      [
        "generation",
        false,
        patch(),
        { context: { ...leased, leaseGeneration: 3 } },
      ],
      [
        "session",
        false,
        patch(),
        { context: { ...leased, session: { id: "s2" } } },
      ],
      ["device", true],
    ],
    losses: [
      [
        "released",
        (f) => f.lease({ holder, releasedAt: iso(start) }, "issue:work-12"),
      ],
      ["expired", (f) => f.advance(1001)],
      ["exactly at expiry", (f) => f.advance(1000)],
      ["taken over", takeover("s2", "laptop")],
      ["taken over by another device", takeover("s1", "tablet")],
      [
        "gone",
        (f) => {
          f.db.run("DELETE FROM state_leases WHERE subject='issue:work-12'");
        },
      ],
    ],
  },
  {
    name: "dep",
    rows: updateRows,
    send: (id, input = depIn(), more = {}) => depCall(id, input, more),
    result: { dependsOn: ["forge-1"], revision: 4 },
    old: '"dependsOn":["forge-1"]',
    // A later change moves the issue on; the replay still answers with the original.
    moveOn: async (f, token) => {
      const next = await f.send(
        depCall("r-2", depIn({ action: "remove", expectRevision: 4 })),
        { token },
      );
      expect(next.status).toBe(200);
    },
    conflicts: [
      ["target", false, depIn({ target: "forge-4" })],
      ["action", false, depIn({ action: "remove" })],
      ["revision", false, depIn({ expectRevision: 4 })],
      ["issue", false, depIn({ id: "forge-1", target: "forge-4" })],
      [
        "generation",
        false,
        depIn(),
        { context: { ...leased, leaseGeneration: 3 } },
      ],
      [
        "session",
        false,
        depIn(),
        { context: { ...leased, session: { id: "s2" } } },
      ],
      ["device", true],
    ],
    losses: [
      [
        "released",
        (f) => f.lease({ holder, releasedAt: iso(start) }, "issue:work-12"),
      ],
      ["expired", (f) => f.advance(1001)],
      ["exactly at expiry", (f) => f.advance(1000)],
      ["taken over", takeover("s2", "laptop")],
      ["taken over by another device", takeover("s1", "tablet")],
      [
        "gone",
        (f) => {
          f.db.run("DELETE FROM state_leases WHERE subject='issue:work-12'");
        },
      ],
    ],
  },
  {
    name: "close",
    rows: updateRows,
    send: (id, input = closeIn(), more = {}) => closeCall(id, input, more),
    result: { status: "closed", withoutReceipt: "done", revision: 4 },
    old: '"withoutReceipt":"done"',
    // A later close moves the issue on; the replay still answers with the original.
    moveOn: async (f, token) => {
      const next = await f.send(
        closeCall("r-2", closeIn({ withoutReceipt: "later" })),
        { token },
      );
      expect(next.status).toBe(200);
    },
    conflicts: [
      ["exemption", false, closeIn({ withoutReceipt: "other" })],
      ["reason", false, closeIn({ reason: "why" })],
      ["issue", false, closeIn({ id: "forge-1" })],
      [
        "generation",
        false,
        closeIn(),
        { context: { ...leased, leaseGeneration: 3 } },
      ],
      [
        "session",
        false,
        closeIn(),
        { context: { ...leased, session: { id: "s2" } } },
      ],
      ["device", true],
    ],
    losses: [
      [
        "released",
        (f) => f.lease({ holder, releasedAt: iso(start) }, "issue:work-12"),
      ],
      ["expired", (f) => f.advance(1001)],
      ["exactly at expiry", (f) => f.advance(1000)],
      ["taken over", takeover("s2", "laptop")],
      ["taken over by another device", takeover("s1", "tablet")],
      [
        "gone",
        (f) => {
          f.db.run("DELETE FROM state_leases WHERE subject='issue:work-12'");
        },
      ],
    ],
  },
  {
    name: "claim",
    rows: claimRows,
    send: (id, input = { id: "forge-12" }, more = {}) => claim(id, input, more),
    result: {
      id: "forge-12",
      generation: 1,
      expiresAt: iso(start + 3_600_000),
    },
    old: '"result"',
    // A renewal moves the expiry on at the same generation: the replay still answers with the original.
    moveOn: (f) =>
      f.lease(
        { holder, generation: 1, expiresAt: iso(start + 7_200_000) },
        "issue:work-12",
      ),
    conflicts: [
      ["ttl", false, { id: "forge-12", ttlSeconds: 60 }],
      ["issue", false, { id: "forge-1" }],
      ["session", false, { id: "forge-12" }, asSession("s2")],
      ["device", true],
    ],
    losses: [
      [
        "released",
        async (f, token) => {
          await release(f, token, 12, 1);
        },
      ],
      ["expired", (f) => f.advance(3_600_000)],
      [
        "taken over after expiry",
        (f) => {
          f.advance(3_600_001);
          f.lease(
            {
              holder: { actor, session: { id: "s2", device: "laptop" } },
              generation: 2,
              expiresAt: iso(f.now() + 1000),
            },
            "issue:work-12",
          );
        },
      ],
      [
        "released, then claimed on another device",
        async (f, token) => {
          await release(f, token, 12, 1);
          const tablet = await f.device(day, "tablet");
          const took = await f.send(
            claim("r-2", { id: "forge-12" }, asSession("b1")),
            { token: tablet },
          );
          expect([took.status, took.json.result]).toMatchObject([
            200,
            { generation: 2 },
          ]);
        },
      ],
      [
        "gone",
        (f) => {
          f.db.run("DELETE FROM state_leases WHERE subject='issue:work-12'");
        },
      ],
    ],
  },
  {
    name: "renew",
    rows: updateRows,
    send: (id, input = { id: "forge-12" }, more = {}) =>
      renewal(id, input, more),
    result: {
      id: "forge-12",
      generation: 2,
      expiresAt: iso(start + 3_600_000),
    },
    old: '"result"',
    // An update leaves the lease as renewed, so the grant is still the live one.
    moveOn: async (f, token) => {
      const next = await f.send(revise("r-2", patch({ title: "Later" })), {
        token,
      });
      expect(next.status).toBe(200);
    },
    conflicts: [
      ["ttl", false, { id: "forge-12", ttlSeconds: 60 }],
      ["issue", false, { id: "forge-1" }],
      [
        "generation",
        false,
        { id: "forge-12" },
        { context: { ...leased, leaseGeneration: 3 } },
      ],
      [
        "session",
        false,
        { id: "forge-12" },
        { context: { ...leased, session: { id: "s2" } } },
      ],
      ["device", true],
    ],
    losses: [
      [
        "released",
        (f) => f.lease({ holder, releasedAt: iso(start) }, "issue:work-12"),
      ],
      ["expired", (f) => f.advance(3_600_000)],
      [
        "renewed again",
        (f) =>
          f.lease(
            { holder, generation: 2, expiresAt: iso(start + 7_200_000) },
            "issue:work-12",
          ),
      ],
      ["taken over", takeover("s2", "laptop")],
      ["taken over by another device", takeover("s1", "tablet")],
      [
        "gone",
        (f) => {
          f.db.run("DELETE FROM state_leases WHERE subject='issue:work-12'");
        },
      ],
    ],
  },
  {
    name: "release",
    rows: updateRows,
    send: (id, input = { id: "forge-12" }, more = {}) =>
      giveUp(id, input, more),
    result: { id: "forge-12" },
    old: '"result"',
    moveOn: takeover("s2", "laptop"),
    conflicts: [
      ["issue", false, { id: "forge-1" }],
      [
        "generation",
        false,
        { id: "forge-12" },
        { context: { ...leased, leaseGeneration: 3 } },
      ],
      [
        "session",
        false,
        { id: "forge-12" },
        { context: { ...leased, session: { id: "s2" } } },
      ],
      ["device", true],
    ],
    kept: true,
    losses: [
      ["taken over", takeover("s2", "laptop")],
      ["taken over by another device", takeover("s1", "tablet")],
      ["expired", (f) => f.advance(1001)],
      [
        "gone",
        (f) => {
          f.db.run("DELETE FROM state_leases WHERE subject='issue:work-12'");
        },
      ],
    ],
  },
];

for (const r of REPLAYS) {
  test(`a ${r.name} retry with the lease still held returns the original result with no second write or event, and a reused id with other input, fence or device conflicts`, async () => {
    const { f, token } = await r.rows();
    const other = await f.device();
    const tablet = await f.device(day, "tablet");
    const first = await f.send(r.send("r-1"), { token });
    expect([first.status, first.exit, first.json.result]).toMatchObject([
      200,
      0,
      r.result,
    ]);
    // One write and its one event; the receipt adds its own record and its own event.
    expect(eventsOf(f.db, "forge/work")).toHaveLength(1);
    expect(rowsOf(f.db, "forge/cloud").map((row) => row.key)).toEqual([
      "request:r-1",
    ]);
    expect(eventsOf(f.db, "forge/cloud")).toHaveLength(1);
    const receipt = receiptOf(f, "r-1")!;
    expect(Object.keys(receipt).sort()).toEqual([
      "fingerprint",
      "outcome",
      "result",
    ]);
    expect([receipt.outcome, receipt.result]).toEqual([
      "ok",
      first.json.result,
    ]);
    const done = f.snapshot();
    for (const [via, bearer] of [
      ["direct", token],
      [createWorker(), other],
    ] as const) {
      const again = await f.send(r.send("r-1"), { token: bearer, via });
      expect([again.status, again.text]).toEqual([200, first.text]);
      expect(f.snapshot()).toBe(done);
    }
    await r.moveOn(f, token);
    const later = f.snapshot();
    const again = await f.send(r.send("r-1"), { token });
    expect([again.status, again.text]).toEqual([200, first.text]);
    expect(f.snapshot()).toBe(later);
    const sent = JSON.stringify(receiptOf(f, "r-1"));
    for (const [name, onTablet, input, more] of r.conflicts) {
      const got = await f.send(r.send("r-1", input, more), {
        token: onTablet ? tablet : token,
      });
      expect([name, got.status, got.code, got.exit]).toEqual([
        name,
        409,
        "INPUT_CONFLICT",
        4,
      ]);
      expect([name, f.snapshot(), JSON.stringify(receiptOf(f, "r-1"))]).toEqual(
        [name, later, sent],
      );
    }
    // A replay is authenticated first: a revoked token never reads the receipt.
    revoke(f, other);
    const revoked = f.snapshot();
    const denied = await f.send(r.send("r-1"), { token: other });
    expect([denied.status, denied.code]).toEqual([401, "AUTH_REVOKED"]);
    expect(denied.text).not.toContain(r.old);
    const dry = await f.send(r.send("r-3", undefined, { dryRun: true }), {
      token,
    });
    expect([dry.status, dry.code, dry.exit]).toEqual([503, "UNAVAILABLE", 1]);
    expect(f.snapshot()).toBe(revoked);
  }, 60_000);

  test(`a ${r.name} replay after the lease was released, expired or taken over is ${r.kept ? "answered as recorded, with no second release" : "LEASE_STALE and never the old result"}`, async () => {
    for (const [name, lose] of r.losses) {
      const { f, token } = await r.rows();
      const first = await f.send(r.send("r-1"), { token });
      expect([name, first.status]).toEqual([name, 200]);
      await lose(f, token);
      const done = f.snapshot();
      for (const via of ["direct", createWorker()] as const) {
        const got = await f.send(r.send("r-1"), { token, via });
        if (r.kept) {
          expect([name, got.status, got.text]).toEqual([name, 200, first.text]);
          expect([name, f.snapshot()]).toEqual([name, done]);
          continue;
        }
        expect([name, got.status, got.code, got.exit]).toEqual([
          name,
          409,
          "LEASE_STALE",
          4,
        ]);
        expect([name, got.json.ok, got.json.result]).toEqual([
          name,
          false,
          undefined,
        ]);
        expect(got.text).not.toContain(r.old);
        expect([name, f.snapshot()]).toEqual([name, done]);
      }
      // Other input under the id is a conflict whatever the lease is, and never replaces the receipt.
      const [, , input, more] = r.conflicts[0]!;
      const changed = await f.send(r.send("r-1", input, more), { token });
      expect([name, changed.code]).toEqual([name, "INPUT_CONFLICT"]);
      expect([name, f.snapshot()]).toEqual([name, done]);
    }
  }, 120_000);
}

// The receipt scenarios every write shares, run for create, comment, claim and update, each with its own rows.
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
  /** The lease a successful write leaves in the dump, when it takes one. */
  lease?: string;
  /** What the first successful write returns, after a failed receipt write was rolled back. */
  result: (f: F, got: Sent) => void;
}
const WRITES: Write[] = [
  {
    name: "link",
    rows: linkRows,
    send: (id, input) => linkCall(id, input),
    // The schema refuses a key link does not take: the refusal is recorded.
    bad: linkIn({ expectRevision: 0 }),
    badWant: [400, "INPUT_INVALID"],
    empty: linkIn({ url: "" }),
    record: `forge/work/${linkKey(12, 1)}`,
    result: (f, got) => {
      expect([got.status, got.json.result]).toMatchObject([
        200,
        { key: linkKey(12, 1), revision: 1 },
      ]);
      expect(eventsOf(f.db, "forge/work")).toHaveLength(1);
    },
  },
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
    name: "claim",
    rows: claimRows,
    send: claim,
    // Reopen and reason are refused by name, so the refusal is recorded; the schema refuses a zero ttl.
    bad: { id: "forge-12", reason: "x" },
    badWant: [400, "INPUT_INVALID"],
    empty: { id: "forge-12", ttlSeconds: 0 },
    record: "forge/cloud/request:s-1",
    lease: "forge/work/issue:work-12",
    result: (f, got) => {
      expect([got.status, got.json.result]).toEqual([
        200,
        { id: "forge-12", generation: 1, expiresAt: iso(start + 3_600_000) },
      ]);
      expect(eventsOf(f.db, "forge/work")).toHaveLength(1);
    },
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
  {
    name: "dep",
    rows: updateRows,
    send: (id, input) => depCall(id, input),
    // The schema refuses an action it does not know: the refusal is recorded.
    bad: depIn({ action: "toggle" }),
    badWant: [400, "INPUT_INVALID"],
    empty: depIn({ target: "" }),
    next: depIn({ action: "remove", expectRevision: 4 }),
    record: "forge/work/issue:work-12",
    result: (f, got) => {
      expect([got.status, got.json.result]).toMatchObject([
        200,
        { dependsOn: ["forge-1"], revision: 4 },
      ]);
      expect(eventsOf(f.db, "forge/work")).toHaveLength(1);
    },
  },
  {
    name: "close",
    rows: updateRows,
    send: (id, input) => closeCall(id, input),
    // A receipt is refused by name: the refusal is recorded.
    bad: closeIn({ receipt: "forge-5" }),
    badWant: [400, "INPUT_INVALID"],
    empty: closeIn({ withoutReceipt: "" }),
    record: "forge/work/issue:work-12",
    result: (f, got) => {
      expect([got.status, got.json.result]).toMatchObject([
        200,
        { status: "closed", withoutReceipt: "done", revision: 4 },
      ]);
      expect(eventsOf(f.db, "forge/work")).toHaveLength(1);
    },
  },
  {
    name: "renew",
    rows: updateRows,
    send: renewal,
    // The schema refuses a key renew does not take: the refusal is recorded.
    bad: { id: "forge-12", reason: "x" },
    badWant: [400, "INPUT_INVALID"],
    empty: { id: "forge-12", ttlSeconds: 0 },
    record: "forge/cloud/request:s-1",
    lease: "forge/work/issue:work-12",
    result: (f, got) => {
      expect([got.status, got.json.result]).toEqual([
        200,
        { id: "forge-12", generation: 2, expiresAt: iso(start + 3_600_000) },
      ]);
      expect(eventsOf(f.db, "forge/work")).toHaveLength(1);
    },
  },
  {
    name: "release",
    rows: updateRows,
    send: giveUp,
    bad: { id: "forge-12", reason: "x" },
    badWant: [400, "INPUT_INVALID"],
    empty: { id: "" },
    record: "forge/cloud/request:s-1",
    lease: "forge/work/issue:work-12",
    result: (f, got) => {
      expect([got.status, got.json.result]).toEqual([200, { id: "forge-12" }]);
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
      value: {
        tables: Record<
          string,
          { namespace?: string; key?: string; subject?: string }[]
        >;
      };
    };
    expect(Object.keys(value.tables).sort()).toEqual([
      "domain_cloud_requests",
      "state_events",
      "state_leases",
      "state_records",
      "state_requests",
    ]);
    const at = (table: string) =>
      (value.tables[table] ?? []).map(
        (r) => `${r.namespace}/${r.key ?? r.subject ?? ""}`,
      );
    for (const record of [
      w.record,
      "forge/cloud/request:s-1",
      "forge/cloud/request:s-2",
    ])
      expect(at("state_records")).toContain(record);
    if (w.lease !== undefined) expect(at("state_leases")).toContain(w.lease);
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
    ["dep", depCall("m-9")],
    ["close", closeCall("m-10")],
    ["link", linkCall("m-11")],
    ["claim", claim("m-6", { id: "forge-12" })],
    ["renew", renewal("m-7")],
    ["release", giveUp("m-8")],
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

test("the cloud issue.claim agrees with the local handler on whole results, rows, leases and events", async () => {
  const { f, token } = await claimRows();
  const twin = Database.deserialize(f.db.serialize());
  const ready = () => readyIds(f, token);
  const claimed = [12, 1, 25, 26, 27];
  const others = () =>
    JSON.stringify(
      f.db
        .query(
          `SELECT * FROM state_leases WHERE subject NOT IN (${claimed.map((n) => `'issue:work-${n}'`).join()}) ORDER BY subject`,
        )
        .all(),
    );
  const records = JSON.stringify(rowsOf(f.db, "forge/work"));
  const before = [others(), await ready()];
  const cases: [string, object, number][] = [
    ["c-0", { id: "forge-12" }, 1],
    ["c-1", { id: "acme-1", ttlSeconds: 60 }, 1],
    ["c-2", { id: "work-25" }, 1],
    ["c-3", { id: "FORGE-26", ttlSeconds: 86_400 }, 1],
    ["c-4", { id: "forge-27" }, 3],
  ];
  const results: unknown[] = [];
  for (const [i, [requestId, input, generation]] of cases.entries()) {
    const got = await f.send(claim(requestId, input), {
      token,
      via: i % 2 ? "direct" : createWorker(),
    });
    const want = localClaim(twin, f, requestId, input);
    expect([requestId, got.status, got.exit]).toEqual([requestId, 200, 0]);
    expect(got.json).toEqual({
      ok: true,
      op: "issue.claim",
      status: "OK",
      result: want.result,
      warnings: [],
    } as never);
    expect(want.result).toMatchObject({ generation });
    results.push(got.json.result);
  }
  // The first claim: generation 1 and the server's now plus the default 3,600 seconds.
  expect(results[0]).toEqual({
    id: "forge-12",
    generation: 1,
    expiresAt: iso(start + 3_600_000),
  });
  expect(eventsOf(f.db, "forge/work")).toEqual(eventsOf(twin, "forge/work"));
  expect(eventsOf(f.db, "forge/work")).toHaveLength(cases.length);
  expect(leasesIn(f.db)).toBe(leasesIn(twin));
  expect(requestsIn(f.db)).toBe(requestsIn(twin));
  expect(rowsOf(f.db, "forge/work")).toEqual(rowsOf(twin, "forge/work"));
  // Each claim leaves its issue record, and every other lease, as it was; each is removed from ready.
  expect(JSON.stringify(rowsOf(f.db, "forge/work"))).toBe(records);
  expect(rowsOf(f.db, "forge/cloud")).toHaveLength(cases.length);
  const after = [others(), await ready()];
  expect(after[0]).toBe(before[0]);
  expect(after[1]).toEqual(
    (before[1] as string[]).filter((id) => !claimed.map(String).includes(id)),
  );
  expect((before[1] as string[]).length - (after[1] as string[]).length).toBe(
    claimed.length,
  );
}, 60_000);

test("every refusal agrees with the local handler, writes nothing, and is not recorded, so a retry runs again", async () => {
  const { f, token } = await claimRows();
  const tablet = await f.device(day, "tablet");
  const twin = Database.deserialize(f.db.serialize());
  const before = writes(f);
  const s1 = { session: "s1", device: "laptop" };
  const s2 = { session: "s2", device: "laptop" };
  const b1 = { session: "b1", device: "tablet" };
  // [name, issue as the caller wrote it, who, [status, code, exit]]
  const cases: [
    string,
    string,
    { session: string; device: string },
    readonly [number, string, number],
  ][] = [
    ["same device", "forge-4", s2, [409, "LEASE_HELD", 4]],
    ["another device", "forge-4", b1, [409, "LEASE_HELD", 4]],
    ["same holder again", "forge-4", s1, [409, "LEASE_HELD", 4]],
    ["held and blocked", "forge-28", s1, [409, "LEASE_HELD", 4]],
    ["blocked", "forge-20", s1, [409, "CLAIM_BLOCKED", 1]],
    ["closed", "forge-23", s1, [409, "INPUT_CONFLICT", 4]],
    ["cleanup reserved", "forge-24", s1, [409, "INPUT_CONFLICT", 4]],
    ["cleanup on an absent issue", "forge-98", s1, [409, "INPUT_CONFLICT", 4]],
    ["absent", "forge-99", s1, [404, "NOT_FOUND", 3]],
    ["absent, as written", "FORGE-99", s1, [404, "NOT_FOUND", 3]],
  ];
  for (const [i, [name, id, who, want]] of cases.entries()) {
    const send = () =>
      f.send(claim(`f-${i}`, { id }, asSession(who.session)), {
        token: who.device === "tablet" ? tablet : token,
      });
    const got = await send();
    const local = localClaim(twin, f, `f-${i}`, { id }, who);
    expect([name, got.status, got.code, got.exit]).toEqual([name, ...want]);
    expect(local.error).toBeDefined();
    expect([name, got.json.error]).toEqual([
      name,
      withoutRepair(local.error),
    ] as never);
    expect([name, writes(f)]).toEqual([name, before]);
    const again = await send();
    expect([name, again.text]).toEqual([name, got.text]);
    expect([name, writes(f)]).toEqual([name, before]);
  }
  // A held issue names the full current holder and expiry; a blocked one names each blocker, with its holder.
  const held = await f.send(claim("h-1", { id: "forge-4" }, asSession("s2")), {
    token,
  });
  expect(held.json.error).toMatchObject({
    lease: { holder, generation: 2, expiresAt: iso(start + 1) },
  });
  const blocked = await f.send(claim("h-2", { id: "forge-20" }), { token });
  expect(blocked.json.error).toMatchObject({
    observed: {
      blockers: [
        { id: "forge-21", holder, holderUnverified: true },
        { id: "forge-99" },
      ],
    },
  });
  expect(blocked.json.error?.message).toContain("forge-21 (open)");
  expect(blocked.json.error?.message).toContain("forge-99 (missing)");
  // Competing and collaborative issues are refused as they are for a read.
  for (const n of [29, 30]) {
    const got = await f.send(claim(`m-${n}`, { id: `forge-${n}` }), { token });
    expect([n, got.status, got.code, got.exit]).toEqual([
      n,
      400,
      "INPUT_INVALID",
      6,
    ]);
    expect(got.json.error?.message).toContain("Competing and collaborative");
  }
  expect(writes(f)).toBe(before);
}, 60_000);

test("bad input and reopen or reason are refused as INPUT_INVALID with one refusal receipt per fresh request id, replayed unchanged, and nothing is claimed", async () => {
  const { f, token } = await claimRows();
  const kept = () => JSON.stringify([work(f), leasesIn(f.db)]);
  const before = kept();
  const id = "forge-12";
  const cases: [string, object, boolean][] = [
    ["no id", {}, false],
    ["unknown key", { id, extra: marker }, false],
    ["caller key", { id, key: "issue:work-12" }, false],
    ["ttl zero", { id, ttlSeconds: 0 }, false],
    ["ttl fraction", { id, ttlSeconds: 1.5 }, false],
    ["ttl as text", { id, ttlSeconds: "5" }, false],
    ["ttl over the schema's week", { id, ttlSeconds: 604_801 }, false],
    ["malformed id", { id: "nope" }, false],
    ["unknown prefix", { id: "zzz-1" }, false],
    ["id not text", { id: 12 }, false],
    ["reopen", { id, reopen: "x" }, true],
    ["reason", { id, reason: "x" }, true],
    ["reopen and reason", { id, reopen: "x", reason: "y" }, true],
    ["empty reason", { id, reason: "" }, true],
    ["null reopen", { id, reopen: null }, true],
  ];
  const texts: string[] = [];
  for (const [i, [name, input, named]] of cases.entries()) {
    const got = await f.send(claim(`b-${i}`, input), { token });
    expect([name, got.status, got.code, got.exit]).toEqual([
      name,
      400,
      "INPUT_INVALID",
      6,
    ]);
    // A refusal by name says so; none repeats what the caller sent.
    expect(got.json.error?.message.includes(unsupported)).toBe(named);
    expect(JSON.stringify(got.json)).not.toContain(marker);
    expect([name, kept()]).toEqual([name, before]);
    expect(receiptOf(f, `b-${i}`)).toMatchObject({
      outcome: "refused",
      result: got.json.error,
    });
    expect(eventsOf(f.db, "forge/cloud")).toHaveLength(i + 1);
    texts.push(got.text);
  }
  const done = f.snapshot();
  const again = await f.send(claim("b-0", cases[0]![1]), { token });
  expect([again.status, again.text]).toEqual([400, texts[0]!]);
  const changed = await f.send(claim("b-0"), { token });
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
      (await f.send(claim("b-99", { id, reopen: "x" }, more), { token }))
        .status,
    ).toBe(status);
  expect(f.snapshot()).toBe(done);
  // Nothing was held back: the same issue is claimed by the next valid request.
  const next = await f.send(claim("b-ok"), { token });
  expect([next.status, next.json.result]).toMatchObject([
    200,
    { id: "forge-12", generation: 1 },
  ]);
}, 60_000);

test("a ttl over 24 hours or past the token's expiry is INPUT_INVALID and never clamped, and the cap and the expiry themselves are accepted", async () => {
  const { f, token } = await claimRows();
  // Expires 3,599 seconds from now: the default 3,600 seconds does not fit.
  const short = await f.device(3_599_000, "tablet");
  const before = writes(f);
  // A message is a refusal that writes nothing; an expiry is a grant: 24 hours is the cap and this
  // token's whole life, and 3,599 seconds is the short token's.
  const cases: [string, string, object, string | number][] = [
    ["over the cap", token, { id: "forge-12", ttlSeconds: 86_401 }, "24 hours"],
    ["the default past expiry", short, { id: "forge-12" }, "token expiry"],
    [
      "one second past expiry",
      short,
      { id: "forge-12", ttlSeconds: 3600 },
      "token expiry",
    ],
    ["the cap", token, { id: "forge-12", ttlSeconds: 86_400 }, start + day],
    [
      "the token's expiry",
      short,
      { id: "forge-1", ttlSeconds: 3599 },
      start + 3_599_000,
    ],
  ];
  for (const [i, [name, bearer, input, want]] of cases.entries()) {
    const got = await f.send(claim(`t-${i}`, input), { token: bearer });
    if (typeof want === "number") {
      expect([name, got.status, got.json.result]).toMatchObject([
        name,
        200,
        { expiresAt: iso(want) },
      ]);
      continue;
    }
    expect([name, got.status, got.code, got.exit]).toEqual([
      name,
      400,
      "INPUT_INVALID",
      6,
    ]);
    expect(got.json.error?.message).toContain(want);
    expect([name, writes(f)]).toEqual([name, before]);
  }
}, 60_000);

test("after a release by the raw route another session claims with a fresh id and gets the next generation, and an earlier refusal does not block the same id", async () => {
  const { f, token } = await claimRows();
  const tablet = await f.device(day, "tablet");
  const issue = JSON.stringify(issueRow(f));
  const ready = () => readyIds(f, token);
  const first = await f.send(claim("k-1"), { token });
  expect([first.status, first.json.result]).toMatchObject([
    200,
    { generation: 1 },
  ]);
  expect(await ready()).not.toContain("12");
  const again = () =>
    f.send(claim("k-2", { id: "forge-12" }, asSession("b1")), {
      token: tablet,
    });
  const refused = await again();
  expect([refused.status, refused.code]).toEqual([409, "LEASE_HELD"]);
  const released = await release(f, token, 12, 1);
  expect(released.status).toBe(200);
  expect(await ready()).toContain("12");
  const second = await again();
  expect([second.status, second.exit, second.json.result]).toEqual([
    200,
    0,
    { id: "forge-12", generation: 2, expiresAt: iso(start + 3_600_000) },
  ]);
  expect(await ready()).not.toContain("12");
  expect(JSON.stringify(issueRow(f))).toBe(issue);
  // Acquired, released, acquired: the engine's own three events.
  expect(eventsOf(f.db, "forge/work")).toHaveLength(3);
}, 60_000);

const LEASE_OPS = [
  ["issue.renew", renewal],
  ["issue.release", giveUp],
] as const;
// updateRows, plus issues 31 to 35 for the ways a held lease is lost: none, held on the tablet, held by session s2,
// expired, and released. Issue 12 is held by laptop session s1 at generation 2, so the caller can name another one.
async function fenceRows() {
  const rows = await updateRows();
  const { f } = rows;
  for (const n of [31, 32, 33, 34, 35])
    f.put(stored({ id: `work-${n}` }), {}, `issue:work-${n}`);
  const named = (id: string, device: string) => ({
    actor,
    session: { id, device },
  });
  f.lease({ holder: named("s1", "tablet") }, "issue:work-32");
  f.lease({ holder: named("s2", "laptop") }, "issue:work-33");
  f.lease({ holder, expiresAt: iso(start - 1) }, "issue:work-34");
  f.lease({ holder, releasedAt: iso(start - 5) }, "issue:work-35");
  return rows;
}

for (const [op, send] of LEASE_OPS) {
  const renews = op === "issue.renew";
  const cases: [string, object][] = renews
    ? [
        ["c-0", { id: "forge-12" }],
        ["c-1", { id: "acme-1", ttlSeconds: 60 }],
        ["c-2", { id: "FORGE-20", ttlSeconds: 86_400 }],
        ["c-3", { id: "work-12", ttlSeconds: 7200 }],
      ]
    : [
        ["c-0", { id: "forge-12" }],
        ["c-1", { id: "acme-1" }],
        ["c-2", { id: "FORGE-20" }],
      ];
  test(`the cloud ${op} agrees with the local handler on whole results, rows, leases and events, for the current, historical and upper case ids`, async () => {
    const { f, token } = await updateRows();
    const twin = Database.deserialize(f.db.serialize());
    const touched = ["issue:work-1", "issue:work-12", "issue:work-20"];
    const others = () =>
      JSON.stringify(
        f.db
          .query(
            `SELECT * FROM state_leases WHERE subject NOT IN (${touched.map((s) => `'${s}'`).join()}) ORDER BY subject`,
          )
          .all(),
      );
    const records = JSON.stringify(rowsOf(f.db, "forge/work"));
    const before = [others(), await readyIds(f, token)];
    const results: unknown[] = [];
    for (const [i, [requestId, input]] of cases.entries()) {
      const got = await f.send(send(requestId, input), {
        token,
        via: i % 2 ? "direct" : createWorker(),
      });
      const want = localLease(op, twin, f, requestId, input);
      expect([requestId, got.status, got.exit]).toEqual([requestId, 200, 0]);
      expect(got.json).toEqual({
        ok: true,
        op,
        status: "OK",
        result: want.result,
        warnings: [],
      } as never);
      results.push(got.json.result);
    }
    // The first request: the same generation, and for a renew the server's now plus the default 3,600 seconds.
    expect(results[0]).toEqual(
      renews
        ? { id: "forge-12", generation: 2, expiresAt: iso(start + 3_600_000) }
        : { id: "forge-12" },
    );
    if (renews)
      expect(results.slice(1, 3)).toEqual([
        { id: "forge-1", generation: 2, expiresAt: iso(start + 60_000) },
        { id: "forge-20", generation: 2, expiresAt: iso(start + day) },
      ]);
    expect(eventsOf(f.db, "forge/work")).toEqual(eventsOf(twin, "forge/work"));
    expect(eventsOf(f.db, "forge/work")).toHaveLength(cases.length);
    expect(leasesIn(f.db)).toBe(leasesIn(twin));
    expect(rowsOf(f.db, "forge/work")).toEqual(rowsOf(twin, "forge/work"));
    // Issue rows and every other lease stay as they were; a renewed issue stays held, a released one is eligible again.
    expect(JSON.stringify(rowsOf(f.db, "forge/work"))).toBe(records);
    expect(rowsOf(f.db, "forge/cloud")).toHaveLength(cases.length);
    expect(others()).toBe(before[0] as string);
    const after = await readyIds(f, token);
    if (renews) expect(after).toEqual(before[1] as string[]);
    else {
      expect((before[1] as string[]).includes("12")).toBe(false);
      expect(["1", "12"].filter((n) => !after.includes(n))).toEqual([]);
    }
  }, 60_000);

  test(`${op} refuses every lease the caller does not hold with the local code and message, writes nothing, and is not recorded, so a retry runs again`, async () => {
    const { f, token } = await fenceRows();
    const twin = Database.deserialize(f.db.serialize());
    const before = writes(f);
    const held = [409, "LEASE_NOT_HELD", 4] as const;
    const stale = [409, "LEASE_STALE", 4] as const;
    // [name, issue as the caller wrote it, the generation and session it names, [status, code, exit]]
    const refusals: [
      string,
      string,
      { generation?: number; session?: string },
      readonly [number, string, number],
    ][] = [
      ["no lease", "forge-31", {}, held],
      ["another device", "forge-32", {}, held],
      ["another session", "forge-33", {}, held],
      ["the caller names another session", "forge-12", { session: "s2" }, held],
      ["an older generation", "forge-12", { generation: 1 }, stale],
      ["a newer generation", "forge-12", { generation: 3 }, stale],
      ["expired", "forge-34", {}, [409, "LEASE_EXPIRED", 4]],
      ["released", "forge-35", {}, held],
      ["absent", "forge-99", {}, [404, "NOT_FOUND", 3]],
      ["absent, as written", "FORGE-99", {}, [404, "NOT_FOUND", 3]],
    ];
    for (const [i, [name, id, who, want]] of refusals.entries()) {
      const context = {
        actor,
        session: { id: who.session ?? "s1" },
        leaseGeneration: who.generation ?? 2,
      };
      const run = () => f.send(send(`f-${i}`, { id }, { context }), { token });
      const got = await run();
      const local = localLease(op, twin, f, `f-${i}`, { id }, who);
      expect([name, got.status, got.code, got.exit]).toEqual([name, ...want]);
      expect(local.error).toBeDefined();
      expect([name, got.json.error]).toEqual([
        name,
        withoutRepair(local.error),
      ] as never);
      expect([name, writes(f)]).toEqual([name, before]);
      const again = await run();
      expect([name, again.text]).toEqual([name, got.text]);
      expect([name, writes(f)]).toEqual([name, before]);
    }
    // No refusal receipt blocks a retry: the same request id works once the caller holds the lease.
    f.lease({ holder }, "issue:work-31");
    const retry = await f.send(
      send("f-0", { id: "forge-31" }, { context: leased }),
      { token },
    );
    expect(retry.status).toBe(200);
  }, 60_000);

  test(`${op} refuses bad input as INPUT_INVALID with one refusal receipt per fresh request id, replayed unchanged, and leaves the lease held`, async () => {
    const { f, token } = await updateRows();
    const kept = () => JSON.stringify([work(f), leasesIn(f.db)]);
    const before = kept();
    const id = "forge-12";
    const ttls: [string, object][] = renews
      ? [
          ["ttl zero", { id, ttlSeconds: 0 }],
          ["ttl fraction", { id, ttlSeconds: 1.5 }],
          ["ttl as text", { id, ttlSeconds: "5" }],
          ["ttl over the schema's week", { id, ttlSeconds: 604_801 }],
        ]
      : [["a ttl", { id, ttlSeconds: 60 }]];
    const cases: [string, object][] = [
      ["no id", {}],
      ["unknown key", { id, extra: marker }],
      ["caller key", { id, key: "issue:work-12" }],
      ["caller subject", { id, subject: "issue:work-12" }],
      ["caller holder", { id, holder }],
      ["reason", { id, reason: "x" }],
      ["malformed id", { id: "nope" }],
      ["unknown prefix", { id: "zzz-1" }],
      ["id not text", { id: 12 }],
      ...ttls,
    ];
    const texts: string[] = [];
    for (const [i, [name, input]] of cases.entries()) {
      const got = await f.send(send(`b-${i}`, input), { token });
      expect([name, got.status, got.code, got.exit]).toEqual([
        name,
        400,
        "INPUT_INVALID",
        6,
      ]);
      expect(JSON.stringify(got.json)).not.toContain(marker);
      expect([name, kept()]).toEqual([name, before]);
      expect(receiptOf(f, `b-${i}`)).toMatchObject({
        outcome: "refused",
        result: got.json.error,
      });
      expect(eventsOf(f.db, "forge/cloud")).toHaveLength(i + 1);
      texts.push(got.text);
    }
    const done = f.snapshot();
    const again = await f.send(send("b-0", cases[0]![1]), { token });
    expect([again.status, again.text]).toEqual([400, texts[0]!]);
    const changed = await f.send(send("b-0"), { token });
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
        (await f.send(send("b-99", { id, reason: "x" }, more), { token }))
          .status,
      ).toBe(status);
    expect(f.snapshot()).toBe(done);
    // Nothing was spent: the next valid request still holds the lease.
    expect((await f.send(send("b-ok"), { token })).status).toBe(200);
  }, 60_000);
}

test("a renew ttl over 24 hours or past the token's expiry is INPUT_INVALID and never clamped, and the cap and the expiry themselves are accepted", async () => {
  const { f, token } = await updateRows();
  // Expires 3,599 seconds from now: the default 3,600 seconds does not fit.
  const short = await f.device(3_599_000);
  const before = writes(f);
  const cases: [string, string, object, string | number][] = [
    ["over the cap", token, { id: "forge-12", ttlSeconds: 86_401 }, "24 hours"],
    ["the default past expiry", short, { id: "forge-12" }, "token expiry"],
    [
      "one second past expiry",
      short,
      { id: "forge-12", ttlSeconds: 3600 },
      "token expiry",
    ],
    ["the cap", token, { id: "forge-12", ttlSeconds: 86_400 }, start + day],
    [
      "the token's expiry",
      short,
      { id: "forge-1", ttlSeconds: 3599 },
      start + 3_599_000,
    ],
  ];
  for (const [i, [name, bearer, input, want]] of cases.entries()) {
    const got = await f.send(renewal(`t-${i}`, input), { token: bearer });
    if (typeof want === "number") {
      expect([name, got.status, got.json.result]).toMatchObject([
        name,
        200,
        { expiresAt: iso(want) },
      ]);
      continue;
    }
    expect([name, got.status, got.code, got.exit]).toEqual([
      name,
      400,
      "INPUT_INVALID",
      6,
    ]);
    expect(got.json.error?.message).toContain(want);
    expect([name, writes(f)]).toEqual([name, before]);
  }
}, 60_000);

test("after a release a renew is refused and another session claims the issue at the next generation", async () => {
  const { f, token } = await updateRows();
  const tablet = await f.device(day, "tablet");
  expect((await f.send(giveUp("k-1"), { token })).status).toBe(200);
  const renewed = await f.send(renewal("k-2"), { token });
  expect([renewed.status, renewed.code, renewed.exit]).toEqual([
    409,
    "LEASE_NOT_HELD",
    4,
  ]);
  const took = await f.send(claim("k-3", { id: "forge-12" }, asSession("b1")), {
    token: tablet,
  });
  expect([took.status, took.json.result]).toMatchObject([
    200,
    { id: "forge-12", generation: 3 },
  ]);
}, 60_000);
