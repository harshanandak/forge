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
import { leaseFingerprint } from "../../cloud/src/lease-command.ts";
import { Project } from "../../cloud/src/project.ts";
import { TABLE_PROBE, writableStore } from "../../cloud/src/store.ts";
import { authorityFault } from "../../cloud/src/v3-authority.ts";
import { verifyToken } from "../../cloud/src/v3-seal.ts";
import {
  append,
  archive,
  PAGE_BYTES,
  publishV3,
  readV3Value,
  recoverV3,
  releaseBudget,
  TAIL_ROWS,
} from "../../cloud/src/v3-store.ts";
import { createWorker } from "../../cloud/src/worker.ts";
import { canonicalJson } from "../../src/core/config/pointer.ts";
import type { ForgeError, LeaseRecord } from "../../src/generated/types.ts";
import { exitCode } from "../../src/surface/result.ts";
import {
  guardFixture,
  newKey,
  noWrites,
  portableOf,
  portableUpload,
  probe,
  recovered,
  type SealSetup,
  verifiedPortable,
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
  return readV3Value(db, recovered(db, f.seal()), "lease", "issue:work-1");
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
    f.db.run("DELETE FROM cloud_v3_tokens WHERE id=?", [u.id]);
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

for (const state of ["warm", "cold"]) {
  row(
    `an empty object id on a ${state} object refuses before any token read`,
    async (f, t) => {
      answers(await post(f, create, t), 200);
      f.context.id!.toString = () => "";
      if (state === "cold") f.restart();

      const seen = statements(f);
      const effects = f.observeEffects();
      const answer = await post(f, { ...create, requestId: "empty-id" }, t);

      answers(answer, 503, "UNAVAILABLE", 1);
      expect(answer.body).toEqual({
        ok: false,
        status: "FAIL",
        error: {
          code: "UNAVAILABLE",
          message: "Cloud v3 seal is not configured",
          retry: "never",
        },
        warnings: [],
      });
      expect(effects()).toEqual(noWrites);
      expect(seen).toEqual(state === "cold" ? [TABLE_PROBE] : []);
    },
  );
}

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
  "2 revoking the last v3 token releases the lease and a new token reclaims it",
  async (f, t) => {
    await claimedIssue(f, t);
    expect(heldLease(f).generation).toBe(1);
    released(await revoke(f, t), ["issue:work-1"]);
    const sibling = await issue(f);
    const before = frames(f).length;
    answers(await post(f, update, sibling), 409, "LEASE_NOT_HELD", 4);
    expect(frames(f).slice(before)).toMatchObject([
      { operation: "issue.update", outcome: { status: "LEASE_NOT_HELD" } },
    ]);
    answers(await post(f, namedClaim(1, "reclaim"), sibling), 200);
    expect(heldLease(f).generation).toBe(2);
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
      f.db.run("DELETE FROM cloud_v3_tokens WHERE id=?", [u.id]);
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

const firstSubject = "issue:work-1";
const leaseSubject = (number: number) => "issue:work-" + number;
const revoke = (f: Fixture, t: Token) => f.send("revoke", { id: t.id });
const namedClaim = (number: number, requestId = "claim-" + number) => ({
  ...claim,
  requestId,
  input: { ...claim.input, id: "forge-" + number },
});
const rooted = (f: Fixture) => {
  const db = writableStore(f.storage);
  return { db, image: recovered(db, f.seal()) };
};
const heldLease = (f: Fixture, subject = firstSubject) => {
  const { db, image } = rooted(f);
  const value = readV3Value(db, image, "lease", subject);
  expect(value).toBeDefined();
  return value!;
};
const tokenRow = (f: Fixture, t: Token) =>
  f.db
    .query<
      {
        id: string;
        hash: string;
        device: string;
        session: string;
        agent: string | null;
        harness: string | null;
        expires_at: number;
        revoked_at: number | null;
        mac: string;
      },
      [string]
    >("SELECT * FROM cloud_v3_tokens WHERE id=?")
    .get(t.id)!;
const stmt = (f: Fixture, sequence: number) =>
  f.db
    .query<{ body: string }, [number]>(
      "SELECT body FROM cloud_v3_commits WHERE sequence=?",
    )
    .get(sequence)!.body;
const owner = (device = "laptop") => ({
  "X-Forge-Owner": device,
  "X-Forge-Owner-Expires": String(Date.now() + ttlMs),
});

function legacy(
  a: Answer,
  status: number,
  code?: string,
  exit = code === undefined ? 0 : 1,
) {
  const body = a.body as { ok: boolean; value?: Json };
  expect([a.status, codeOf(a), body.ok]).toEqual([
    status,
    code,
    code === undefined,
  ]);
  expect(body.ok ? 0 : exitCode(envelope(a))).toBe(exit);
  return body.value;
}

function released(a: Answer, subjects: string[]) {
  const value = legacy(a, 200);
  expect(value).toMatchObject({ leasesReleased: true, released: subjects });
  return value;
}

function kept(a: Answer) {
  const value = legacy(a, 200);
  expect(value).toMatchObject({ leasesReleased: false });
  expect(value).not.toHaveProperty("released");
}

async function claimedIssue(
  f: Fixture,
  t: Token,
  number = 1,
  input = namedClaim(number),
) {
  const createReply = await post(
    f,
    { ...create, requestId: "create-" + number },
    t,
  );
  answers(createReply, 200);
  expect(createReply.body).toMatchObject({ result: { id: "forge-" + number } });
  const claimReply = await post(f, input, t);
  answers(claimReply, 200);
  expect(claimReply.body).toMatchObject({ result: { generation: 1 } });
  const value = heldLease(f, leaseSubject(number));
  expect(value.releasedAt).toBeUndefined();
  expect(Date.parse(value.expiresAt)).toBeGreaterThan(Date.now());
  return value;
}

const releaseId = (t: Token, device: string, subject: string) =>
  scopeRequestId(
    "lease",
    ["owner", device, device],
    "revoke/" + t.id + "/" + subject,
  );

function releaseFrame(t: Token, held: LeaseRecord, sequence: number) {
  const { subject, holder: stored, generation, expiresAt } = held;
  const device = stored.session.device!;
  const scope = receiptScope(["owner", device, device]);
  const rawId = "revoke/" + t.id + "/" + subject;
  const requestId = releaseId(t, device, subject);
  return {
    operation: "lease.release",
    format: "forge-cloud-commit/3",
    sequence,
    time: Date.now(),
    events: [],
    lease: { ...held, releasedAt: new Date().toISOString() },
    outcome: {
      id: requestId,
      scope: { family: "lease" as const, ...scope },
      fingerprint: leaseFingerprint({
        route: "release",
        subject,
        holder: stored,
        generation,
        ttlMs: null,
        rawId,
        requestId,
        scope,
      }),
      retryUntil: Date.parse(expiresAt),
      status: "ok",
    },
  };
}

const probeView = async (f: Fixture) => legacy(await f.send(probe), 200)!.image;
async function drainRevokeHistory(f: Fixture) {
  let more: boolean;
  do {
    const value = legacy(await f.send(probe + "/checkpoint", {}), 200)!;
    more = value.more as boolean;
  } while (more);
  expect(frames(f)).toEqual([]);
}

const transcript = (f: Fixture) =>
  f.db
    .query<{ body: string }, []>(
      "SELECT body FROM cloud_v3_pages WHERE id='transcript:0'",
    )
    .get()!.body;

const throwUnavailable = "Cloud v3 root is unavailable";

async function traceStatements(f: Fixture, run: () => Promise<Answer>) {
  const previous = f.storage.sql.exec;
  const seen: string[] = [];
  f.storage.sql.exec = (sql, ...bindings) => {
    seen.push(sql);
    return previous.call(f.storage.sql, sql, ...bindings);
  };
  try {
    return { reply: await run(), seen };
  } finally {
    f.storage.sql.exec = previous;
  }
}

row(
  "1 last token revokes and commits exactly its signed lease release",
  async (f, t) => {
    const held = await claimedIssue(f, t);
    const peer = await issue(f, "tablet");
    const peerRow = tokenRow(f, peer);
    const before = frames(f);
    const snapshot = f.snapshot();
    const record = ((await probeView(f)) as Json).record;
    const effects = f.observeEffects();
    expect(released(await revoke(f, t), [firstSubject])).toEqual({
      device: "laptop",
      session: "fixture",
      expiresAt: new Date(time + ttlMs).toISOString(),
      leasesReleased: true,
      released: [firstSubject],
    });
    expect(frames(f)).toEqual([
      ...before,
      releaseFrame(t, held, before.length + 1),
    ]);
    const signed = tokenRow(f, t);
    expect(signed.revoked_at).toBe(time);
    expect(
      verifyToken(
        f.seal(),
        {
          id: signed.id,
          hash: signed.hash,
          device: signed.device,
          session: signed.session,
          agent: signed.agent,
          harness: signed.harness,
          expiresAt: signed.expires_at,
          revokedAt: signed.revoked_at,
        },
        signed.mac,
      ),
    ).toBe(true);
    expect(tokenRow(f, peer)).toEqual(peerRow);
    expect(((await probeView(f)) as Json).record).toEqual(record);
    expect(f.snapshot().kv).toEqual(snapshot.kv);
    expect(effects().alarmWrites).toBe(0);
  },
);

row(
  "3 a live sibling keeps its lease without opening the image",
  async (f, t) => {
    const held = await claimedIssue(f, t);
    const sibling = await issue(f);
    const row = tokenRow(f, sibling);
    const before = frames(f);
    f.restart();
    const { reply, seen } = await traceStatements(f, () => revoke(f, t));
    kept(reply);
    expect(seen.filter((sql) => /cloud_v3_(commits|pages)/i.test(sql))).toEqual(
      [],
    );
    expect(frames(f)).toEqual(before);
    expect(heldLease(f)).toEqual(held);
    expect(tokenRow(f, sibling)).toEqual(row);
    answers(await post(f, update, sibling), 200);
  },
);

row(
  "4 revoked, expired and foreign siblings leave the last live holder releasable",
  async (f, t) => {
    await claimedIssue(f, t);
    const ended = await issue(f);
    kept(await revoke(f, ended));
    const expiring = await issue(f, "laptop", "fixture", { ttlMs: 30_000 });
    const others = [
      ended,
      expiring,
      await issue(f, "laptop", "second"),
      await issue(f, "tablet"),
    ];
    const rows = others.map((token) => tokenRow(f, token));
    setSystemTime(time + 31_000);
    released(await revoke(f, t), [firstSubject]);
    expect(others.map((token) => tokenRow(f, token))).toEqual(rows);
  },
);

test.each([
  ["agent edit", "agent", "edited"],
  ["oversized harness", "harness", "x".repeat(100_000)],
  ["live revoke time added", "revoked_at", time],
  ["prior revoke time cleared", "revoked_at", null],
  ["expiry moved into the past", "expires_at", time - 1],
  ["expiry moved into the future", "expires_at", time + ttlMs * 2],
  ["device hidden", "device", "tablet"],
  ["session hidden", "session", "second"],
  ["foreign row made a sibling", "device", "laptop"],
  ["malformed guarded id", "id", "wrong"],
  ["expiry type", "expires_at", String(time + ttlMs)],
  ["corruption follows live sibling", "agent", "edited"],
] as const)(
  "5 revoke authenticates the entire inventory before filtering: %s",
  async (name, field, invalid) => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    const t = await issue(f);
    const prior = await claimedIssue(f, t);
    const expiring = name === "expiry moved into the future";
    let edited = await issue(
      f,
      name === "foreign row made a sibling" ? "tablet" : "laptop",
      "fixture",
      expiring ? { ttlMs: 1000 } : {},
    );
    if (expiring) {
      setSystemTime(time + 1001);
      expect(tokenRow(f, edited).expires_at).toBeLessThan(Date.now());
    }
    if (name === "prior revoke time cleared") kept(await revoke(f, edited));
    if (name === "expiry type") relax(f);
    if (name === "corruption follows live sibling") {
      const other = await issue(f);
      const [earlier, later] = [edited, other].sort((a, b) =>
        a.id.localeCompare(b.id),
      );
      edited = later!;
      expect(earlier!.id < edited.id).toBe(true);
      expect(tokenRow(f, earlier!).revoked_at).toBeNull();
    }
    const row = tokenRow(f, edited);
    const target = tokenRow(f, t);
    const before = frames(f);
    f.db.run("UPDATE cloud_v3_tokens SET " + field + "=? WHERE id=?", [
      invalid,
      edited.id,
    ]);
    expect<unknown>(
      tokenRow(f, field === "id" ? { ...edited, id: String(invalid) } : edited)[
        field
      ],
    ).toBe(invalid);
    const observe = f.observeEffects();
    const { rows, bytes } = { ...f.reads };
    legacy(await revoke(f, t), 503, "UNAVAILABLE");
    expect(observe()).toEqual(noWrites);
    expect(f.reads.rows - rows).toBeLessThanOrEqual(24);
    expect(f.reads.bytes - bytes).toBeLessThanOrEqual(8192);
    expect(tokenRow(f, t)).toEqual(target);
    expect(frames(f)).toEqual(before);
    expect(heldLease(f)).toEqual(prior);
    f.db.run("UPDATE cloud_v3_tokens SET " + field + "=? WHERE id=?", [
      row[field],
      field === "id" ? invalid : edited.id,
    ]);
    answers(await post(f, update, t), 200);
  },
  timeout,
);

row(
  "6 repeats preserve the first release reply across restart, reclaim and checkpoint",
  async (f, t) => {
    await claimedIssue(f, t);
    const first = await revoke(f, t);
    released(first, [firstSubject]);
    const repeat = async () => {
      const effects = f.observeEffects();
      expect(await revoke(f, t)).toEqual(first);
      expect(effects()).toEqual(noWrites);
    };
    await repeat();
    f.restart();
    await repeat();
    const sibling = await issue(f);
    answers(await post(f, namedClaim(1, "repeat-reclaim"), sibling), 200);
    const reclaimed = heldLease(f);
    expect(reclaimed).toMatchObject({ generation: 2 });
    const id = releaseId(t, "laptop", firstSubject);
    const before = rooted(f);
    const outcome = readV3Value(before.db, before.image, "outcome", id);
    expect(outcome).toBeDefined();
    await drainRevokeHistory(f);
    f.restart();
    await repeat();
    const after = rooted(f);
    expect(readV3Value(after.db, after.image, "outcome", id)).toEqual(outcome);
    expect(heldLease(f)).toEqual(reclaimed);
  },
);

test.each(["second insert", "after token update"] as const)(
  "7 revoke rolls back the token and both leases after a fault at %s",
  async (point) => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    const t = await issue(f);
    const held = [await claimedIssue(f, t), await claimedIssue(f, t, 2)];
    const row = tokenRow(f, t);
    expect(row.revoked_at).toBeNull();
    const before = frames(f);
    const snapshot = f.snapshot();
    const warmBefore = (await probeView(f)) as Json;
    const previous = f.storage.sql.exec;
    let inserts = 0;
    let updates = 0;
    let afterUpdate = false;
    f.storage.sql.exec = (sql, ...bindings) => {
      if (/^INSERT INTO cloud_v3_commits/i.test(sql)) {
        inserts++;
        if (point === "second insert" && inserts === 2) throw new Error(point);
      }
      if (afterUpdate && /^SELECT changes\(\)/i.test(sql))
        throw new Error(point);
      const reply = previous.call(f.storage.sql, sql, ...bindings);
      if (/^UPDATE cloud_v3_tokens/i.test(sql)) {
        updates++;
        afterUpdate = point === "after token update";
      }
      return reply;
    };
    let reply: Answer;
    try {
      reply = await revoke(f, t);
    } finally {
      f.storage.sql.exec = previous;
    }
    expect(inserts).toBe(2);
    expect(updates).toBe(point === "second insert" ? 0 : 1);
    legacy(reply, 500, "INTERNAL");
    unchanged(f, snapshot);
    expect(tokenRow(f, t)).toEqual(row);
    expect(frames(f)).toEqual(before);
    expect(held.map(({ subject }) => heldLease(f, subject))).toEqual(held);
    answers(await post(f, update, t), 200);
    const afterUpdateImage = await probeView(f);
    expect((afterUpdateImage as Json).lease).toEqual(warmBefore.lease);
    f.restart();
    expect(await probeView(f)).toEqual(afterUpdateImage);
    const count = frames(f).length;
    released(
      await revoke(f, t),
      held.map(({ subject }) => subject),
    );
    expect(frames(f).slice(count)).toEqual(
      held.map((value, index) => releaseFrame(t, value, count + index + 1)),
    );
  },
  timeout,
);

row(
  "8 revoke changes only the device and session's live unreleased leases",
  async (f, t) => {
    await claimedIssue(f, t);
    const raw = async (
      number: number,
      route: "claim" | "release",
      duration = 60_000,
    ) =>
      legacy(
        await f.send(
          probe + "/" + route,
          {
            requestId: route + "-probe-" + number,
            subject: leaseSubject(number),
            holder,
            ...(route === "claim" ? { ttlMs: duration } : { generation: 1 }),
          },
          owner(),
        ),
        200,
      );
    for (const number of [2, 3]) {
      const response = await post(
        f,
        { ...create, requestId: "create-" + number },
        t,
      );
      answers(response, 200);
      expect(response.body).toMatchObject({
        result: { id: "forge-" + number },
      });
      await raw(number, "claim", number === 3 ? 1000 : 60_000);
    }
    await raw(2, "release");
    const otherSession = await issue(f, "laptop", "second");
    const otherDevice = await issue(f, "tablet");
    await claimedIssue(f, otherSession, 4, {
      ...namedClaim(4),
      context: { actor, session: { id: "second" } },
    });
    await claimedIssue(f, otherDevice, 5);
    setSystemTime(time + 2000);
    const subjects = [2, 3, 4, 5].map(leaseSubject);
    const other = subjects.map((subject) => heldLease(f, subject));
    expect(other[0]!.releasedAt).toBeDefined();
    expect(Date.parse(other[1]!.expiresAt)).toBeLessThan(Date.now());
    released(await revoke(f, t), [firstSubject]);
    expect(subjects.map((subject) => heldLease(f, subject))).toEqual(other);
  },
);

row(
  "9 revoke without a lease adds no commit and omits the released list",
  async (f, t) => {
    expect(frames(f)).toEqual([]);
    kept(await revoke(f, t));
    expect(frames(f)).toEqual([]);
  },
);

const firstRecord = {
  id: "work-1",
  prefix: "forge",
  title: "Before",
  status: "open",
  labels: [],
  dependsOn: [],
  createdAt: new Date(time).toISOString(),
};

async function fixtureIssue(f: Fixture) {
  legacy(
    await f.send(probe + "/commits", {
      frames: [
        {
          time,
          operation: "fixture.put",
          events: [{ key: "r1", revision: 1, value: firstRecord }],
          changes: [{ key: "r1", value: { revision: 1, value: firstRecord } }],
        },
      ],
    }),
    200,
  );
}

function portableImage(f: Fixture, portableTranscript: string) {
  return recoverV3(writableStore(f.storage), f.seal(), {
    admit: Project.admitLeaseRequest,
    manifest: verifiedPortable(f.seal(), portableTranscript),
    portableTranscript,
  });
}

async function portableClaim(f: Fixture, t: Token) {
  await fixtureIssue(f);
  answers(await post(f, namedClaim(1), t), 200);
  const held = heldLease(f);
  expect(held.generation).toBe(1);
  const copy = portableImage(
    f,
    canonicalJson(frames(f).map((frame) => archive(canonicalJson(frame)))),
  );
  expect(
    readV3Value(writableStore(f.storage), copy, "lease", firstSubject),
  ).toEqual(held);
  return held;
}

row(
  "10 control: portable recovery accepts a fixture record and typed claim",
  async (f, t) => {
    await portableClaim(f, t);
  },
);

row(
  "10 portable and cold recovery derive a genuine release, reject edits and retain its receipt",
  async (f, t) => {
    const held = await portableClaim(f, t);
    released(await revoke(f, t), [firstSubject]);
    const expected = releaseFrame(t, held, 3);
    const db = writableStore(f.storage);
    const receipt = { lease: expected.lease, outcome: expected.outcome, time };
    await drainRevokeHistory(f);
    f.restart();
    const cold = rooted(f).image;
    const archived = transcript(f);
    const portable = portableImage(f, archived);
    for (const image of [cold, portable]) {
      expect(readV3Value(db, image, "lease", firstSubject)).toEqual(
        expected.lease,
      );
      expect(readV3Value(db, image, "outcome", expected.outcome.id)).toEqual(
        receipt,
      );
    }
    for (const key of ["releasedAt", "generation", "fingerprint"] as const) {
      const edit = JSON.parse(archived) as Json[];
      const frame = edit.at(-1)!;
      const lease = frame.lease as Json;
      const outcome = frame.outcome as Json;
      const fingerprint = JSON.parse(String(outcome.fingerprint)) as Json;
      if (key === "releasedAt")
        lease.releasedAt = new Date(time + 1).toISOString();
      if (key === "generation") {
        lease.generation = 2;
        fingerprint.generation = 2;
      }
      if (key === "fingerprint") fingerprint.ttlMs = 1;
      outcome.fingerprint = canonicalJson(fingerprint);
      expect(authorityFault(frame, true)).toBeUndefined();
      expect(() => portableImage(f, canonicalJson(edit))).toThrow(
        throwUnavailable,
      );
    }
  },
);

row(
  "10 a signed local release whose body changes fails cold recovery",
  async (f, t) => {
    const held = await portableClaim(f, t);
    released(await revoke(f, t), [firstSubject]);
    const tail = frames(f).length;
    const expected = releaseFrame(t, held, tail);
    expect(JSON.parse(stmt(f, tail))).toEqual(expected);
    const mac = f.db
      .query<{ mac: string }, [number]>(
        "SELECT mac FROM cloud_v3_commits WHERE sequence=?",
      )
      .get(tail)!.mac;
    f.db.run("UPDATE cloud_v3_commits SET body=? WHERE sequence=?", [
      canonicalJson({
        ...expected,
        lease: { ...expected.lease, generation: 2 },
      }),
      tail,
    ]);
    expect(
      f.db
        .query<{ mac: string }, [number]>(
          "SELECT mac FROM cloud_v3_commits WHERE sequence=?",
        )
        .get(tail)!.mac,
    ).toBe(mac);
    f.restart();
    const effects = f.observeEffects();
    legacy(await f.send(probe), 503, "UNAVAILABLE");
    expect(effects()).toEqual(noWrites);
  },
);

row(
  "11 cold recovery keeps the release and the next claim increments generation",
  async (f, t) => {
    const first = await claimedIssue(f, t);
    released(await revoke(f, t), [firstSubject]);
    const sequence = frames(f).length;
    const initialRelease = releaseFrame(t, first, sequence);
    expect(frames(f).at(-1)).toEqual(initialRelease);
    f.restart();
    await probeView(f);
    expect(heldLease(f)).toEqual(initialRelease.lease);
    const next = await issue(f);
    answers(await post(f, namedClaim(1, "cold-reclaim"), next), 200);
    expect(heldLease(f).generation).toBe(2);
    expect(frames(f).slice(sequence)).toMatchObject([
      { operation: "issue.claim", lease: { generation: 2 } },
    ]);
    const { db, image } = rooted(f);
    expect(
      readV3Value(db, image, "outcome", initialRelease.outcome.id),
    ).toEqual({
      lease: initialRelease.lease,
      outcome: initialRelease.outcome,
      time,
    });
  },
);

row(
  "12 clients cannot submit a revoke release request identifier",
  async (f, t) => {
    await claimedIssue(f, t);
    const observe = f.observeEffects();
    legacy(
      await f.send(
        probe + "/release",
        {
          subject: firstSubject,
          holder,
          generation: 1,
          requestId: "revoke/" + t.id + "/" + firstSubject,
        },
        owner(),
      ),
      400,
      "INPUT_INVALID",
      6,
    );
    expect(observe()).toEqual(noWrites);
  },
);

row(
  "13 revoke between claim body chunks prevents a new lease",
  async (f, t) => {
    answers(await post(f, create, t), 200);
    const before = frames(f);
    expect(lease(f)).toBeUndefined();
    let completed = false;
    const reply = await during(
      f,
      t,
      async () => {
        kept(await revoke(f, t));
        completed = true;
      },
      JSON.stringify(claim),
    );
    expect(completed).toBe(true);
    answers(reply, 401, "AUTH_REVOKED");
    expect(frames(f)).toEqual(before);
    expect(lease(f)).toBeUndefined();
  },
);

test(
  "14 a stopped activated root revokes without reading commits or authenticating siblings",
  async () => {
    const source = guardFixture(env);
    const target = guardFixture(env);
    using _source = source.db;
    using _target = target.db;
    await provision(source);
    await fixtureIssue(source);
    await drainRevokeHistory(source);
    const portable = portableOf(source);
    const upload = portableUpload(target, portable);
    for (const page of portable.pages.keys()) legacy(await upload(page), 200);
    expect(rooted(target).image.root.activationDigest).toBeDefined();
    const t = await issue(target);
    const sibling = await issue(target);
    target.db.run("UPDATE cloud_v3_tokens SET agent=? WHERE id=?", [
      "bad",
      sibling.id,
    ]);
    const { reply, seen } = await traceStatements(target, () =>
      revoke(target, t),
    );
    kept(reply);
    expect(seen.filter((sql) => /cloud_v3_commits/i.test(sql))).toEqual([]);
    expect(tokenRow(target, t).revoked_at).toBe(time);
  },
  timeout,
);

test.each([false, true])(
  "15 revoke with damaged history and live sibling %s",
  async (sibling) => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    const t = await issue(f);
    await claimedIssue(f, t);
    if (sibling) await issue(f);
    const sequence = frames(f).length;
    f.db.run("UPDATE cloud_v3_commits SET body=? WHERE sequence=?", [
      "{}",
      sequence,
    ]);
    f.restart();
    const row = tokenRow(f, t);
    const observe = f.observeEffects();
    const { reply, seen } = await traceStatements(f, () => revoke(f, t));
    if (sibling) {
      kept(reply);
      expect(seen.filter((sql) => /cloud_v3_commits/i.test(sql))).toEqual([]);
    } else {
      legacy(reply, 503, "UNAVAILABLE");
      expect(observe()).toEqual(noWrites);
      expect(tokenRow(f, t)).toEqual(row);
    }
  },
  timeout,
);

test.each([false, true])(
  "16 revoke logs nothing with live sibling %s",
  async (sibling) => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    const t = await issue(f);
    await claimedIssue(f, t);
    if (sibling) await issue(f);
    expect(
      await logged(async () => {
        const reply = await revoke(f, t);
        if (sibling) kept(reply);
        else legacy(reply, 200);
      }),
    ).toEqual([]);
    expect(
      await logged(async () => {
        answers(await post(f, update, t), 401, "AUTH_REVOKED");
      }),
    ).toEqual([
      {
        auth: "refused",
        code: "AUTH_REVOKED",
        device: "laptop",
        session: "fixture",
        expiresAt: new Date(time + ttlMs).toISOString(),
      },
    ]);
  },
  timeout,
);

test(
  "20 an expired token revokes a still-live owner-probe lease",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    await fixtureIssue(f);
    const t = await issue(f, "laptop", "fixture", { ttlMs: 1000 });
    setSystemTime(time + 2000);
    expect(tokenRow(f, t).expires_at).toBeLessThan(Date.now());
    legacy(
      await f.send(
        probe + "/claim",
        {
          subject: firstSubject,
          holder,
          ttlMs: 60_000,
          requestId: "owner-after-expiry",
        },
        owner(),
      ),
      200,
    );
    const held = heldLease(f);
    expect(Date.parse(held.expiresAt)).toBeGreaterThan(Date.now());
    released(await revoke(f, t), [firstSubject]);
    expect(tokenRow(f, t).revoked_at).toBe(Date.now());
    const frame = releaseFrame(t, held, frames(f).length);
    expect(frames(f).at(-1)).toEqual(frame);
    expect(frame.outcome.retryUntil).toBe(Date.parse(held.expiresAt));
    await drainRevokeHistory(f);
    const copy = portableImage(f, transcript(f));
    expect(
      readV3Value(writableStore(f.storage), copy, "lease", firstSubject),
    ).toEqual(frame.lease);
  },
  timeout,
);

const fullHistory = "STORAGE_LIMIT_EXCEEDED";
const note = (pad: string) => ({
  operation: "fixture.note",
  time: Date.now(),
  events: pad ? [{ pad }] : [],
});
const commitBody = (frame: object, sequence: number) =>
  canonicalJson({ ...frame, sequence, format: "forge-cloud-commit/3" });

test.each([0, 1])(
  "21/24 a tail with %i free rows refuses a whole revoke batch",
  async (free) => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    const t = await issue(f);
    const leases = [await claimedIssue(f, t)];
    if (free === 1) leases.push(await claimedIssue(f, t, 2));
    const end = TAIL_ROWS - free;
    const insert = f.db.prepare(
      "INSERT INTO cloud_v3_commits VALUES (?, ?, ?)",
    );
    f.db.transaction(() => {
      for (let sequence = frames(f).length + 1; sequence <= end; sequence++) {
        const body = commitBody(note(""), sequence);
        insert.run(sequence, body, f.sign(sequence, body));
      }
    })();
    f.restart();
    const image = rooted(f).image;
    expect(image.head - image.root.coveredHead).toBe(end);
    expect(leases.map(({ subject }) => heldLease(f, subject))).toEqual(leases);
    const before = tokenRow(f, t);
    expect(before.revoked_at).toBeNull();
    const observe = f.observeEffects();
    const reply = await revoke(f, t);
    if (free === 1) expect(tokenRow(f, t).revoked_at).toBeNull();
    legacy(reply, 503, fullHistory);
    expect(observe()).toEqual(noWrites);
    expect(tokenRow(f, t)).toEqual(before);
    expect(frames(f)).toHaveLength(end);
    expect(leases.map(({ subject }) => heldLease(f, subject))).toEqual(leases);
    const ordinary = f.observeEffects();
    legacy(
      await f.send(probe + "/commits", { frames: [note("")] }),
      503,
      fullHistory,
    );
    expect(ordinary()).toEqual(noWrites);
  },
  timeout,
);

const escapedLabels = {
  device: "\u0001".repeat(256),
  id: "\u0001".repeat(200),
  agent: "\u0001".repeat(200),
  harness: "\u0001".repeat(200),
};
const escapedHolder = {
  actor: { kind: "agent" as const, id: escapedLabels.id },
  session: escapedLabels,
};

type CapacityBoundary = "rows" | "raw" | "transcript";

async function fillRawTail(f: Fixture, leases: LeaseRecord[]) {
  const send = () =>
    f.send(
      probe + "/claim",
      {
        subject: firstSubject,
        holder,
        ttlMs: 1,
        requestId: "replace-expired-refusal",
      },
      {
        ...owner("another-device"),
        "X-Forge-Owner-Expires": String(Date.now() + 1),
      },
    );
  let priorSize = 0;
  for (let count = 1; count < TAIL_ROWS; count++) {
    setSystemTime(time + count * 2);
    const observe = f.observeEffects();
    const reply = await send();
    if (reply.status === 503) {
      legacy(reply, 503, fullHistory);
      expect(observe()).toEqual(noWrites);
      expect(priorSize).toBeGreaterThan(0);
      const { image } = rooted(f);
      const room =
        1024 * 1024 -
        13_312 -
        image.tailBytes -
        leases.reduce((sum, lease) => sum + releaseBudget(lease).raw, 0);
      expect(room).toBeGreaterThanOrEqual(0);
      expect(room).toBeLessThan(priorSize + 1);
      const repeat = f.observeEffects();
      legacy(await send(), 503, fullHistory);
      expect(repeat()).toEqual(noWrites);
      return;
    }
    legacy(reply, 409, "LEASE_HELD", 4);
    priorSize = f.db
      .query<{ bytes: number }, []>(
        "SELECT length(CAST(body AS BLOB)) AS bytes FROM cloud_v3_commits ORDER BY sequence DESC LIMIT 1",
      )
      .get()!.bytes;
  }
  throw new Error("The fixture did not reach the raw tail limit");
}

async function fillOrdinaryHistory(
  f: Fixture,
  boundary: CapacityBoundary,
  leases: LeaseRecord[],
) {
  if (boundary === "raw") return fillRawTail(f, leases);
  const { db, image } = rooted(f);
  const sequence = image.head + 1;
  const sizes = leases.map(releaseBudget);
  const transcriptRoom =
    PAGE_BYTES -
    13_313 -
    image.usage.transcript -
    sizes.reduce((sum, budget) => sum + budget.transcript, 0);
  const rowRoom = TAIL_ROWS - 4 - image.head - sizes.length;
  const minimum = Buffer.byteLength(commitBody(note("x"), sequence));
  expect(transcriptRoom).toBeGreaterThan(minimum);
  expect(rowRoom).toBeGreaterThan(0);
  const filler =
    boundary === "rows"
      ? Array.from({ length: rowRoom }, () => note(""))
      : [note("x".repeat(transcriptRoom - minimum))];
  expect(append(db, f.seal(), image, filler)).toEqual({
    head: image.head + filler.length,
  });
  publishV3(image);
  f.restart();
  const full = rooted(f).image;
  if (boundary === "rows") expect(full.head + 4 + sizes.length).toBe(TAIL_ROWS);
  else
    expect(
      full.usage.transcript +
        13_313 +
        sizes.reduce((sum, budget) => sum + budget.transcript, 0),
    ).toBe(PAGE_BYTES);
}

test.each(["rows", "raw", "transcript"] as const)(
  "22 successive token revokes use their releases' reserved capacity at the %s boundary",
  async (boundary) => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    const tokens = [];
    const groups: LeaseRecord[][] = [];
    for (let group = 0; group < 4; group++) {
      const session = "session-" + group;
      const token = await issue(f, "laptop", session);
      tokens.push(token);
      const leases = [];
      for (let index = 1; index <= 4; index++) {
        const number = 4 * group + index;
        const labels =
          boundary === "raw" && number === 1
            ? { agent: escapedLabels.agent, harness: escapedLabels.harness }
            : {};
        leases.push(
          await claimedIssue(f, token, number, {
            ...namedClaim(number),
            context: { actor, session: { id: session, ...labels } },
          }),
        );
      }
      groups.push(leases);
    }
    await fillOrdinaryHistory(f, boundary, groups.flat());
    const ordinary = async () => {
      const observe = f.observeEffects();
      legacy(
        await f.send(probe + "/commits", { frames: [note("x".repeat(4096))] }),
        503,
        fullHistory,
      );
      expect(observe()).toEqual(noWrites);
    };
    if (boundary !== "raw") {
      await ordinary();
      await ordinary();
    }
    for (const [index, token] of tokens.entries()) {
      const subjects = groups[index]!.map(({ subject }) => subject).sort();
      const before = frames(f).length;
      released(await revoke(f, token), subjects);
      const actual = frames(f).slice(before);
      expect(
        actual.map((frame) => (frame.lease as LeaseRecord).subject),
      ).toEqual(subjects);
      expect(tokenRow(f, token).revoked_at).toBe(Date.now());
      if (boundary !== "raw") await ordinary();
    }
    const warm = await probeView(f);
    await drainRevokeHistory(f);
    f.restart();
    expect(await probeView(f)).toEqual(warm);
    for (const { subject } of groups.flat())
      expect(heldLease(f, subject).releasedAt).toBe(new Date().toISOString());
  },
  timeout,
);

test.each([true, false])(
  "23 revoke fixture with maximal escaped holder %s stays within the frame bound",
  async (escaped) => {
    let maximum = 0;
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    const t = escaped
      ? await issue(f, escapedLabels.device, escapedLabels.id, {
          agent: escapedLabels.agent,
          harness: escapedLabels.harness,
        })
      : await issue(f);
    const leases = [];
    const count = escaped ? 1 : 16;
    for (let number = 1; number <= count; number++) {
      leases.push(
        await claimedIssue(
          f,
          t,
          number,
          escaped
            ? { ...namedClaim(number), context: escapedHolder }
            : namedClaim(number),
        ),
      );
    }
    if (escaped) expect(leases[0]!.holder).toEqual(escapedHolder);
    const subjects = leases.map(({ subject }) => subject).sort();
    const before = frames(f).length;
    released(await revoke(f, t), subjects);
    expect(frames(f)).toHaveLength(before + count);
    for (const [index, subject] of subjects.entries()) {
      const sequence = before + index + 1;
      const body = stmt(f, sequence);
      expect(JSON.parse(body)).toMatchObject({
        sequence,
        operation: "lease.release",
        lease: { subject },
      });
      const bytes = Buffer.byteLength(body);
      maximum = Math.max(maximum, bytes);
      expect(bytes).toBeLessThanOrEqual(PAGE_BYTES);
      expect(bytes).toBeLessThanOrEqual(22_276);
    }
    const warm = await probeView(f);
    f.restart();
    expect(await probeView(f)).toEqual(warm);
    await drainRevokeHistory(f);
    f.restart();
    expect(await probeView(f)).toEqual(warm);
    console.log("Largest revoke release body in row 23:", maximum);
  },
  timeout,
);
