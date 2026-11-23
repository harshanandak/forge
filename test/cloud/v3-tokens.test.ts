import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { failed } from "../../cloud/src/issue-commands.ts";
import { createWorker } from "../../cloud/src/worker.ts";
import { writableStore } from "../../cloud/src/store.ts";
import { tokenParts } from "../../cloud/src/tokens.ts";
import { type TokenFields, verifyToken } from "../../cloud/src/v3-seal.ts";
import {
  authorizeV3Token,
  TOKEN_READ,
  tokenInventory,
} from "../../cloud/src/v3-tokens.ts";
import { ForgeFailure } from "../../src/contract/failure.ts";
import type { ForgeError } from "../../src/generated/types.ts";
import { exitCode } from "../../src/surface/result.ts";
import contextSchema from "../../schemas/context.json" with { type: "json" };
import { canonicalJson, digestBytes } from "../../src/core/config/pointer.ts";
import {
  fixture,
  guardFixture,
  newKey,
  noWrites,
  probe,
  type SealSetup,
  sqlMutation,
  trustedManifest,
} from "./v3-project.fixture.ts";

if (!("timingSafeEqual" in crypto.subtle))
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    value: timingSafeEqual,
  });

const timeout = 30_000;
const HOUR = 3_600_000;
const env = { FORGE_CLOUD_PROJECT: "a", FORGE_CLOUD_ID_PREFIX: "forge" };
const note = { operation: "fixture.note", time: 1, events: [] };
const body = { device: "laptop", session: "run-1", ttlMs: HOUR };
const create = {
  op: "issue.create",
  requestId: "create",
  input: { title: "Before" },
  context: { actor: { kind: "agent", id: "fixture" } },
};

type Base = ReturnType<typeof fixture>;
type Fixture = ReturnType<typeof guardFixture>;
interface Stored {
  id: string;
  hash: string;
  device: string;
  session: string | null;
  agent: string | null;
  harness: string | null;
  expires_at: number;
  revoked_at: number | null;
  mac: string;
}
interface Issued {
  id: string;
  token: string;
  parts: { id: string; hash: string };
}
interface Answer {
  status: number;
  body: unknown;
}

const sha = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
const macOf = (f: Base, row: Stored) => {
  const bytes = Buffer.from(String(f.env.V3_SEAL_KEY), "base64url");
  const signed = canonicalJson([
    "forge/v3/token/1",
    f.context.id!.toString(),
    row.id,
    row.hash,
    row.device,
    row.session,
    row.agent,
    row.harness,
    row.expires_at,
    row.revoked_at,
  ]);
  const tag = createHmac("sha256", bytes).update(signed).digest("hex");
  return `${sha(bytes).slice(0, 16)}.${tag}`;
};
const store = (f: Base) => writableStore(f.storage);
const tokenRows = (f: Base) =>
  f.db.query<Stored, []>("SELECT * FROM cloud_v3_tokens ORDER BY id").all();
const only = (f: Base) => tokenRows(f)[0]!;
const tableNames = (f: Base) =>
  f.db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_schema WHERE type='table'",
    )
    .all()
    .map(({ name }) => name);
const core = (f: Base) =>
  JSON.stringify(
    ["cloud_v3_root", "cloud_v3_pages", "cloud_v3_commits"].map((table) =>
      f.db.query(`SELECT * FROM ${table} ORDER BY 1`).all(),
    ),
  );
const readable = (f: Base) =>
  JSON.stringify(
    ["cloud_v3_root", "cloud_v3_pages", "cloud_v3_commits"].map((table) =>
      f.db
        .query<Record<string, unknown>, []>(`SELECT * FROM ${table}`)
        .all()
        .map((row) =>
          Object.values(row).map((value) =>
            ArrayBuffer.isView(value)
              ? Buffer.from(
                  value.buffer,
                  value.byteOffset,
                  value.byteLength,
                ).toString("latin1")
              : value,
          ),
        ),
    ),
  );
const refusal = (run: () => unknown): string => {
  try {
    run();
    return "ok";
  } catch (error) {
    return error instanceof ForgeFailure ? error.error.code : String(error);
  }
};
const answers = (
  reply: Answer,
  status: number,
  code?: string,
  exit?: number,
) => {
  expect([
    reply.status,
    (reply.body as { error?: { code: string } }).error?.code,
  ]).toEqual([status, code]);
  if (exit === undefined) return;
  const body = reply.body as { status?: string; error?: ForgeError };
  expect(
    exitCode(
      "status" in body
        ? (reply.body as ReturnType<typeof failed>)
        : failed(body.error!),
    ),
  ).toBe(exit);
};
const provision = async (f: Base) =>
  expect((await f.send(probe, {})).status).toBe(200);
const tamper = (f: Base, column: string, value: unknown) =>
  f.db.run(`UPDATE cloud_v3_tokens SET ${column}=?`, [value as string]);

async function issued(f: Base, extra: object = {}): Promise<Issued> {
  const reply = await f.send("devices", { ...body, ...extra });
  answers(reply, 200);
  const value = (reply.body as { value: { id: string; token: string } }).value;
  return { ...value, parts: await tokenParts(value.token) };
}
const check = (f: Base, t: Issued, now = Date.now()) =>
  authorizeV3Token(store(f), f.seal(), t.parts, now);
const checked = (f: Base, t: Issued, now?: number) =>
  refusal(() => check(f, t, now));

function v3test(
  name: string,
  run: (f: Fixture) => Promise<void> | void,
  setup?: SealSetup,
) {
  test(
    name,
    async () => {
      const f = guardFixture(env, setup);
      using _db = f.db;
      await provision(f);
      await run(f);
    },
    timeout,
  );
}

interface Portable {
  pages: { id: string; body: string }[];
  upload: (page: number) => Promise<Answer>;
}

async function commanded(target: Fixture, t: Issued) {
  const rows = JSON.stringify(tokenRows(target));
  const effects = target.observeEffects();
  const reply = await target.send("command", create, {
    authorization: `Bearer ${t.token}`,
  });
  expect(effects()).toEqual(noWrites);
  expect(JSON.stringify(tokenRows(target))).toBe(rows);
  return reply;
}

async function withActivated(
  run: (target: Fixture, portable: Portable) => Promise<void>,
  staged = false,
) {
  const source = guardFixture(env);
  const target = guardFixture(env);
  using _source = source.db;
  using _target = target.db;
  await provision(source);
  const sent = (route: string, input: object) =>
    source.send(`${probe}/${route}`, input);
  answers(await sent("commits", { frames: [note] }), 200);
  answers(await sent("checkpoint", {}), 200);
  const pages = source.db
    .query<{ id: string; body: string }, []>(
      "SELECT id, body FROM cloud_v3_pages ORDER BY id",
    )
    .all()
    .map((page) =>
      page.id === "transcript:0"
        ? { ...page, body: canonicalJson([{ sequence: 1 }]) }
        : page,
    );
  const root = JSON.parse(
    source.db
      .query<{ body: string }, []>("SELECT body FROM cloud_v3_root")
      .get()!.body,
  ) as Record<string, unknown>;
  const manifest = trustedManifest(target.seal(), {
    format: "forge-cloud-portable/4",
    head: 1,
    eventWatermark: root.eventWatermark as number,
    recordFloor: 0,
    publicDigest: root.publicDigest as string,
    pages: pages.map(({ id, body: text }) => ({
      id,
      bytes: Buffer.byteLength(text),
      hash: digestBytes(text),
    })),
    source: String(source.context.id),
  });
  const pin = digestBytes(canonicalJson(manifest));
  const upload = (page: number) =>
    target.send(
      "restore",
      { page, ...pages[page]!, ...(page === 0 && { manifest }) },
      page === 0 ? { "X-Forge-Manifest-Digest": pin } : {},
    );
  for (const page of staged ? [0] : pages.keys())
    expect(await upload(page)).toMatchObject({
      status: 200,
      body: { ok: true, value: { page, verified: page === 2 } },
    });
  if (!staged)
    expect(await target.send("status")).toMatchObject({
      body: { value: { initialized: true, stopped: true } },
    });
  await run(target, { pages, upload });
}

function worker(f: Base, admin: string) {
  const reached: string[] = [];
  const bindings = {
    ADMIN_TOKEN: admin,
    ...env,
    PROJECTS: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (request: Request) => {
          reached.push(request.url);
          const route = new URL(request.url).pathname.split("/").slice(3);
          const input = await request.json();
          const headers = Object.fromEntries(request.headers);
          const answer = await f.send(route.join("/"), input, headers);
          return Response.json(answer.body, { status: answer.status });
        },
      }),
    },
  };
  const call = async (route: string, input: unknown, bearer?: string) => {
    const response = await createWorker().fetch(
      new Request(`https://w.example/p/a/${route}`, {
        method: "POST",
        headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
        body: JSON.stringify(input),
      }),
      bindings,
    );
    const answer = (await response.json()) as { value: { id: string } };
    return { status: response.status, body: answer };
  };
  return { call, reached };
}

async function issueAndCheckRow(f: Fixture) {
  const before = core(f);
  const effects = f.observeEffects();
  const reply = await f.send("devices", { ...body, agent: "claude" });
  answers(reply, 200);
  const value = (reply.body as { value: Issued & { session: string } }).value;
  expect(value.token).toMatch(/^fct_[0-9a-f]{16}\.[A-Za-z0-9_-]{43}$/);
  expect(value.session).toBe("run-1");
  const secret = value.token.split(".")[1]!;
  const [row, ...others] = tokenRows(f);
  expect(others).toEqual([]);
  expect(row!.id).toBe(value.id);
  expect(row!.hash).toBe(sha(secret));
  expect(row!.hash).not.toBe(secret);
  expect([row!.agent, row!.harness, row!.revoked_at]).toEqual([
    "claude",
    null,
    null,
  ]);
  expect(row!.mac).toBe(macOf(f, row!));
  for (const key of ["provisioned", "STATE_EPOCH", "restore:next"])
    expect(f.values.has(key)).toBe(false);
  expect(
    tableNames(f).filter((name) => /^(state_|domain_cloud_)/.test(name)),
  ).toEqual([]);
  expect(core(f)).toBe(before);
  expect(f.alarms).toEqual([]);
  expect(effects().sqlWriteAttempts).toBe(2);
  const parts = await tokenParts(value.token);
  expect(check(f, { ...value, parts })).toEqual({
    id: value.id,
    device: "laptop",
    session: "run-1",
    agent: "claude",
    harness: null,
    expiresAt: row!.expires_at,
  });
}

v3test("admin issue on a provisioned v3 root stores one signed row", (f) =>
  issueAndCheckRow(f),
);

test(
  "admin issue on an activated stopped v3 root stores one signed row",
  () => withActivated((target) => issueAndCheckRow(target)),
  timeout,
);

const refusedBodies: [string, object][] = [
  ["no session", { device: "laptop", ttlMs: HOUR }],
  ["an empty session", { ...body, session: "" }],
  ["a ttl over 90 days", { ...body, ttlMs: 90 * 24 * HOUR + 1 }],
  ["an empty agent", { ...body, agent: "" }],
  ["a device with a lone surrogate", { ...body, device: "lap\ud800top" }],
  ["a session with a lone surrogate", { ...body, session: "run\udfff" }],
  ["an agent with a lone surrogate", { ...body, agent: "\ud800" }],
  ["a harness with a lone surrogate", { ...body, harness: "cli\udc00" }],
];
for (const [label, input] of refusedBodies)
  v3test(`v3 issue refuses ${label} and writes nothing`, async (f) => {
    const effects = f.observeEffects();
    answers(await f.send("devices", input), 400, "INPUT_INVALID");
    expect(effects()).toEqual(noWrites);
    expect(tableNames(f)).not.toContain("cloud_v3_tokens");
  });

const limits = contextSchema.$defs.Session.properties;
const labelCaps = [
  ["device", limits.device.maxLength],
  ["session", limits.id.maxLength],
  ["agent", limits.agent.maxLength],
  ["harness", limits.harness.maxLength],
] as const;
const scripts = [
  ["ASCII", "d"],
  ["astral", "\u{1F600}"],
] as const;
for (const [field, max] of labelCaps)
  for (const [script, unit] of scripts)
    for (const over of [false, true]) {
      const value = unit.repeat(max + (over ? 1 : 0));
      const input = { ...body, [field]: value };
      v3test(
        `v3 issue ${over ? "refuses" : "admits"} ${max + (over ? 1 : 0)} ${script} characters in ${field}`,
        async (f) => {
          const effects = f.observeEffects();
          const reply = await f.send("devices", input);
          if (over) {
            answers(reply, 400, "INPUT_INVALID", 6);
            expect(reply.body).toEqual({
              ok: false,
              error: {
                code: "INPUT_INVALID",
                message: "device labels must be well-formed text",
                retry: "never",
              },
            });
            expect(effects()).toEqual(noWrites);
            expect(tableNames(f)).not.toContain("cloud_v3_tokens");
            return;
          }
          const { token, id } = (reply.body as { value: Issued }).value;
          const [row, ...others] = tokenRows(f);
          expect(others).toEqual([]);
          const secret = token.split(".")[1]!;
          expect(token).toBe(`fct_${row!.id}.${secret}`);
          expect(row!.hash).toBe(sha(secret));
          const { ttlMs: _ttl, ...labels } = input;
          expect(reply).toEqual({
            status: 200,
            body: {
              ok: true,
              value: {
                id: row!.id,
                token,
                ...labels,
                expiresAt: new Date(row!.expires_at).toISOString(),
              },
            },
          });
          expect(exitCode(reply.body as Parameters<typeof exitCode>[0])).toBe(
            0,
          );
          expect(row![field]).toBe(value);
          expect(row!.mac).toBe(macOf(f, row!));
          const parts = await tokenParts(token);
          expect(check(f, { id, token, parts })[field]).toBe(value);
        },
      );
    }

v3test(
  "v3 authorization still grants a stored device over the issue limit",
  async (f) => {
    const t = await issued(f);
    const device = "d".repeat(limits.device.maxLength + 44);
    const row = { ...only(f), device };
    f.db.run("UPDATE cloud_v3_tokens SET device=?, mac=? WHERE id=?", [
      device,
      macOf(f, row),
      t.id,
    ]);
    const rows = tokenRows(f);
    const before = core(f);
    const effects = f.observeEffects();
    expect(check(f, t)).toEqual({
      id: t.id,
      device,
      session: "run-1",
      agent: null,
      harness: null,
      expiresAt: row.expires_at,
    });
    expect(effects()).toEqual(noWrites);
    expect(tokenRows(f)).toEqual(rows);
    expect(core(f)).toBe(before);
  },
);

type Damage = [string, (f: Base) => void, boolean];
const noKey = (f: Base) => Reflect.deleteProperty(f.env, "V3_SEAL_KEY");
const badKey = (f: Base) => Reflect.set(f.env, "V3_SEAL_KEY", "short");
const breaks: Damage[] = [
  ["a missing key, warm", noKey, false],
  ["a malformed key, warm", badKey, false],
  ["a missing key, cold", noKey, true],
  ["a malformed key, cold", badKey, true],
  ["no object id, cold", (f) => Reflect.deleteProperty(f.context, "id"), true],
];
const flipSeal = (f: Base) => {
  const { seal } = f.db
    .query<{ seal: string }, []>("SELECT seal FROM cloud_v3_root")
    .get()!;
  const last = seal.endsWith("0") ? "1" : "0";
  f.db.run("UPDATE cloud_v3_root SET seal=?", [`${seal.slice(0, -1)}${last}`]);
};
const roots: Damage[] = [
  ["a damaged root, warm", flipSeal, false],
  ["a damaged root, cold", flipSeal, true],
];
for (const [label, damage, cold] of [...breaks, ...roots])
  v3test(`v3 issue and revoke with ${label} write nothing`, async (f) => {
    const first = await issued(f);
    damage(f);
    if (cold) f.restart();
    const effects = f.observeEffects();
    const more = await f.send("devices", { ...body, device: "tablet" });
    answers(more, 503, "UNAVAILABLE");
    answers(await f.send("revoke", { id: first.id }), 503, "UNAVAILABLE");
    expect(effects()).toEqual(noWrites);
    expect(tokenRows(f)).toHaveLength(1);
    expect(only(f).revoked_at).toBeNull();
  });

v3test(
  "the real Worker admits issue and revoke only for the admin",
  async (f) => {
    const admin = randomBytes(24).toString("base64url");
    const { call, reached } = worker(f, admin);
    const device = await issued(f);
    const effects = f.observeEffects();
    for (const route of ["devices", "revoke"]) {
      const input = route === "devices" ? body : { id: device.id };
      answers(await call(route, input), 401, "AUTH_REQUIRED");
      for (const bearer of [`${admin}x`, device.token])
        answers(await call(route, input, bearer), 401, "AUTH_INVALID");
    }
    expect(effects()).toEqual(noWrites);
    expect(reached).toEqual([]);
    const made = await call("devices", { ...body, device: "tablet" }, admin);
    answers(made, 200);
    const id = made.body.value.id;
    const revoked = await call("revoke", { id }, admin);
    expect(revoked).toMatchObject({
      status: 200,
      body: { value: { device: "tablet", leasesReleased: false } },
    });
    const ended = tokenRows(f).filter((row) => row.revoked_at !== null);
    expect(ended.map((row) => row.id)).toEqual([id]);
  },
);

v3test("v3 revoke sets revoked_at once and keeps the first time", async (f) => {
  const t = await issued(f);
  const other = await issued(f, { device: "tablet" });
  const rowOf = (id: string) => tokenRows(f).find((row) => row.id === id)!;
  const otherRow = rowOf(other.id);
  const start = Date.now();
  const reply = await f.send("revoke", { id: t.id });
  answers(reply, 200);
  const value = (reply.body as { value: object }).value;
  expect(value).toMatchObject({ device: "laptop", leasesReleased: false });
  expect(Object.keys(value)).not.toContain("released");
  const row = rowOf(t.id);
  expect(row.revoked_at).toBeGreaterThanOrEqual(start);
  expect(row.mac).toBe(macOf(f, row));
  expect(rowOf(other.id)).toEqual(otherRow);
  expect(checked(f, t)).toBe("AUTH_REVOKED");
  expect(check(f, other).device).toBe("tablet");
  const before = f.snapshot();
  const effects = f.observeEffects();
  expect(await f.send("revoke", { id: t.id })).toEqual(reply);
  expect(effects()).toEqual(noWrites);
  expect(Buffer.from(f.snapshot().sql).equals(Buffer.from(before.sql))).toBe(
    true,
  );
  expect(rowOf(t.id).revoked_at).toBe(row.revoked_at);
});

v3test("v3 revoke of an unknown id or a bad MAC changes nothing", async (f) => {
  const t = await issued(f);
  const effects = f.observeEffects();
  answers(await f.send("revoke", { id: "0".repeat(16) }), 400, "INPUT_INVALID");
  tamper(f, "device", "phone");
  const edited = JSON.stringify(tokenRows(f));
  answers(await f.send("revoke", { id: t.id }), 503, "UNAVAILABLE");
  expect(effects().sqlWriteAttempts).toBe(0);
  expect(JSON.stringify(tokenRows(f))).toBe(edited);
});

test(
  "v3 revoke rolls back when the write fails after the update",
  async () => {
    let armed = false;
    const f = fixture((sql) => {
      if (armed && /^SELECT changes\(\)/.test(sql)) throw new Error("fault");
    });
    using _db = f.db;
    await provision(f);
    const t = await issued(f);
    const row = only(f);
    armed = true;
    expect((await f.send("revoke", { id: t.id })).status).not.toBe(200);
    armed = false;
    expect(only(f)).toEqual(row);
    expect(checked(f, t)).toBe("ok");
  },
  timeout,
);

test(
  "v3 token issue, revoke and the ordinary command on a stopped root",
  () =>
    withActivated(async (target) => {
      const t = await issued(target);
      expect(check(target, t).device).toBe("laptop");
      answers(await target.send("revoke", { id: t.id }), 200);
      expect(checked(target, t)).toBe("AUTH_REVOKED");
      answers(await commanded(target, t), 401, "AUTH_REVOKED", 1);
    }),
  timeout,
);

v3test("the check refuses wrong, unknown, expired and malformed", async (f) => {
  const t = await issued(f);
  const effects = f.observeEffects();
  const missing = (id: string) => ({ ...t, parts: { ...t.parts, id } });
  const wrong = {
    ...t,
    parts: await tokenParts(`fct_${t.id}.${"A".repeat(43)}`),
  };
  expect(checked(f, wrong)).toBe("AUTH_INVALID");
  expect(checked(f, missing("0".repeat(16)))).toBe("AUTH_INVALID");
  const malformed = await tokenParts("fct_short").catch((e: ForgeFailure) => e);
  expect((malformed as ForgeFailure).error.code).toBe("AUTH_INVALID");
  const { expires_at: expiry } = only(f);
  expect(checked(f, t, expiry - 1)).toBe("ok");
  expect(checked(f, t, expiry)).toBe("AUTH_EXPIRED");
  expect(effects()).toEqual(noWrites);
});

v3test(
  "the check answers invalid, with no table made, before any issue",
  async (f) => {
    const effects = f.observeEffects();
    const parts = await tokenParts(`fct_${"1".repeat(16)}.${"A".repeat(43)}`);
    expect(checked(f, { id: parts.id, token: "", parts })).toBe("AUTH_INVALID");
    expect(effects()).toEqual(noWrites);
    expect(tableNames(f)).not.toContain("cloud_v3_tokens");
  },
);

const edits: [string, string, unknown][] = [
  ["hash", "hash", "f".repeat(64)],
  ["device", "device", "phone"],
  ["session", "session", "run-2"],
  ["agent", "agent", "other"],
  ["harness", "harness", "other"],
  ["expiry", "expires_at", 1],
  ["revoked state", "revoked_at", 1],
];
for (const [label, column, value] of edits)
  v3test(`the check refuses a row whose ${label} was edited`, async (f) => {
    const t = await issued(f);
    tamper(f, column, value);
    const effects = f.observeEffects();
    expect(checked(f, t)).toBe("UNAVAILABLE");
    const parts = await tokenParts(`fct_${t.id}.${"A".repeat(43)}`);
    expect(checked(f, { ...t, parts })).toBe("UNAVAILABLE");
    expect(effects()).toEqual(noWrites);
  });

v3test("the check refuses a cleared revoke and a damaged MAC", async (f) => {
  const t = await issued(f);
  const good = only(f).mac;
  const keyId = good.slice(0, 16);
  await f.send("revoke", { id: t.id });
  tamper(f, "revoked_at", null);
  expect(checked(f, t)).toBe("UNAVAILABLE");
  const damaged = [
    `${keyId}.${"0".repeat(64)}`,
    `${"1".repeat(16)}.${good.slice(17)}`,
    `${keyId}.${good.slice(17, -1)}`,
    "x".repeat(81),
    "y".repeat(5000),
  ];
  for (const mac of damaged) {
    tamper(f, "mac", mac);
    expect(checked(f, t)).toBe("UNAVAILABLE");
  }
});

test(
  "the check refuses a row copied to another id or another object",
  async () => {
    const f = guardFixture(env);
    const g = guardFixture(env, { key: String(f.env.V3_SEAL_KEY) });
    using _f = f.db;
    using _g = g.db;
    await provision(f);
    await provision(g);
    const t = await issued(f);
    await issued(g, { device: "phone" });
    const row = only(f);
    const copy = (target: Base, id: string) =>
      target.db.run(
        "INSERT INTO cloud_v3_tokens VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          id,
          row.hash,
          row.device,
          row.session,
          row.agent,
          row.harness,
          row.expires_at,
          row.revoked_at,
          row.mac,
        ],
      );
    const moved = "1".repeat(16);
    copy(f, moved);
    expect(checked(f, { ...t, parts: { ...t.parts, id: moved } })).toBe(
      "UNAVAILABLE",
    );
    copy(g, t.id);
    expect(checked(g, t)).toBe("UNAVAILABLE");
    expect(checked(f, t)).toBe("ok");
  },
  timeout,
);

const rotated =
  "the check accepts the previous key only while it is configured";
test(
  rotated,
  async () => {
    const first = newKey();
    const f = guardFixture(env, { key: first });
    using _db = f.db;
    await provision(f);
    const kept = await issued(f);
    const ended = await issued(f, { device: "tablet" });
    Reflect.set(f.env, "V3_SEAL_KEY", newKey());
    Reflect.set(f.env, "V3_SEAL_KEY_PREVIOUS", first);
    const effects = f.observeEffects();
    expect(checked(f, kept)).toBe("ok");
    expect(effects()).toEqual(noWrites);
    answers(await f.send("revoke", { id: ended.id }), 200);
    const row = tokenRows(f).find(({ id }) => id === ended.id)!;
    expect(row.mac).toBe(macOf(f, row));
    Reflect.deleteProperty(f.env, "V3_SEAL_KEY_PREVIOUS");
    expect(checked(f, kept)).toBe("UNAVAILABLE");
    expect(checked(f, ended)).toBe("AUTH_REVOKED");
  },
  timeout,
);

const relaxed =
  "CREATE TABLE cloud_v3_tokens (id, hash, device, session, agent, harness, expires_at, revoked_at, mac)";
const valid: Record<string, unknown> = {
  id: "a".repeat(16),
  hash: "b".repeat(64),
  device: "laptop",
  session: "run-1",
  agent: null,
  harness: null,
  expires_at: Date.now() + HOUR,
  revoked_at: null,
  mac: `${"c".repeat(16)}.${"d".repeat(64)}`,
};
const insertRow = (f: Base, row: Record<string, unknown>) =>
  f.db.run(
    "INSERT INTO cloud_v3_tokens VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    Object.keys(valid).map((column) => row[column]) as never,
  );
const big = "x".repeat(100_000);
const unsafe = 9007199254740993n;
const late = 8_640_000_000_000_001;
const kindOf = (value: unknown) =>
  value === null
    ? "null"
    : typeof value === "string"
      ? "text"
      : value instanceof Buffer
        ? "blob"
        : Number.isInteger(value) || typeof value === "bigint"
          ? "integer"
          : "real";
const matrix: [string, string, unknown][] = [
  ["id", "big text", big],
  ["id", "a number", 5],
  ["hash", "big text", big],
  ["hash", "a number", 5],
  ["hash", "NULL", null],
  ["hash", "non-hex text", "z".repeat(64)],
  ["device", "big text", big],
  ["device", "text one byte over the bound", "x".repeat(8193)],
  ["device", "a number", 5],
  ["device", "NULL", null],
  ["device", "a blob", Buffer.from("blob")],
  ["session", "big text", big],
  ["session", "a number", 5],
  ["session", "NULL", null],
  ["session", "empty text", ""],
  ["agent", "big text", big],
  ["agent", "empty text", ""],
  ["agent", "a number", 5],
  ["agent", "a blob", Buffer.from("blob")],
  ["harness", "big text", big],
  ["harness", "empty text", ""],
  ["harness", "a number", 5],
  ["harness", "a blob", Buffer.from("blob")],
  ["mac", "big text", big],
  ["mac", "a number", 5],
  ["mac", "NULL", null],
  ["expires_at", "big text", big],
  ["expires_at", "a big blob", Buffer.alloc(100_000)],
  ["expires_at", "a fraction", 1.5],
  ["expires_at", "NULL", null],
  ["expires_at", "an unsafe integer", unsafe],
  ["expires_at", "a time past the Date range", late],
  ["expires_at", "a negative time", -1],
  ["revoked_at", "big text", big],
  ["revoked_at", "empty text", ""],
  ["revoked_at", "a negative time", -1],
  ["revoked_at", "a big blob", Buffer.alloc(100_000)],
  ["revoked_at", "a fraction", 1.5],
  ["revoked_at", "an unsafe integer", unsafe],
  ["revoked_at", "a time past the Date range", late],
];

const nullable = new Set(["agent", "harness", "revoked_at"]);
const refusedInJs = new Set(["non-hex text"]);
const projection = (f: Base, id: string) =>
  f.db.query<Stored & { shape_ok: number }, [string]>(TOKEN_READ).get(id);

v3test(
  "the shape guard refuses each malformed column of a really issued row",
  async (f) => {
    const t = await issued(f);
    const row = only(f);
    f.db.run("DROP TABLE cloud_v3_tokens");
    f.db.run(relaxed);
    for (const [column, label, value] of matrix) {
      f.db.run("DELETE FROM cloud_v3_tokens");
      insertRow(f, { ...row });
      expect(checked(f, t)).toBe("ok");
      f.db.run(`UPDATE cloud_v3_tokens SET ${column}=?`, [value as never]);
      const kind = f.db
        .query<{ kind: string }, []>(
          `SELECT typeof(${column}) AS kind FROM cloud_v3_tokens`,
        )
        .get()!;
      expect([column, label, kind.kind]).toEqual([
        column,
        label,
        kindOf(value),
      ]);
      const shape = projection(f, t.id);
      if (column !== "id") {
        const expected = refusedInJs.has(label) ? 1 : 0;
        expect([column, label, shape?.shape_ok]).toEqual([
          column,
          label,
          expected,
        ]);
        if (nullable.has(column))
          expect([column, label, macOf(f, shape!)]).toEqual([
            column,
            label,
            row.mac,
          ]);
      }
      const reads = f.reads.bytes;
      const code = column === "id" ? "AUTH_INVALID" : "UNAVAILABLE";
      expect([column, label, checked(f, t)]).toEqual([column, label, code]);
      expect(f.reads.bytes - reads).toBeLessThan(1024);
    }
  },
);

v3test(
  "the check refuses a hash set from a chosen secret even when that secret is presented",
  async (f) => {
    const t = await issued(f);
    const { mac } = only(f);
    const chosen = randomBytes(32).toString("base64url");
    tamper(f, "hash", sha(chosen));
    const parts = await tokenParts(`fct_${t.id}.${chosen}`);
    expect(parts.hash).toBe(only(f).hash);
    expect(only(f).mac).toBe(mac);
    expect(projection(f, t.id)?.shape_ok).toBe(1);
    expect(checked(f, { ...t, parts })).toBe("UNAVAILABLE");
  },
);

v3test(
  "the check refuses a made-up MAC and accepts real NULL labels",
  async (f) => {
    const t = await issued(f);
    expect(check(f, t)).toMatchObject({ agent: null, harness: null });
    const row = only(f);
    f.db.run("DELETE FROM cloud_v3_tokens");
    insertRow(f, { ...row, mac: `${row.mac.slice(0, 17)}${"0".repeat(64)}` });
    expect(checked(f, t)).toBe("UNAVAILABLE");
  },
);

v3test(
  "v3 token rows survive a real checkpoint and restart and stay out of root, pages and commits",
  async (f) => {
    const t = await issued(f, { agent: "claude" });
    const before = JSON.stringify(tokenRows(f));
    answers(await f.send(`${probe}/commits`, { frames: [note] }), 200);
    answers(await f.send(`${probe}/checkpoint`, {}), 200);
    f.restart();
    answers(await f.send(probe), 200);
    expect(JSON.stringify(tokenRows(f))).toBe(before);
    expect(checked(f, t)).toBe("ok");
    const row = only(f);
    const secret = t.token.split(".")[1]!;
    for (const needle of [t.id, row.hash, row.mac, secret, "laptop", "run-1"])
      expect(readable(f)).not.toContain(needle);
  },
);

test(
  "an exact restore retry on an activated target keeps tokens issued after activation valid and unchanged",
  () =>
    withActivated(async (target, portable) => {
      const t = await issued(target);
      const rows = JSON.stringify(tokenRows(target));
      expect(await portable.upload(2)).toMatchObject({
        status: 200,
        body: { ok: true, value: { page: 2, verified: true } },
      });
      expect(JSON.stringify(tokenRows(target))).toBe(rows);
      expect(checked(target, t)).toBe("ok");
      const fresh = await commanded(target, t);
      answers(fresh, 409, "INPUT_CONFLICT", 4);
      expect(JSON.stringify(fresh.body)).toContain(
        "The restored project is stopped",
      );
      answers(await target.send("revoke", { id: t.id }), 200);
      answers(await commanded(target, t), 401, "AUTH_REVOKED", 1);
    }),
  timeout,
);

test(
  "a well-formed v3 token is refused as before while a restore is only staged",
  () =>
    withActivated(async (target) => {
      const effects = target.observeEffects();
      const headers = {
        authorization: `Bearer fct_${"0".repeat(16)}.${"A".repeat(43)}`,
      };
      answers(
        await target.send("command", create, headers),
        401,
        "AUTH_INVALID",
        1,
      );
      expect(effects()).toEqual(noWrites);
    }, true),
  timeout,
);

test(
  "a token table with no root gets no genesis and blocks a new restore",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    f.db.run(relaxed);
    insertRow(f, valid);
    const effects = f.observeEffects();
    answers(await f.send(probe, {}), 503, "UNAVAILABLE");
    const page = { page: 0, id: "directory:0", body: "[]", manifest: {} };
    const refused = await f.send("restore", page);
    answers(refused, 409, "RESTORE_TARGET_NOT_EMPTY");
    expect(effects()).toEqual(noWrites);
    expect(tableNames(f)).not.toContain("cloud_v3_root");
    expect(tokenRows(f)).toHaveLength(1);
  },
  timeout,
);

v3test(
  "v3 accepts a whole earlier authentic token row, a stated limit",
  async (f) => {
    const t = await issued(f);
    const saved = only(f);
    await f.send("revoke", { id: t.id });
    expect(checked(f, t)).toBe("AUTH_REVOKED");
    f.db.run("UPDATE cloud_v3_tokens SET revoked_at=?, mac=?", [
      saved.revoked_at,
      saved.mac,
    ]);
    expect(checked(f, t)).toBe("ok");
  },
);

v3test(
  "a valid v3 token opens no state route, lease route or login route",
  async (f) => {
    const t = await issued(f);
    expect(check(f, t).device).toBe("laptop");
    const headers = { authorization: `Bearer ${t.token}` };
    const holder = { actor: { kind: "agent", id: "x" } };
    const claim = {
      subject: "work-1",
      holder: { ...holder, session: { id: "run-1", device: "laptop" } },
      requestId: "r",
      ttlMs: HOUR,
    };
    const effects = f.observeEffects();
    const routes: [string, object | undefined, number, string][] = [
      ["state/read", {}, 401, "AUTH_INVALID"],
      ["holder", undefined, 401, "AUTH_INVALID"],
      ["claim", claim, 401, "AUTH_INVALID"],
      ["renew", claim, 401, "AUTH_INVALID"],
      ["release", claim, 401, "AUTH_INVALID"],
      ["loginstart", {}, 403, "AUTH_FORBIDDEN"],
      ["loginpoll", {}, 403, "AUTH_FORBIDDEN"],
    ];
    for (const [route, input, status, code] of routes)
      answers(await f.send(route, input, headers), status, code, 1);
    expect(effects()).toEqual(noWrites);
    expect(tokenRows(f)).toHaveLength(1);
  },
);

test(
  "v2 devices and revoke with the selection on and no seal key are unchanged",
  async () => {
    const f = guardFixture(env, { key: null, id: null });
    using _db = f.db;
    const reply = await f.send("devices", { device: "laptop", ttlMs: HOUR });
    answers(reply, 200);
    const id = (reply.body as { value: { id: string } }).value.id;
    expect(f.values.get("provisioned")).toBe(true);
    expect(tableNames(f)).toContain("domain_cloud_tokens");
    expect(tableNames(f).filter((n) => n.startsWith("cloud_v3_"))).toEqual([]);
    expect(await f.send("revoke", { id })).toMatchObject({
      status: 200,
      body: { value: { device: "laptop", released: [] } },
    });
  },
  timeout,
);

v3test("a v3 object with the selection off answers as on main", async (f) => {
  f.restart(false);
  const effects = f.observeEffects();
  const refused = await f.send("devices", body);
  answers(refused, 409, "INPUT_CONFLICT");
  expect(refused.body).toMatchObject({
    error: { message: "Cloud v3 projects cannot use v2 routes" },
  });
  const unknown = await f.send("revoke", { id: "0".repeat(16) });
  answers(unknown, 400, "INPUT_INVALID");
  expect(effects()).toEqual(noWrites);
  expect(tableNames(f)).not.toContain("cloud_v3_tokens");
});

const DAY = 24 * HOUR;
const RETENTION = 7 * DAY;
const base = Date.parse("2026-11-20T12:00:00.000Z");
const at = (time: number) => setSystemTime(time);
afterEach(() => setSystemTime());

const REAL =
  "CREATE TABLE IF NOT EXISTS cloud_v3_tokens (id TEXT PRIMARY KEY, hash TEXT NOT NULL, device TEXT NOT NULL, session TEXT NOT NULL, agent TEXT, harness TEXT, expires_at INTEGER NOT NULL, revoked_at INTEGER, mac TEXT NOT NULL) WITHOUT ROWID";
type Over = Record<string, unknown>;
const signed = (f: Base, i: number, over: Over = {}): Stored => {
  const row = {
    id: i.toString(16).padStart(16, "0"),
    hash: sha(`secret-${i}`),
    device: "laptop",
    session: "run-1",
    agent: null,
    harness: null,
    expires_at: base + 30 * DAY,
    revoked_at: null,
    ...over,
  } as Stored;
  return { ...row, mac: (over.mac as string | undefined) ?? macOf(f, row) };
};
const put = (f: Base, rows: Stored[]) => {
  f.db.run(REAL);
  for (const row of rows) insertRow(f, { ...row });
};
const fill = (f: Base, count: number, over: (i: number) => Over = () => ({})) =>
  put(
    f,
    Array.from({ length: count }, (_, i) => signed(f, i + 1, over(i))),
  );
const edit = (f: Base, id: string, patch: Over) =>
  f.db.run(
    `UPDATE cloud_v3_tokens SET ${Object.keys(patch)
      .map((column) => `${column}=?`)
      .join()} WHERE id=?`,
    [...Object.values(patch), id] as never,
  );
const drop = (f: Base, id: string) =>
  f.db.run("DELETE FROM cloud_v3_tokens WHERE id=?", [id]);
const rowsOf = (f: Base) =>
  tableNames(f).includes("cloud_v3_tokens") ? tokenRows(f) : [];
const state = (f: Base) =>
  JSON.stringify([
    tableNames(f),
    rowsOf(f),
    tableNames(f).includes("cloud_v3_root") ? core(f) : null,
  ]);
const fieldsOf = (r: Stored): TokenFields => ({
  id: r.id,
  hash: r.hash,
  device: r.device,
  session: r.session!,
  agent: r.agent,
  harness: r.harness,
  expiresAt: r.expires_at,
  revokedAt: r.revoked_at,
});

const err = (code: string, message: string, retry = "never") =>
  ({ code, message, retry }) as ForgeError;
const down = err("UNAVAILABLE", "Cloud v3 token storage is unavailable");
const full = err(
  "STORAGE_LIMIT_EXCEEDED",
  "This project keeps at most 64 device tokens. A row can be removed during a later issue only when both its expiry and any revoke are at least 7 days old.",
);
const gone = err("INPUT_INVALID", "No such device token");
const unverified = "Cloud v3 portable restore could not be verified";
const issue = (f: Base, extra: Over = {}) =>
  f.send("devices", { ...body, ...extra });

async function refused(
  f: Fixture,
  route: string,
  input: object,
  status: number,
  error: ForgeError,
  exit: number,
  headers?: Record<string, string>,
) {
  const before = state(f);
  const bytes = f.reads.bytes;
  const effects = f.observeEffects();
  const reply = await f.send(route, input, headers);
  const used = f.reads.bytes - bytes;
  expect(reply).toEqual({ status, body: { ok: false, error } });
  expect(exitCode(failed(error))).toBe(exit);
  expect(effects()).toEqual(noWrites);
  expect(state(f)).toBe(before);
  return used;
}

function admitted(reply: Answer, now: number, ttl: number, labels: Over = {}) {
  const { id, token } = (reply.body as { value: Issued }).value;
  expect(reply).toEqual({
    status: 200,
    body: {
      ok: true,
      value: {
        id,
        token,
        device: "laptop",
        session: "run-1",
        ...labels,
        expiresAt: new Date(now + ttl).toISOString(),
      },
    },
  });
  expect(token).toMatch(/^fct_[0-9a-f]{16}\.[A-Za-z0-9_-]{43}$/);
  expect(exitCode(reply.body as Parameters<typeof exitCode>[0])).toBe(0);
  return id;
}

async function admit(
  f: Base,
  kept: (rows: Stored[]) => Stored[],
  now = base,
  ttl = HOUR,
) {
  const rows = rowsOf(f);
  const before = tableNames(f).includes("cloud_v3_root") ? core(f) : "";
  const id = admitted(await issue(f, { ttlMs: ttl }), now, ttl);
  const after = tokenRows(f);
  const fresh = after.filter((row) => row.id === id);
  expect(fresh).toHaveLength(1);
  expect(fresh[0]!.mac).toBe(macOf(f, fresh[0]!));
  expect(after.filter((row) => row.id !== id)).toEqual(kept(rows));
  expect(tableNames(f).includes("cloud_v3_root") ? core(f) : "").toBe(before);
}

const clocked = (name: string, run: (f: Fixture) => Promise<void> | void) =>
  v3test(name, async (f) => {
    at(base);
    await run(f);
  });

clocked("v3 issue admits the 64th token on 63 live rows", async (f) => {
  fill(f, 63);
  await admit(f, (rows) => rows);
  expect(tokenRows(f)).toHaveLength(64);
});

clocked(
  "v3 issue refuses the 65th token at 64 live rows and revoke still works",
  async (f) => {
    fill(f, 64);
    const [first, ...rest] = tokenRows(f);
    await refused(f, "devices", body, 503, full, 1);
    const reply = await f.send("revoke", { id: first!.id });
    expect(reply).toEqual({
      status: 200,
      body: {
        ok: true,
        value: {
          device: "laptop",
          session: "run-1",
          expiresAt: new Date(first!.expires_at).toISOString(),
          leasesReleased: false,
        },
      },
    });
    expect(exitCode(reply.body as Parameters<typeof exitCode>[0])).toBe(0);
    const revoked = { ...first!, revoked_at: base };
    expect(tokenRows(f)).toEqual([
      { ...revoked, mac: macOf(f, revoked) },
      ...rest,
    ]);
  },
);

const lapsed = (gap: number): [string, Over][] => [
  ["expired", { expires_at: base - gap }],
  ["was revoked", { expires_at: base - 30 * DAY, revoked_at: base - gap }],
];
for (const [label, over] of lapsed(RETENTION))
  clocked(
    `v3 issue at the cap deletes a row that ${label} exactly 7 days ago and admits`,
    async (f) => {
      fill(f, 64, (i) => (i === 0 ? over : {}));
      await admit(f, (rows) => rows.slice(1));
      expect(tokenRows(f)).toHaveLength(64);
    },
  );
for (const [label, over] of lapsed(RETENTION - 1))
  clocked(
    `v3 issue at the cap keeps a row that ${label} 7 days less 1 ms ago and refuses`,
    async (f) => {
      fill(f, 64, (i) => (i === 0 ? over : {}));
      await refused(f, "devices", body, 503, full, 1);
    },
  );

clocked(
  "v3 issue keeps a revoked token until 7 days after its expiry",
  async (f) => {
    fill(f, 63);
    const t = await issued(f);
    answers(await f.send("revoke", { id: t.id }), 200);
    const due = base + RETENTION + HOUR;
    at(due - 1);
    await refused(f, "devices", body, 503, full, 1);
    at(due);
    await admit(f, (rows) => rows.filter((row) => row.id !== t.id), due);
  },
);

const old = { expires_at: base - 8 * DAY };
const ended = { expires_at: base - 30 * DAY, revoked_at: base - DAY };
const spoiled: [string, Over, (x: Stored) => Over, boolean][] = [
  ["an old row with a changed agent", old, () => ({ agent: "other" }), true],
  [
    "an old row with a zeroed MAC",
    old,
    (x) => ({ mac: `${x.mac.slice(0, 17)}${"0".repeat(64)}` }),
    true,
  ],
  ["a live row with its expiry moved back", {}, () => old, false],
  [
    "a revoked row with its revoke moved back",
    ended,
    () => ({ revoked_at: base - 8 * DAY }),
    false,
  ],
  [
    "a revoked row with its revoke cleared",
    ended,
    () => ({ revoked_at: null }),
    false,
  ],
  ["a live row with a changed device", {}, () => ({ device: "phone" }), false],
  [
    "a live row with a changed session",
    {},
    () => ({ session: "run-2" }),
    false,
  ],
];

async function mended(
  f: Fixture,
  spoil: () => void,
  fix: () => void,
  removed: string[] = [],
) {
  const start = tokenRows(f);
  spoil();
  const used = await refused(f, "devices", body, 503, down, 1);
  fix();
  expect(tokenRows(f)).toEqual(start);
  await admit(f, (rows) => rows.filter((row) => !removed.includes(row.id)));
  return used;
}

for (const [label, over, damage, deleted] of spoiled)
  clocked(
    `v3 issue refuses ${label} and admits again once it is repaired`,
    async (f) => {
      await issued(f);
      const x = signed(f, 1, over);
      put(f, [x]);
      const patch = damage(x);
      const undo = Object.fromEntries(
        Object.keys(patch).map((column) => [column, x[column as keyof Stored]]),
      );
      await mended(
        f,
        () => edit(f, x.id, patch),
        () => edit(f, x.id, undo),
        deleted ? [x.id] : [],
      );
    },
  );

const badMac = `${"0".repeat(16)}.${"0".repeat(64)}`;
const junk: [string, Over][] = [
  ["an id of 16 zeros", { mac: badMac }],
  ["an id of 16 f", { id: "f".repeat(16), mac: badMac }],
  ["a non-hex id", { id: "g".repeat(16) }],
  ["an id of 17 bytes", { id: "1".repeat(17) }],
  ["a text expiry", { expires_at: "soon" }],
  ["a 100,000 byte harness", { harness: "x".repeat(100_000) }],
];
for (const [label, over] of junk)
  clocked(
    `v3 issue refuses a junk row with ${label} and admits again once it is gone`,
    async (f) => {
      await issued(f);
      await issued(f, { device: "tablet" });
      const j = signed(f, 0, over);
      const used = await mended(
        f,
        () => put(f, [j]),
        () => drop(f, j.id),
      );
      if ("harness" in over) expect(used).toBeLessThan(4096);
    },
  );

async function crowded(f: Fixture, over: (i: number) => Over, extra: number) {
  fill(f, 65, over);
  const start = tokenRows(f);
  await refused(f, "devices", body, 503, down, 1);
  drop(f, start[extra]!.id);
}
clocked("v3 issue refuses 65 live rows, then 64 live rows", async (f) => {
  await crowded(f, () => ({}), 64);
  await refused(f, "devices", body, 503, full, 1);
});
clocked(
  "v3 issue refuses 65 rows, then deletes 5 old rows of 64",
  async (f) => {
    await crowded(f, (i) => (i > 0 && i < 6 ? old : {}), 0);
    await admit(f, (rows) => rows.slice(5));
    expect(tokenRows(f)).toHaveLength(60);
  },
);

for (const [label, ttl] of [
  ["7 days", 7 * DAY],
  ["7 days and 1 ms", 7 * DAY + 1],
  ["90 days", 90 * DAY],
] as const)
  clocked(
    `v3 issue ${ttl === 7 * DAY ? "admits" : "refuses"} a ttl of ${label}`,
    async (f) => {
      if (ttl === 7 * DAY) return admit(f, (rows) => rows, base, ttl);
      const message = err("INPUT_INVALID", "ttlMs is over 7 days");
      await refused(f, "devices", { ...body, ttlMs: ttl }, 400, message, 6);
      expect(tableNames(f)).not.toContain("cloud_v3_tokens");
    },
  );

test(
  "v2 devices keeps its 90 day limit",
  async () => {
    const f = guardFixture(env, { key: null, id: null });
    using _db = f.db;
    at(base);
    const reply = await f.send("devices", {
      device: "laptop",
      ttlMs: 90 * DAY,
    });
    answers(reply, 200);
    expect(
      (reply.body as { value: { expiresAt: string } }).value.expiresAt,
    ).toBe(new Date(base + 90 * DAY).toISOString());
    expect(exitCode(reply.body as Parameters<typeof exitCode>[0])).toBe(0);
    const input = { device: "laptop", ttlMs: 90 * DAY + 1 };
    const message = err("INPUT_INVALID", "ttlMs is over 90 days");
    await refused(f, "devices", input, 400, message, 6);
    expect(tableNames(f).filter((n) => n.startsWith("cloud_v3_"))).toEqual([]);
  },
  timeout,
);

clocked(
  "a repeat revoke gets its first answer until the row is deleted, then the unknown-id answer",
  async (f) => {
    const t = await issued(f);
    const first = await f.send("revoke", { id: t.id });
    answers(first, 200);
    expect(exitCode(first.body as Parameters<typeof exitCode>[0])).toBe(0);
    const due = base + RETENTION + HOUR;
    for (const time of [base, base + RETENTION - 1, due - 1]) {
      at(time);
      const before = state(f);
      const effects = f.observeEffects();
      expect(await f.send("revoke", { id: t.id })).toEqual(first);
      expect(effects()).toEqual(noWrites);
      expect(state(f)).toBe(before);
      expect(only(f).revoked_at).toBe(base);
    }
    at(due);
    await admit(f, (rows) => rows.filter((row) => row.id !== t.id), due);
    await refused(f, "revoke", { id: t.id }, 400, gone, 6);
  },
);

clocked(
  "a revoke made after expiry keeps the row for 7 days from the revoke",
  async (f) => {
    const t = await issued(f);
    at(base + 2 * DAY);
    answers(await f.send("revoke", { id: t.id }), 200);
    for (const time of [base + HOUR + RETENTION, base + 9 * DAY - 1]) {
      at(time);
      await admit(f, (rows) => rows, time);
      expect(tokenRows(f).some((row) => row.id === t.id)).toBe(true);
    }
    at(base + 9 * DAY);
    await admit(
      f,
      (rows) => rows.filter((row) => row.id !== t.id),
      base + 9 * DAY,
    );
    await refused(f, "revoke", { id: t.id }, 400, gone, 6);
  },
);

async function rejected(f: Fixture, t: Issued, error: ForgeError) {
  expect(await commanded(f, t)).toEqual({ status: 401, body: failed(error) });
  expect(exitCode(failed(error))).toBe(1);
}
for (const [label, revoke, before] of [
  ["revoked", true, err("AUTH_REVOKED", "Token was revoked")],
  ["expired", false, err("AUTH_EXPIRED", "Token expired")],
] as const)
  clocked(
    `a ${label} v3 token answers AUTH_INVALID once an issue has deleted its row`,
    async (f) => {
      const t = await issued(f);
      if (revoke) answers(await f.send("revoke", { id: t.id }), 200);
      at(base + 2 * HOUR);
      await rejected(f, t, before);
      const due = base + RETENTION + HOUR;
      at(due);
      await admit(f, (rows) => rows.filter((row) => row.id !== t.id), due);
      await rejected(f, t, err("AUTH_INVALID", "Token is not valid"));
    },
  );

clocked(
  "two devices that issue daily and revoke the last token stay near 28 rows",
  async (f) => {
    const last: Record<string, string> = {};
    for (let day = 0; day < 60; day++) {
      const now = base + day * DAY;
      at(now);
      for (const device of ["laptop", "tablet"]) {
        const reply = await issue(f, { device, ttlMs: 7 * DAY });
        const id = admitted(reply, now, 7 * DAY, { device });
        if (last[device])
          answers(await f.send("revoke", { id: last[device] }), 200);
        last[device] = id;
      }
      expect(tokenRows(f).length).toBeLessThanOrEqual(30);
    }
    expect(tokenRows(f)).toHaveLength(28);
  },
);

clocked(
  "64 tokens issued in a burst and all revoked still block issue for 14 days",
  async (f) => {
    const ids: string[] = [];
    for (let i = 0; i < 64; i++)
      ids.push(admitted(await issue(f, { ttlMs: 7 * DAY }), base, 7 * DAY));
    for (const id of ids) answers(await f.send("revoke", { id }), 200);
    await refused(f, "devices", body, 503, full, 1);
    at(base + 14 * DAY - 1);
    await refused(f, "devices", body, 503, full, 1);
    at(base + 14 * DAY);
    await admit(f, () => [], base + 14 * DAY);
    expect(tokenRows(f)).toHaveLength(1);
  },
);

clocked(
  "64 legacy rows signed for 90 days stay authentic and block issue until day 97",
  async (f) => {
    fill(f, 64, () => ({ expires_at: base + 90 * DAY }));
    const authentic = () =>
      expect(
        tokenRows(f).every((row) =>
          verifyToken(f.seal(), fieldsOf(row), row.mac),
        ),
      ).toBe(true);
    authentic();
    at(base + 97 * DAY - 1);
    authentic();
    await refused(f, "devices", body, 503, full, 1);
    at(base + 97 * DAY);
    authentic();
    await admit(f, () => [], base + 97 * DAY);
    expect(tokenRows(f)).toHaveLength(1);
  },
);

test(
  "v3 issue on an activated stopped root refuses the 65th token",
  () =>
    withActivated(async (target) => {
      at(base);
      fill(target, 64);
      await refused(target, "devices", body, 503, full, 1);
    }),
  timeout,
);

test(
  "v3 issue on an activated stopped root deletes the eligible row and admits",
  () =>
    withActivated(async (target) => {
      at(base);
      fill(target, 64, (i) =>
        i === 0 ? { expires_at: base - RETENTION } : {},
      );
      await admit(target, (rows) => rows.slice(1));
    }),
  timeout,
);

test(
  "a fresh target with a 65 row token table refuses restore page 0 untouched",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    fill(f, 65);
    const page = { page: 0, id: "directory:0", body: "[]", manifest: {} };
    const error = err("RESTORE_TARGET_NOT_EMPTY", unverified);
    await refused(f, "restore", page, 409, error, 1);
    expect(tokenRows(f)).toHaveLength(65);
    expect(tableNames(f)).not.toContain("cloud_v3_root");
  },
  timeout,
);

test(
  "a fresh target refuses a restore manifest that names a token page untouched",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    const member = (id: string, text: string) => ({
      id,
      bytes: Buffer.byteLength(text),
      hash: digestBytes(text),
    });
    const manifest = trustedManifest(f.seal(), {
      format: "forge-cloud-portable/4",
      head: 0,
      eventWatermark: 0,
      recordFloor: 0,
      publicDigest: digestBytes("[]"),
      pages: [
        member("token:0", "[]"),
        member("snapshot:0", ""),
        member("transcript:0", "[]"),
      ],
      source: "fixture",
    });
    const pin = {
      "X-Forge-Manifest-Digest": digestBytes(canonicalJson(manifest)),
    };
    const page = { page: 0, id: "directory:0", body: "[]", manifest };
    const error = err("RESTORE_INVALID_ROW", unverified);
    await refused(f, "restore", page, 400, error, 1, pin);
    expect(tableNames(f).filter((n) => n.startsWith("cloud_v3_"))).toEqual([]);
  },
  timeout,
);

clocked(
  "v3 issue on a restarted object deletes the same eligible row",
  async (f) => {
    fill(f, 64, (i) => (i === 0 ? { expires_at: base - RETENTION } : {}));
    f.restart();
    await admit(f, (rows) => rows.slice(1));
    expect(tokenRows(f)).toHaveLength(64);
  },
);

clocked(
  "v3 issue deletes a retained row by its original MAC after a key rotation",
  async (f) => {
    const first = String(f.env.V3_SEAL_KEY);
    await issued(f);
    Reflect.set(f.env, "V3_SEAL_KEY", newKey());
    Reflect.set(f.env, "V3_SEAL_KEY_PREVIOUS", first);
    const due = base + HOUR + RETENTION;
    at(due);
    await admit(f, () => [], due);
    expect(tokenRows(f)).toHaveLength(1);
  },
);

const deleteThen = (sql: string, prev: string) =>
  /^SELECT changes\(\)/.test(sql) && /^DELETE FROM cloud_v3_tokens/.test(prev);
const insertThen = (sql: string, prev: string) =>
  /^SELECT changes\(\)/.test(sql) && /^INSERT INTO cloud_v3_tokens/.test(prev);
const faults: [string, (sql: string, prev: string) => boolean, number][] = [
  ["after the cleanup DELETE", deleteThen, 1],
  ["before the INSERT", (sql) => /^INSERT INTO cloud_v3_tokens/.test(sql), 2],
  ["after the INSERT", insertThen, 2],
];
for (const [label, trip, attempts] of faults)
  test(
    `v3 issue rolls back whole on a fault ${label}, then admits`,
    async () => {
      let armed = false;
      let mutations = 0;
      let previous = "";
      const f = fixture((sql) => {
        const before = previous;
        previous = sql;
        if (!armed) return;
        if (sqlMutation.test(sql)) mutations++;
        if (trip(sql, before)) throw new Error("fault");
      }, env);
      using _db = f.db;
      await provision(f);
      at(base);
      await issued(f);
      const stale = signed(f, 1, old);
      put(f, [stale]);
      const rows = tokenRows(f);
      const coreBefore = core(f);
      const snapshot = f.snapshot();
      armed = true;
      const reply = await issue(f);
      armed = false;
      const error = err("INTERNAL", "Server error", "safe");
      expect(reply).toEqual({ status: 500, body: { ok: false, error } });
      expect(exitCode(failed(error))).toBe(1);
      expect(mutations).toBe(attempts);
      expect(tokenRows(f)).toEqual(rows);
      expect(core(f)).toBe(coreBefore);
      const after = f.snapshot();
      expect(Buffer.from(after.sql).equals(Buffer.from(snapshot.sql))).toBe(
        true,
      );
      expect(JSON.stringify(after.kv)).toBe(JSON.stringify(snapshot.kv));
      await admit(f, (all) => all.filter((row) => row.id !== stale.id));
    },
    timeout,
  );

const list = (f: Fixture) => tokenInventory(store(f), f.seal());
const quiet = (f: Fixture, run: () => void) => {
  const effects = f.observeEffects();
  run();
  expect(effects()).toEqual(noWrites);
};
const refusedList = (f: Fixture) =>
  quiet(f, () => expect(refusal(() => list(f))).toBe("UNAVAILABLE"));

clocked("tokenInventory returns nothing for an absent table", (f) => {
  quiet(f, () => expect(list(f)).toEqual([]));
  expect(tableNames(f)).not.toContain("cloud_v3_tokens");
});

clocked("tokenInventory returns nothing for an empty table", (f) => {
  f.db.run(REAL);
  quiet(f, () => expect(list(f)).toEqual([]));
});

clocked(
  "tokenInventory returns 64 healthy rows with their stored MACs",
  (f) => {
    fill(f, 64);
    const rows = tokenRows(f);
    quiet(f, () =>
      expect(list(f)).toEqual(
        rows.map((row) => ({ fields: fieldsOf(row), mac: row.mac })),
      ),
    );
  },
);

clocked(
  "tokenInventory returns a previous-key row with its original MAC",
  async (f) => {
    const first = String(f.env.V3_SEAL_KEY);
    await issued(f);
    const [row] = tokenRows(f);
    Reflect.set(f.env, "V3_SEAL_KEY", newKey());
    Reflect.set(f.env, "V3_SEAL_KEY_PREVIOUS", first);
    quiet(f, () =>
      expect(list(f)).toEqual([{ fields: fieldsOf(row!), mac: row!.mac }]),
    );
  },
);

for (const [label, over, damage] of spoiled)
  clocked(`tokenInventory refuses ${label}`, async (f) => {
    await issued(f);
    const x = signed(f, 1, over);
    put(f, [x]);
    edit(f, x.id, damage(x));
    refusedList(f);
  });

for (const [label, over] of junk)
  clocked(`tokenInventory refuses a junk row with ${label}`, async (f) => {
    await issued(f);
    await issued(f, { device: "tablet" });
    put(f, [signed(f, 0, over)]);
    refusedList(f);
  });

clocked("tokenInventory refuses 65 live rows", (f) => {
  fill(f, 65);
  refusedList(f);
});

clocked("tokenInventory refuses 65 rows even when 5 are old", (f) => {
  fill(f, 65, (i) => (i > 0 && i < 6 ? old : {}));
  refusedList(f);
});
