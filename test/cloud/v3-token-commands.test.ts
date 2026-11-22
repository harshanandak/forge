import { timingSafeEqual } from "node:crypto";
import {
  afterEach,
  beforeEach,
  expect,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import { failed, MAX_COMMAND_BODY } from "../../cloud/src/issue-commands.ts";
import {
  receiptScope,
  scopeRequestId,
} from "../../cloud/src/issue-request-id.ts";
import { TABLE_PROBE, writableStore } from "../../cloud/src/store.ts";
import { readV3Value, recoverV3 } from "../../cloud/src/v3-store.ts";
import { createWorker } from "../../cloud/src/worker.ts";
import type { ForgeError } from "../../src/generated/types.ts";
import { exitCode } from "../../src/surface/result.ts";
import {
  guardFixture,
  newKey,
  noWrites,
  probe,
  type SealSetup,
} from "./v3-project.fixture.ts";

if (!("timingSafeEqual" in crypto.subtle))
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    value: timingSafeEqual,
  });

const timeout = 30_000;
const time = Date.parse("2026-11-20T12:00:00.000Z");
const ttlMs = 3_600_000;
const env = { FORGE_CLOUD_PROJECT: "a", FORGE_CLOUD_ID_PREFIX: "forge" };
const actor = { kind: "agent", id: "fixture" };
const holder = { actor, session: { id: "fixture" } };
const create = {
  op: "issue.create",
  requestId: "create",
  input: { title: "Before" },
  context: { actor },
};
const claim = {
  op: "issue.claim",
  requestId: "claim",
  input: { id: "forge-1", ttlSeconds: 60 },
  context: holder,
};
const update = {
  op: "issue.update",
  requestId: "update",
  input: { id: "forge-1", expectRevision: 1, title: "After" },
  context: { ...holder, leaseGeneration: 1 },
};
const stranger = `fct_${"0".repeat(16)}.${"A".repeat(43)}`;
const marker = "fct_marker";

beforeEach(() => setSystemTime(time));
afterEach(() => setSystemTime());

type Fixture = ReturnType<typeof guardFixture>;
type Json = Record<string, unknown>;
type Answer = { status: number; body: unknown };
type Token = { id: string; token: string };
type Case = (f: Fixture, t: Token) => Promise<void>;

const enc = (text: string) => new TextEncoder().encode(text);
const bearer = (t: Token) => ({ authorization: `Bearer ${t.token}` });
const secretless = (t: Token): Token => ({
  ...t,
  token: `fct_${t.id}.${"A".repeat(43)}`,
});
const frames = ({ db }: Fixture) =>
  db
    .query<{ body: string }, []>(
      "SELECT body FROM cloud_v3_commits ORDER BY sequence",
    )
    .all()
    .map(({ body }) => JSON.parse(body) as Json);
const tokenRows = ({ db }: Fixture) =>
  JSON.stringify(db.query("SELECT * FROM cloud_v3_tokens ORDER BY id").all());
const codeOf = (a: Answer) =>
  (a.body as { error?: { code: string } }).error?.code;
const envelope = (a: Answer) =>
  "status" in (a.body as object)
    ? (a.body as ReturnType<typeof failed>)
    : failed((a.body as { error: ForgeError }).error);

function answers(a: Answer, status: number, code?: string, exit?: number) {
  expect([a.status, codeOf(a)]).toEqual([status, code]);
  expect(exitCode(envelope(a))).toBe(exit ?? (code === undefined ? 0 : 1));
}

async function provision(f: Fixture) {
  expect((await f.send(probe, {})).status).toBe(200);
}

async function issue(
  f: Fixture,
  device = "laptop",
  session = "fixture",
  extra: object = {},
) {
  const reply = await f.send("devices", { device, session, ttlMs, ...extra });
  expect(reply.status).toBe(200);
  return (reply.body as { value: Token }).value;
}

async function sent(f: Fixture, request: Request): Promise<Answer> {
  const response = await f.fetch(request);
  return { status: response.status, body: await response.json() };
}

const req = (
  headers: Record<string, string>,
  body: string | ReadableStream<Uint8Array>,
  project = "a",
) =>
  new Request(`https://fixture.example/p/${project}/command`, {
    method: "POST",
    headers,
    body,
    duplex: "half",
  });
const post = (f: Fixture, body: object, t: Token) =>
  f.send("command", body, bearer(t));
const raw = (f: Fixture, t: Token, text: string, extra = {}) =>
  sent(f, req({ ...bearer(t), ...extra }, text));

const slow = (text: string, between: () => unknown) =>
  new ReadableStream<Uint8Array>({
    start: (c) => c.enqueue(enc(text.slice(0, 9))),
    async pull(c) {
      await between();
      c.enqueue(enc(text.slice(9)));
      c.close();
    },
  });
const during = (
  f: Fixture,
  t: Token,
  between: () => unknown,
  text = JSON.stringify(create),
) => sent(f, req(bearer(t), slow(text, between)));

async function refuses(
  f: Fixture,
  run: () => Promise<Answer>,
  status: number,
  code: string,
  exit = 1,
) {
  const effects = f.observeEffects();
  answers(await run(), status, code, exit);
  expect(effects()).toEqual(noWrites);
}

function unchanged(f: Fixture, expected: ReturnType<Fixture["snapshot"]>) {
  const now = f.snapshot();
  expect(Buffer.from(now.sql).equals(expected.sql)).toBe(true);
  expect(JSON.stringify(now.kv)).toBe(JSON.stringify(expected.kv));
}

const lease = (f: Fixture) => {
  const db = writableStore(f.storage);
  return readV3Value(db, recoverV3(db, f.seal()), "lease", "issue:work-1");
};

async function logged(run: () => Promise<unknown>) {
  const spy = spyOn(console, "log").mockImplementation(() => undefined);
  try {
    await run();
    return spy.mock.calls.map(([line]) => JSON.parse(String(line)) as Json);
  } finally {
    spy.mockRestore();
  }
}

function statements(f: Fixture) {
  const seen: string[] = [];
  const inner = f.storage.sql.exec.bind(f.storage.sql);
  f.storage.sql.exec = (statement, ...bindings) => {
    seen.push(statement);
    return inner(statement, ...bindings);
  };
  return seen;
}

function row(name: string, run: Case, setup?: SealSetup) {
  test(
    name,
    async () => {
      const f = guardFixture(env, setup);
      using _db = f.db;
      await provision(f);
      await run(f, await issue(f));
    },
    timeout,
  );
}

function relax(f: Fixture) {
  const rows = f.db.query<Json, []>("SELECT * FROM cloud_v3_tokens").all();
  f.db.run("DROP TABLE cloud_v3_tokens");
  f.db.run(
    "CREATE TABLE cloud_v3_tokens (id, hash, device, session, agent, harness, expires_at, revoked_at, mac)",
  );
  for (const r of rows)
    f.db.run(
      "INSERT INTO cloud_v3_tokens VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      Object.values(r) as (string | number | null)[],
    );
}

test(
  "a v3 device token creates an issue through the ordinary command route as its own principal",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    const token = await issue(f);
    const rows = tokenRows(f);
    const before = frames(f).length;
    const effects = f.observeEffects();
    const reply = await post(f, create, token);
    const { error } = reply.body as { error?: { code: string } };
    expect([reply.status, error?.code]).toEqual([200, undefined]);
    answers(reply, 200);
    expect(reply.body).toMatchObject({
      ok: true,
      op: create.op,
      status: "OK",
      result: { id: "forge-1", title: "Before", revision: 1 },
    });
    const { sqlWriteAttempts, alarmWrites } = effects();
    expect({
      commitRows: frames(f).length - before,
      sqlWriteAttempts,
      alarmWrites,
    }).toEqual({ commitRows: 1, sqlWriteAttempts: 1, alarmWrites: 0 });
    expect(tokenRows(f)).toBe(rows);
    const principal = ["token", token.id, "laptop"] as const;
    expect(frames(f).at(-1)).toMatchObject({
      operation: create.op,
      outcome: {
        id: scopeRequestId("command", principal, create.requestId),
        scope: { family: "command", ...receiptScope(principal) },
        status: "ok",
        retryUntil: time + ttlMs,
      },
    });
  },
  timeout,
);

test(
  "owner and token outcomes with one request id stay apart in one image",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    const t = await issue(f);
    const same = { ...create, requestId: "same" };
    const owner = {
      "X-Forge-Owner": "laptop",
      "X-Forge-Owner-Expires": String(time + ttlMs),
    };
    const first = await f.send(`${probe}/command`, same, owner);
    const second = await post(f, same, t);
    expect([first.status, second.status]).toEqual([200, 200]);
    answers(first, 200);
    answers(second, 200);
    const ids = frames(f).map((frame) => (frame.outcome as Json).id);
    expect(ids).toEqual([
      scopeRequestId("command", ["owner", "laptop", "laptop"], "same"),
      scopeRequestId("command", ["token", t.id, "laptop"], "same"),
    ]);
    expect(ids[0]).not.toBe(ids[1]);
    for (let more = true; more;) {
      const reply = await f.send(`${probe}/checkpoint`, {});
      expect(reply.status).toBe(200);
      more = (reply.body as { value: { more: boolean } }).value.more;
    }
    f.restart();
    const effects = f.observeEffects();
    expect(await f.send(`${probe}/command`, same, owner)).toEqual(first);
    expect(await post(f, same, t)).toEqual(second);
    expect(effects()).toEqual(noWrites);
  },
  timeout,
);

row(
  "a changed input, or a new token for the same request id, is judged per token",
  async (f, t) => {
    const first = await post(f, create, t);
    answers(first, 200);
    await refuses(
      f,
      () => post(f, { ...create, input: { title: "Other" } }, t),
      409,
      "INPUT_CONFLICT",
      4,
    );
    const second = await issue(f);
    const [firstFrame] = frames(f);
    const write = f.observeEffects();
    const again = await post(f, create, second);
    answers(again, 200);
    expect(write().sqlWriteAttempts).toBe(1);
    expect(again.body).toMatchObject({ result: { id: "forge-2" } });
    expect(frames(f)).toHaveLength(2);
    expect(frames(f)[0]).toEqual(firstFrame);
    const replays = f.observeEffects();
    expect(await post(f, create, t)).toEqual(first);
    expect(await post(f, create, second)).toEqual(again);
    expect(replays()).toEqual(noWrites);
    expect(frames(f)).toHaveLength(2);
  },
);

row(
  "a revoked token is refused before the body, for a replay and on a warm object",
  async (f, t) => {
    answers(await post(f, create, t), 200);
    expect((await f.send("revoke", { id: t.id })).status).toBe(200);
    await refuses(f, () => post(f, create, t), 401, "AUTH_REVOKED");
    await refuses(
      f,
      () => post(f, { ...create, requestId: "two" }, t),
      401,
      "AUTH_REVOKED",
    );
    setSystemTime(time + ttlMs);
    await refuses(f, () => post(f, create, t), 401, "AUTH_REVOKED");
    setSystemTime(time);
    const fresh = await issue(f, "laptop", "fixture", { ttlMs: 1000 });
    answers(await post(f, { ...create, requestId: "three" }, fresh), 200);
    setSystemTime(time + 1000);
    await refuses(
      f,
      () => post(f, { ...create, requestId: "three" }, fresh),
      401,
      "AUTH_EXPIRED",
    );
  },
);

row(
  "credentials that do not match are refused in a fixed order",
  async (f, t) => {
    await refuses(f, () => post(f, create, secretless(t)), 401, "AUTH_INVALID");
    await refuses(
      f,
      () => post(f, create, { id: "0", token: stranger }),
      401,
      "AUTH_INVALID",
    );
    const gone = await issue(f);
    expect((await f.send("revoke", { id: gone.id })).status).toBe(200);
    await refuses(
      f,
      () => post(f, create, secretless(gone)),
      401,
      "AUTH_INVALID",
    );
    const bad = await issue(f);
    f.db.run("UPDATE cloud_v3_tokens SET device='tablet' WHERE id=?", [bad.id]);
    await refuses(
      f,
      () => post(f, create, secretless(bad)),
      503,
      "UNAVAILABLE",
    );
    await refuses(f, () => post(f, create, bad), 503, "UNAVAILABLE");
    setSystemTime(time + ttlMs);
    await refuses(f, () => post(f, create, gone), 401, "AUTH_REVOKED");
    await refuses(f, () => post(f, create, t), 401, "AUTH_EXPIRED");
    await refuses(f, () => post(f, create, secretless(t)), 401, "AUTH_INVALID");
  },
);

row("a token changed while the body is read ends the command", async (f) => {
  const set = (column: string, value: string) => (u: Token) =>
    f.db.run(`UPDATE cloud_v3_tokens SET ${column}=? WHERE id=?`, [
      value,
      u.id,
    ]);
  const cases: [
    string,
    (u: Token) => unknown,
    number,
    string,
    number,
    boolean,
  ][] = [
    [
      "revoked",
      (u) => f.send("revoke", { id: u.id }),
      401,
      "AUTH_REVOKED",
      1,
      false,
    ],
    [
      "expired",
      () => setSystemTime(time + ttlMs),
      401,
      "AUTH_EXPIRED",
      0,
      false,
    ],
    [
      "deleted",
      (u) => f.db.run("DELETE FROM cloud_v3_tokens WHERE id=?", [u.id]),
      401,
      "AUTH_INVALID",
      0,
      false,
    ],
    ["edited", set("device", "tablet"), 503, "UNAVAILABLE", 0, false],
    [
      "oversized device",
      set("device", "x".repeat(100_000)),
      503,
      "UNAVAILABLE",
      0,
      true,
    ],
    [
      "huge device",
      set("device", "x".repeat(400_000)),
      503,
      "UNAVAILABLE",
      0,
      true,
    ],
    ["empty session", set("session", ""), 503, "UNAVAILABLE", 0, true],
  ];
  for (const [, between, status, code, writes, small] of cases) {
    const u = await issue(f);
    const effects = f.observeEffects();
    const bytes = f.reads.bytes;
    let interleaved = f.snapshot();
    answers(
      await during(f, u, async () => {
        await between(u);
        interleaved = f.snapshot();
      }),
      status,
      code,
    );
    expect(effects()).toMatchObject({
      sqlWriteAttempts: writes,
      alarmWrites: 0,
    });
    unchanged(f, interleaved);
    expect(frames(f)).toEqual([]);
    if (small) expect(f.reads.bytes - bytes).toBeLessThan(4096);
    setSystemTime(time);
  }
  const u = await issue(f);
  const effects = f.observeEffects();
  let interleaved = f.snapshot();
  const reply = await during(
    f,
    u,
    async () => {
      await f.send("revoke", { id: u.id });
      interleaved = f.snapshot();
    },
    "{not json at all",
  );
  answers(reply, 401, "AUTH_REVOKED");
  expect(effects()).toMatchObject({ sqlWriteAttempts: 1, alarmWrites: 0 });
  unchanged(f, interleaved);
  expect(frames(f)).toEqual([]);
});

test(
  "no token table, another object's token and a copied row are refused with no write",
  async () => {
    const a = guardFixture(env);
    const b = guardFixture(env);
    const c = guardFixture(env, { key: String(a.env.V3_SEAL_KEY) });
    using _a = a.db;
    using _b = b.db;
    using _c = c.db;
    for (const f of [a, b, c]) await provision(f);
    const foreign = await issue(b);
    const twin = await issue(c);
    const tableCount = () =>
      a.db
        .query("SELECT name FROM sqlite_schema WHERE name='cloud_v3_tokens'")
        .all().length;
    await refuses(a, () => post(a, create, foreign), 401, "AUTH_INVALID");
    expect(tableCount()).toBe(0);
    await issue(a);
    const rows = tokenRows(a);
    await refuses(a, () => post(a, create, foreign), 401, "AUTH_INVALID");
    expect(tokenRows(a)).toBe(rows);
    const copied = c.db.query<Json, []>("SELECT * FROM cloud_v3_tokens").get()!;
    a.db.run(
      "INSERT INTO cloud_v3_tokens VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      Object.values(copied) as (string | number | null)[],
    );
    await refuses(a, () => post(a, create, twin), 503, "UNAVAILABLE");
  },
  timeout,
);

row(
  "an oversized or wrong-typed stored field is refused with a bounded read",
  async (f) => {
    const [one, two, three] = [
      await issue(f),
      await issue(f),
      await issue(f),
    ] as [Token, Token, Token];
    relax(f);
    const hurt = (column: string, value: unknown, u: Token) =>
      f.db.run(`UPDATE cloud_v3_tokens SET ${column}=? WHERE id=?`, [
        value as string,
        u.id,
      ]);
    hurt("device", "x".repeat(100_000), one);
    hurt("session", null, two);
    hurt("expires_at", "soon", three);
    for (const u of [one, two, three]) {
      const bytes = f.reads.bytes;
      await refuses(f, () => post(f, create, u), 503, "UNAVAILABLE");
      expect(f.reads.bytes - bytes).toBeLessThan(4096);
    }
  },
);

test(
  "the route refuses a bad bearer, a foreign project and owner headers before the object, and forwards a good one",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    const t = await issue(f);
    const adminSecret = newKey();
    const reached: string[] = [];
    const looked: string[] = [];
    const bindings = {
      ADMIN_TOKEN: adminSecret,
      ...env,
      PROJECTS: {
        idFromName: (name: string) => {
          looked.push(`name:${name}`);
          return name;
        },
        get: (id: string) => {
          looked.push(`get:${id}`);
          return {
            fetch: (request: Request) => {
              reached.push(request.url);
              return f.fetch(request);
            },
          };
        },
      },
    };
    const worker = async (request: Request): Promise<Answer> => {
      const response = await createWorker().fetch(request, bindings);
      return { status: response.status, body: await response.json() };
    };
    const text = JSON.stringify(create);
    const cases: [Record<string, string>, string, number, string][] = [
      [{}, "a", 401, "AUTH_REQUIRED"],
      [{ authorization: "Bearer nope" }, "a", 403, "AUTH_FORBIDDEN"],
      [{ authorization: `Bearer ${adminSecret}` }, "a", 403, "AUTH_FORBIDDEN"],
      [bearer(t), "b", 403, "AUTH_FORBIDDEN"],
      [{ ...bearer(t), "X-Forge-Owner": "laptop" }, "a", 403, "AUTH_FORBIDDEN"],
      [
        { ...bearer(t), "X-Forge-Owner-Expires": "1" },
        "a",
        403,
        "AUTH_FORBIDDEN",
      ],
    ];
    for (const [headers, project, status, code] of cases) {
      const effects = f.observeEffects();
      answers(await sent(f, req(headers, text, project)), status, code);
      answers(await worker(req(headers, text, project)), status, code);
      expect(effects()).toEqual(noWrites);
    }
    expect([reached, looked]).toEqual([[], []]);
    answers(await worker(req(bearer(t), text)), 200);
    expect(reached).toHaveLength(1);
    expect(looked).toEqual(["name:a", "get:a"]);
  },
  timeout,
);

row(
  "a body that names another device, session or project, or lacks its context, is refused before any write",
  async (f, t) => {
    const asked = (context: object, body: object = create) => ({
      ...body,
      context,
    });
    const cases: [object, number, string, number][] = [
      [
        asked({ actor, session: { id: "fixture", device: "tablet" } }, claim),
        403,
        "AUTH_DEVICE_MISMATCH",
        1,
      ],
      [
        asked({ ...holder, device: { id: "tablet" } }, claim),
        403,
        "AUTH_DEVICE_MISMATCH",
        1,
      ],
      [
        asked({ actor, session: { id: "second" } }),
        403,
        "AUTH_DEVICE_MISMATCH",
        1,
      ],
      [
        asked({ actor, session: { id: "second" } }, claim),
        403,
        "AUTH_DEVICE_MISMATCH",
        1,
      ],
      [asked({ actor }, claim), 400, "CONTEXT_MISSING", 6],
      [asked(holder, update), 400, "CONTEXT_MISSING", 6],
      [asked({ actor, project: { id: "b" } }), 400, "INPUT_INVALID", 6],
      [
        asked({ actor, project: { id: "a", root: "root" } }),
        400,
        "INPUT_INVALID",
        6,
      ],
      [{ ...create, op: "no.such" }, 404, "UNKNOWN_COMMAND", 3],
    ];
    for (const [body, status, code, exit] of cases)
      await refuses(f, () => post(f, body, t), status, code, exit);
    const spent = await logged(async () => {
      const effects = f.observeEffects();
      const reply = await post(f, { ...create, requestId: marker }, t);
      answers(reply, 400, "INPUT_INVALID", 6);
      expect(JSON.stringify(reply.body)).not.toContain(marker);
      expect(effects()).toEqual(noWrites);
    });
    expect(JSON.stringify(spent)).not.toContain(marker);
    expect(frames(f)).toEqual([]);
  },
);

row(
  "a body is bounded at 512 KiB by bytes, depth and nodes, and the stream stops at the limit",
  async (f, t) => {
    const limit = MAX_COMMAND_BODY;
    const padded = (size: number) => `{"pad":"${"x".repeat(size)}"}`;
    const nested = (depth: number) =>
      `{"x":${"[".repeat(depth)}${"]".repeat(depth)}}`;
    const wide = (n: number) => `{"x":[${new Array(n).fill(0).join(",")}]}`;
    expect(padded(limit - 10)).toHaveLength(limit);
    const over = [padded(limit - 9), padded(limit * 2)];
    const message = (reply: Answer) =>
      (reply.body as { error: { message: string } }).error.message;
    const transports: ((text: string) => Promise<Answer>)[] = [
      (text) => raw(f, t, text),
      (text) => raw(f, t, text, { "content-length": String(text.length) }),
      (text) =>
        sent(
          f,
          req(
            bearer(t),
            slow(text, () => undefined),
          ),
        ),
    ];
    for (const text of over) {
      for (const go of transports) {
        const effects = f.observeEffects();
        const reply = await go(text);
        answers(reply, 400, "INPUT_INVALID", 6);
        expect(message(reply)).toContain(`${limit} bytes`);
        expect(effects()).toEqual(noWrites);
      }
    }
    for (const go of transports) {
      const effects = f.observeEffects();
      const reply = await go(padded(limit - 10));
      answers(reply, 400, "INPUT_INVALID", 6);
      expect(message(reply)).toContain("body must be { requestId");
      expect(message(reply)).not.toContain("bytes");
      expect(effects()).toEqual(noWrites);
    }
    const parsed: [string, string][] = [
      [padded(limit - 10), "body must be { requestId"],
      [nested(31), "body must be { requestId"],
      [nested(32), "maxDepth limit of 32"],
      [wide(4998), "body must be { requestId"],
      [wide(4999), "maxNodes limit of 5000"],
      ["{not json", "body must be JSON"],
    ];
    for (const [text, message] of parsed) {
      const effects = f.observeEffects();
      const reply = await raw(f, t, text);
      answers(reply, 400, "INPUT_INVALID", 6);
      expect(
        (reply.body as { error: { message: string } }).error.message,
      ).toContain(message);
      expect(effects()).toEqual(noWrites);
    }
    const state = { pulls: 0, cancelled: false };
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        state.pulls++;
        c.enqueue(new Uint8Array(limit / 2));
      },
      cancel() {
        state.cancelled = true;
      },
    });
    await refuses(
      f,
      () => sent(f, req(bearer(t), endless)),
      400,
      "INPUT_INVALID",
      6,
    );
    expect(state.cancelled).toBe(true);
    expect(state.pulls).toBeLessThanOrEqual(4);
  },
);

row(
  "a seal key or object id that is missing or malformed refuses before any token read",
  async (f, t) => {
    const key = String(f.env.V3_SEAL_KEY);
    const id = f.context.id;
    const seen = statements(f);
    Reflect.deleteProperty(f.env, "V3_SEAL_KEY");
    await refuses(f, () => post(f, create, t), 503, "UNAVAILABLE");
    expect(seen).toEqual([]);
    Reflect.set(f.env, "V3_SEAL_KEY", "short");
    await refuses(f, () => post(f, create, t), 503, "UNAVAILABLE");
    expect(seen).toEqual([]);
    for (const bad of [undefined, "short"]) {
      if (bad === undefined) Reflect.deleteProperty(f.env, "V3_SEAL_KEY");
      else Reflect.set(f.env, "V3_SEAL_KEY", bad);
      f.restart();
      await refuses(f, () => post(f, create, t), 503, "UNAVAILABLE");
    }
    Reflect.set(f.env, "V3_SEAL_KEY", key);
    Reflect.deleteProperty(f.context, "id");
    f.restart();
    await refuses(f, () => post(f, create, t), 503, "UNAVAILABLE");
    expect(seen.every((statement) => statement === TABLE_PROBE)).toBe(true);
    Reflect.set(f.context, "id", id);
    f.restart();
    answers(await post(f, create, t), 200);
  },
);

row(
  "a damaged root is refused after the token and before the body is parsed",
  async (f, t) => {
    f.db.run("UPDATE cloud_v3_root SET body=json_set(body,'$.coveredHead',1)");
    f.restart();
    await refuses(f, () => post(f, create, t), 503, "UNAVAILABLE");
    await refuses(f, () => raw(f, t, "{not json"), 503, "UNAVAILABLE");
    await refuses(
      f,
      () => post(f, { ...create, op: "no.such" }, t),
      503,
      "UNAVAILABLE",
    );
  },
);

row(
  "a warm object reads the token row again for each command",
  async (f, t) => {
    answers(await post(f, create, t), 200);
    f.db.run("UPDATE cloud_v3_tokens SET device='tablet'");
    await refuses(
      f,
      () => post(f, { ...create, requestId: "two" }, t),
      503,
      "UNAVAILABLE",
    );
  },
);

row(
  "with the selection off the route is v2 and refuses a v3 token",
  async (f, t) => {
    f.restart(false);
    await refuses(f, () => post(f, create, t), 401, "AUTH_INVALID");
  },
);

test(
  "a v2 project with the selection on and no seal key still takes the v2 route",
  async () => {
    const f = guardFixture(env, { key: null, id: null });
    using db = f.db;
    f.restart(false);
    const device = await f.send("devices", { device: "laptop", ttlMs });
    expect(device.status).toBe(200);
    f.restart();
    const seen = statements(f);
    const { token } = (device.body as { value: { token: string } }).value;
    answers(await post(f, create, { id: "", token }), 200);
    expect(seen).toContain(TABLE_PROBE);
    expect(seen.filter((statement) => statement.includes("cloud_v3"))).toEqual(
      [],
    );
    expect(
      db
        .query("SELECT name FROM sqlite_schema WHERE name GLOB 'cloud_v3_*'")
        .all(),
    ).toEqual([]);
  },
  timeout,
);

row(
  "an earlier authentic token row restored after a revoke is accepted again, a stated limit (forge-1842)",
  async (f, t) => {
    const saved = f.db.query<Json, []>("SELECT * FROM cloud_v3_tokens").get()!;
    expect((await f.send("revoke", { id: t.id })).status).toBe(200);
    await refuses(f, () => post(f, create, t), 401, "AUTH_REVOKED");
    f.db.run("UPDATE cloud_v3_tokens SET revoked_at=?, mac=?", [
      saved.revoked_at,
      saved.mac,
    ] as (string | null)[]);
    const before = frames(f).length;
    answers(await post(f, create, t), 200);
    expect(frames(f)).toHaveLength(before + 1);
  },
);

row(
  "revoking a token releases no lease and a sibling token keeps acting under it, a stated limit (forge-1847)",
  async (f, t) => {
    answers(await post(f, create, t), 200);
    const claimed = await post(f, claim, t);
    answers(claimed, 200);
    expect(claimed).toMatchObject({
      status: 200,
      body: { result: { generation: 1 } },
    });
    const held = lease(f);
    expect(held).toMatchObject({ generation: 1 });
    const revoked = await f.send("revoke", { id: t.id });
    expect(revoked).toMatchObject({
      status: 200,
      body: { value: { leasesReleased: false } },
    });
    expect(lease(f)).toEqual(held);
    const sibling = await issue(f);
    const updated = await post(f, update, sibling);
    answers(updated, 200);
    expect(updated).toMatchObject({
      status: 200,
      body: { result: { id: "forge-1", title: "After", revision: 2 } },
    });
  },
);

test(
  "every token check writes one allowlisted audit line",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    const iso = new Date(time + ttlMs).toISOString();
    const holderLine = { device: "laptop", session: "fixture", expiresAt: iso };
    const granted = { auth: "granted", ...holderLine };
    const refused = (code: string) => ({
      auth: "refused",
      code,
      ...holderLine,
    });
    const t = await issue(f, "laptop", "fixture", {
      agent: "claude",
      harness: "codex",
    });
    const labels = { agent: "claude", harness: "codex" };
    expect(await logged(() => post(f, create, t))).toEqual([
      { ...granted, ...labels },
      { ...granted, ...labels },
    ]);
    const plain = await issue(f);
    expect(
      await logged(() => post(f, { ...create, requestId: "two" }, plain)),
    ).toEqual([granted, granted]);
    const invalid = { auth: "refused", code: "AUTH_INVALID" };
    expect(await logged(() => post(f, create, secretless(plain)))).toEqual([
      invalid,
    ]);
    expect(
      await logged(() => post(f, create, { id: "0", token: stranger })),
    ).toEqual([invalid]);
    const bare = guardFixture(env);
    using _bare = bare.db;
    await provision(bare);
    expect(await logged(() => post(bare, create, plain))).toEqual([invalid]);
    for (const [column, value] of [
      ["device", `${marker}${"x".repeat(9000)}`],
      ["device", marker],
    ] as const) {
      const u = await issue(f);
      f.db.run(`UPDATE cloud_v3_tokens SET ${column}=? WHERE id=?`, [
        value,
        u.id,
      ]);
      const line = { auth: "refused", code: "UNAVAILABLE", id: u.id };
      const lines = await logged(() => post(f, create, u));
      expect(lines).toEqual([line]);
      expect(JSON.stringify(lines)).not.toContain(marker);
      expect(await logged(() => post(f, create, secretless(u)))).toEqual([
        line,
      ]);
    }
    const gone = await issue(f);
    expect((await f.send("revoke", { id: gone.id })).status).toBe(200);
    expect(await logged(() => post(f, create, gone))).toEqual([
      refused("AUTH_REVOKED"),
    ]);
    expect(await logged(() => post(f, create, secretless(gone)))).toEqual([
      invalid,
    ]);
    const live = await issue(f);
    expect(
      await logged(() =>
        during(f, live, () => f.send("revoke", { id: live.id })),
      ),
    ).toEqual([granted, refused("AUTH_REVOKED")]);
    expect(await logged(() => sent(f, req({}, "{}")))).toEqual([]);
    expect(
      await logged(() => sent(f, req({ authorization: "Bearer nope" }, "{}"))),
    ).toEqual([]);
    expect(await logged(() => sent(f, req(bearer(t), "{}", "b")))).toEqual([]);
    const late = await issue(f);
    setSystemTime(time + ttlMs);
    expect(await logged(() => post(f, create, late))).toEqual([
      refused("AUTH_EXPIRED"),
    ]);
  },
  timeout,
);
