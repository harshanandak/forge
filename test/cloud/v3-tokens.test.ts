import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { afterEach, expect, setSystemTime, test } from "bun:test";
import {
  type ClaimStore,
  CodeRedemption,
  durableRedemption,
} from "../../cloud/src/adapters/workers-oauth/redemption.ts";
import type {
  DeviceBrowserOptions,
  DeviceUpstream,
} from "../../cloud/src/auth/device-browser.ts";
import { Project } from "../../cloud/src/project.ts";
import { testIdentityVerifier } from "../contract/lib/identity-verifier.ts";
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
import {
  canonicalJson,
  digestBytes,
  digestValue,
} from "../../src/core/config/pointer.ts";
import {
  fixture,
  guardFixture,
  newKey,
  noWrites,
  portableOf,
  portableUpload,
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
    const { id, token } = (reply.body as { value: Issued }).value;
    expect(reply).toEqual({
      status: 200,
      body: {
        ok: true,
        value: {
          id,
          token,
          device: "laptop",
          expiresAt: new Date(base + 90 * DAY).toISOString(),
        },
      },
    });
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(token).toMatch(/^fct_[0-9a-f]{16}\.[A-Za-z0-9_-]{43}$/);
    expect(token.startsWith(`fct_${id}.`)).toBe(true);
    expect(exitCode(reply.body as Parameters<typeof exitCode>[0])).toBe(0);
    const input = { device: "laptop", ttlMs: 90 * DAY + 1 };
    const message = err("INPUT_INVALID", "ttlMs is over 90 days");
    await refused(f, "devices", input, 400, message, 6);
    expect(tableNames(f).filter((n) => n.startsWith("cloud_v3_"))).toEqual([]);
  },
  timeout,
);

const revokeReply = (expiresAt: number) => ({
  status: 200,
  body: {
    ok: true,
    value: {
      device: "laptop",
      session: "run-1",
      expiresAt: new Date(expiresAt).toISOString(),
      leasesReleased: false,
    },
  },
});

clocked(
  "a repeat revoke gets its first answer until the row is deleted, then the unknown-id answer",
  async (f) => {
    const t = await issued(f);
    const first = await f.send("revoke", { id: t.id });
    answers(first, 200);
    expect(first).toEqual(revokeReply(base + HOUR));
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
    const reply = await f.send("revoke", { id: t.id });
    answers(reply, 200);
    expect(reply).toEqual(revokeReply(base + HOUR));
    expect(exitCode(reply.body as Parameters<typeof exitCode>[0])).toBe(0);
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
        expect(tokenRows(f).length).toBeLessThanOrEqual(30);
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

clocked("tokenInventory refuses a duplicate id", (f) => {
  f.db.run(
    REAL.replace("id TEXT PRIMARY KEY", "id TEXT").replace(
      " WITHOUT ROWID",
      "",
    ),
  );
  const row = signed(f, 1);
  insertRow(f, { ...row });
  insertRow(f, { ...row });
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

const approvalTable = "cloud_v3_approvals";
const approvalSchema =
  "CREATE TABLE IF NOT EXISTS cloud_v3_approvals (id TEXT PRIMARY KEY, project TEXT NOT NULL, incarnation TEXT NOT NULL, restore_epoch TEXT NOT NULL, activation_digest TEXT NOT NULL, operation TEXT NOT NULL, operation_digest TEXT NOT NULL, token_id TEXT NOT NULL, device TEXT NOT NULL, session TEXT NOT NULL, control_epoch INTEGER NOT NULL, policy_identity TEXT NOT NULL, status TEXT NOT NULL, requested_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, decided_at INTEGER, decider_issuer TEXT, decider_subject TEXT, spent_at INTEGER, mac TEXT NOT NULL) WITHOUT ROWID";
const unconstrainedApprovals = approvalSchema
  .replace(/\b(?:TEXT|INTEGER)(?: NOT NULL| PRIMARY KEY)?/g, "")
  .replace(" WITHOUT ROWID", "");
const approvalLifetime = 600_000;
const approvalId =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const approvalOwner = {
  CLERK_ISSUER: "https://issuer.example",
  FORGE_OWNER_SUBJECT: "fixture-owner",
  CLERK_CLIENT_ID: "fixture-client",
};
const approvalRoot = (f: Base) =>
  JSON.parse(
    f.db.query<{ body: string }, []>("SELECT body FROM cloud_v3_root").get()!
      .body,
  ) as {
    incarnation: string;
    restoreEpoch: string;
    activationDigest?: string;
    generation: number;
  };

function approvalFields(f: Base, t: Issued, id: string) {
  const { incarnation, restoreEpoch, activationDigest } = approvalRoot(f);
  const { device, session } = only(f);
  const { CLERK_ISSUER, FORGE_OWNER_SUBJECT, CLERK_CLIENT_ID } =
    f.env as typeof f.env & Partial<typeof approvalOwner>;
  return {
    id,
    project: "a",
    incarnation,
    restore_epoch: restoreEpoch,
    activation_digest: activationDigest!,
    operation: "restore.promote",
    operation_digest: digestValue(["restore.promote", activationDigest]),
    token_id: t.id,
    device,
    session: session!,
    control_epoch: 1,
    policy_identity: digestValue([
      CLERK_ISSUER,
      FORGE_OWNER_SUBJECT,
      CLERK_CLIENT_ID,
    ]),
    status: "pending",
    requested_at: base,
    expires_at: base + approvalLifetime,
    decided_at: null as number | null,
    decider_issuer: null as string | null,
    decider_subject: null as string | null,
    spent_at: null as number | null,
  };
}

type ApprovalFixtureFields = ReturnType<typeof approvalFields>;
type StoredApprovalFields = Omit<ApprovalFixtureFields, "id"> & {
  id: string | number;
};
type ApprovalFixtureRow = StoredApprovalFields & { mac: string };

function approvalMac(
  f: Base,
  row: StoredApprovalFields,
  key = f.env.V3_SEAL_KEY,
) {
  const bytes = Buffer.from(String(key), "base64url");
  const signed = canonicalJson([
    "forge/v3/approval/1",
    f.context.id!.toString(),
    row.id,
    row.project,
    row.incarnation,
    row.restore_epoch,
    row.activation_digest,
    row.operation,
    row.operation_digest,
    row.token_id,
    row.device,
    row.session,
    row.control_epoch,
    row.policy_identity,
    row.status,
    row.requested_at,
    row.expires_at,
    row.decided_at,
    row.decider_issuer,
    row.decider_subject,
    row.spent_at,
  ]);
  const tag = createHmac("sha256", bytes).update(signed).digest("hex");
  return `${sha(bytes).slice(0, 16)}.${tag}`;
}

function signedApproval(
  f: Base,
  t: Issued,
  patch: Partial<ApprovalFixtureFields> = {},
) {
  const row = { ...approvalFields(f, t, crypto.randomUUID()), ...patch };
  return { ...row, mac: approvalMac(f, row) };
}

const expiredApproval = {
  requested_at: base - approvalLifetime,
  expires_at: base,
};
const approvedFixture = {
  status: "approved",
  decided_at: base,
  decider_issuer: approvalOwner.CLERK_ISSUER,
  decider_subject: approvalOwner.FORGE_OWNER_SUBJECT,
};
const deniedFixture = { ...approvedFixture, status: "denied" };

const approvalRows = (f: Base) =>
  tableNames(f).includes(approvalTable)
    ? f.db
        .query<ApprovalFixtureRow, []>(
          "SELECT * FROM cloud_v3_approvals ORDER BY id",
        )
        .all()
    : undefined;

function plantApprovals(
  f: Base,
  rows: ApprovalFixtureRow[],
  schema = approvalSchema,
) {
  f.db.run(schema);
  for (const row of rows) {
    const values = Object.values(row);
    f.db.run(
      `INSERT INTO cloud_v3_approvals (${Object.keys(row).join(", ")}) VALUES (${values.map(() => "?").join(", ")})`,
      values,
    );
  }
  expect(approvalRows(f)).toEqual(
    rows.toSorted((a, b) => String(a.id).localeCompare(String(b.id))),
  );
}

const editApproval = (f: Base, id: string, patch: Over) =>
  f.db.run(
    `UPDATE cloud_v3_approvals SET ${Object.keys(patch)
      .map((column) => `${column}=?`)
      .join(", ")} WHERE id=?`,
    [...Object.values(patch), id] as never,
  );

function approvalCase(
  name: string,
  run: (f: Fixture, t: Issued, p: Portable) => Promise<void>,
) {
  test(
    name,
    async () => {
      at(base);
      await withActivated(async (f, p) => {
        const t = await issued(f);
        expect(check(f, t)).toMatchObject({
          id: t.id,
          device: body.device,
          session: body.session,
        });
        await run(f, t, p);
      });
    },
    timeout,
  );
}

async function askApproval(
  f: Fixture,
  t?: Issued,
  input: string | ReadableStream<Uint8Array> = "{}",
  project = "a",
  headers: Record<string, string> = {},
): Promise<Answer> {
  const request = new Request(
    `https://fixture.example/p/${project}/promote/approval`,
    {
      method: "POST",
      headers: { ...(t && { authorization: `Bearer ${t.token}` }), ...headers },
      body: input,
      duplex: "half",
    },
  );
  const reply = await f.fetch(request);
  return { status: reply.status, body: await reply.json() };
}

function approvalRefusal(
  reply: Answer,
  status: number,
  code: string,
  exit: number,
  message?: string,
) {
  expect(reply.status).toBe(status);
  const envelope = reply.body as { ok: false; error: ForgeError };
  expect(envelope).toMatchObject({
    ok: false,
    error: { code, ...(message === undefined ? {} : { message }) },
  });
  expect(exitCode(failed(envelope.error))).toBe(exit);
}

async function approvalDeclined(
  f: Fixture,
  send: () => Promise<Answer>,
  status: number,
  code: string,
  exit = 1,
  message?: string,
) {
  const rows = approvalRows(f);
  const effects = f.observeEffects();
  approvalRefusal(await send(), status, code, exit, message);
  expect(approvalRows(f)).toEqual(rows);
  expect(effects()).toEqual(noWrites);
}

const approvalUnavailable = (f: Fixture, t: Issued) =>
  approvalDeclined(
    f,
    () => askApproval(f, t),
    503,
    "UNAVAILABLE",
    1,
    "Cloud v3 approval storage is unavailable",
  );

async function requestedApproval(
  f: Fixture,
  t: Issued,
  retained = approvalRows(f) ?? [],
  input = "{}",
) {
  const authority = core(f);
  const tokens = tokenRows(f);
  const reply = await askApproval(f, t, input);
  expect(reply.status).toBe(200);
  const envelope = reply.body as {
    ok: true;
    value: { approval: string; expiresAt: number; url: string };
  };
  const { approval } = envelope.value;
  expect(approval).toMatch(approvalId);
  expect(envelope).toEqual({
    ok: true,
    value: {
      approval,
      expiresAt: base + approvalLifetime,
      url: `/promote-approval?id=${approval}`,
    },
  });
  expect(exitCode(reply.body as Parameters<typeof exitCode>[0])).toBe(0);
  const rows = approvalRows(f)!;
  const fields = approvalFields(f, t, approval);
  const expected = { ...fields, mac: approvalMac(f, fields) };
  const fresh = rows.filter(({ id }) => id === approval);
  expect(fresh).toEqual([expected]);
  expect(rows.filter(({ id }) => id !== approval)).toEqual(retained);
  expect(core(f)).toBe(authority);
  expect(tokenRows(f)).toEqual(tokens);
  return fresh[0]!;
}

approvalCase(
  "CONTROL R1 issues a signed pending promotion approval",
  async (f, t) => {
    Object.assign(f.env, approvalOwner);
    expect(approvalRows(f)).toBeUndefined();
    await requestedApproval(f, t);
  },
);

approvalCase(
  "CONTROL R1b a retry makes a new pending approval and preserves the first",
  async (f, t) => {
    const first = await requestedApproval(f, t);
    const next = await requestedApproval(f, t, [first]);
    expect(next.id).not.toBe(first.id);
  },
);

clocked("RED R2 a promotion approval needs an activated root", async (f) => {
  const t = await issued(f);
  expect(check(f, t)).toMatchObject({ id: t.id });
  const root = approvalRoot(f);
  expect(root.generation).toBe(0);
  expect(root.activationDigest).toBeUndefined();
  expect(approvalRows(f)).toBeUndefined();
  await approvalDeclined(
    f,
    () => askApproval(f, t),
    409,
    "INPUT_CONFLICT",
    4,
    "The restored project is not awaiting promotion",
  );
});

approvalCase(
  "RED R3 eight live approvals refuse another with zero writes",
  async (f, t) => {
    plantApprovals(
      f,
      Array.from({ length: 8 }, () => signedApproval(f, t)),
    );
    await approvalDeclined(
      f,
      () => askApproval(f, t),
      409,
      "INPUT_CONFLICT",
      4,
      "Too many open promotion requests",
    );
  },
);

approvalCase("RED R4 a missing bearer is required", async (f) => {
  await approvalDeclined(f, () => askApproval(f), 401, "AUTH_REQUIRED");
});

approvalCase("RED R5 a malformed bearer is forbidden", async (f, t) => {
  await approvalDeclined(
    f,
    () => askApproval(f, { ...t, token: "malformed" }),
    403,
    "AUTH_FORBIDDEN",
  );
});

const oversizedApprovalBody = "{}".padEnd(8193);

approvalCase(
  "RED R6 a promotion approval body is bounded to 8192 bytes",
  async (f, t) => {
    await approvalDeclined(
      f,
      () => askApproval(f, t, oversizedApprovalBody),
      400,
      "INPUT_INVALID",
      6,
    );
  },
);

for (const [label, input] of [
  ["a nonempty object", '{"x":1}'],
  ["an array", "[]"],
  ["null", "null"],
  ["a scalar", "1"],
  ["invalid JSON", "{"],
])
  approvalCase(
    `RED R7 rejects ${label} as a promotion approval body`,
    async (f, t) => {
      await approvalDeclined(
        f,
        () => askApproval(f, t, input),
        400,
        "INPUT_INVALID",
        6,
      );
    },
  );

approvalCase(
  "CONTROL R7 a whitespace-padded empty object is accepted",
  async (f, t) => {
    await requestedApproval(f, t, [], " \n { } \t ");
  },
);

async function approvalRevokedDuringRead(f: Fixture, t: Issued, tail: string) {
  const before = approvalRows(f);
  const authority = core(f);
  let revoked: Answer | undefined;
  let effects: ReturnType<Fixture["observeEffects"]> | undefined;
  const encode = new TextEncoder();
  const input = new ReadableStream<Uint8Array>(
    {
      start: (controller) => controller.enqueue(encode.encode("{")),
      async pull(controller) {
        revoked = await f.send("revoke", { id: t.id });
        effects = f.observeEffects();
        controller.enqueue(encode.encode(tail));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const reply = await askApproval(f, t, input);
  if (revoked) answers(revoked, 200);
  approvalRefusal(reply, 401, "AUTH_REVOKED", 1);
  expect(only(f).revoked_at).toBe(base);
  expect(effects?.()).toEqual(noWrites);
  expect(approvalRows(f)).toEqual(before);
  expect(core(f)).toBe(authority);
}

approvalCase(
  "RED R8 revocation during the body read is observed",
  async (f, t) => {
    await approvalRevokedDuringRead(f, t, "}");
  },
);

const flipHex = (text: string) => (text[0] === "0" ? "1" : "0") + text.slice(1);

approvalCase(
  "RED R9 corrupt token storage refuses the request",
  async (f, t) => {
    const [key, tag] = only(f).mac.split(".");
    const corrupt = `${key}.${flipHex(tag!)}`;
    tamper(f, "mac", corrupt);
    expect(only(f).mac).toBe(corrupt);
    await approvalDeclined(
      f,
      () => askApproval(f, t),
      503,
      "UNAVAILABLE",
      1,
      "Cloud v3 token storage is unavailable",
    );
  },
);

const rejectedApprovalProjects: [string, string, Record<string, string>][] = [
  ["another project", "b", {}],
  ["the owner header", "a", { "X-Forge-Owner": "owner" }],
  ["the owner expiry header", "a", { "X-Forge-Owner-Expires": String(base) }],
];

for (const [label, project, headers] of rejectedApprovalProjects)
  approvalCase(
    `RED R10 ${label} is refused before bearer and body checks`,
    async (f) => {
      await approvalDeclined(
        f,
        () =>
          askApproval(f, undefined, oversizedApprovalBody, project, headers),
        403,
        "AUTH_FORBIDDEN",
      );
    },
  );

function wrongApprovalBearer(t: Issued): Issued {
  const [prefix, secret] = t.token.split(".");
  const wrong = (secret![0] === "A" ? "B" : "A") + secret!.slice(1);
  return { ...t, token: `${prefix}.${wrong}` };
}

const firstApprovalRefusals = [
  ["an absent token", 401, "AUTH_INVALID"],
  ["a wrong secret", 401, "AUTH_INVALID"],
  ["a revoked token", 401, "AUTH_REVOKED"],
  ["an expired token", 401, "AUTH_EXPIRED"],
  ["a malformed token row", 503, "UNAVAILABLE"],
] as const;

for (const [label, status, code] of firstApprovalRefusals)
  approvalCase(
    `CONTROL R11 ${label} is refused before the oversized body`,
    async (f, t) => {
      if (label === "an absent token") {
        drop(f, t.id);
        expect(tokenRows(f)).toEqual([]);
      } else if (label === "a revoked token") {
        answers(await f.send("revoke", { id: t.id }), 200);
        expect(only(f).revoked_at).toBe(base);
      } else if (label === "an expired token") {
        const row = { ...only(f), expires_at: base };
        edit(f, t.id, { expires_at: row.expires_at, mac: macOf(f, row) });
        expect(only(f).expires_at).toBe(base);
      } else if (label === "a malformed token row") {
        tamper(f, "mac", "bad");
        expect(only(f).mac).toBe("bad");
      }
      const presented = label === "a wrong secret" ? wrongApprovalBearer(t) : t;
      await approvalDeclined(
        f,
        () => askApproval(f, presented, oversizedApprovalBody),
        status,
        code,
      );
    },
  );

approvalCase(
  "RED R12 the second token check precedes the nonempty body refusal",
  async (f, t) => {
    await approvalRevokedDuringRead(f, t, '"x":1}');
  },
);

approvalCase(
  "CONTROL R13 absent Clerk settings use a null policy identity tuple",
  async (f, t) => {
    for (const key of Object.keys(approvalOwner))
      expect(Object.hasOwn(f.env, key)).toBe(false);
    const retained = signedApproval(f, t);
    plantApprovals(f, [retained]);
    const pending = await requestedApproval(f, t, [retained]);
    expect(pending.policy_identity).toBe(digestValue([null, null, null]));
  },
);

for (const [label, expired] of [
  ["I1 eight live rows and one expired row exceed the physical bound", true],
  ["I2 nine live rows exceed the physical bound", false],
] as const)
  approvalCase(`RED ${label}`, async (f, t) => {
    const rows = Array.from({ length: 9 }, (_, i) =>
      signedApproval(f, t, expired && i === 8 ? expiredApproval : {}),
    );
    plantApprovals(f, rows);
    await approvalUnavailable(f, t);
  });

for (const [label, id] of [
  ["a nontext id", 7],
  ["an invalid UUID", "z".repeat(36)],
] as const)
  approvalCase(
    `RED I2b rejects ${label} in a recreated table`,
    async (f, t) => {
      const row = { ...approvalFields(f, t, crypto.randomUUID()), id };
      plantApprovals(
        f,
        [{ ...row, mac: approvalMac(f, row) }],
        unconstrainedApprovals,
      );
      await approvalUnavailable(f, t);
    },
  );

approvalCase(
  "RED I2c rejects duplicate signed ids in a recreated table",
  async (f, t) => {
    const row = signedApproval(f, t);
    plantApprovals(f, [row, row], unconstrainedApprovals);
    await approvalUnavailable(f, t);
  },
);

approvalCase(
  "RED I3 an edited expiry cannot authorize cleanup",
  async (f, t) => {
    const row = signedApproval(f, t);
    plantApprovals(f, [row]);
    await requestedApproval(f, t, [row]);
    editApproval(f, row.id, expiredApproval);
    expect(approvalRows(f)).toContainEqual({ ...row, ...expiredApproval });
    await approvalUnavailable(f, t);
  },
);

approvalCase(
  "CONTROL I4 removes three authentic expired rows and keeps two live rows",
  async (f, t) => {
    const expired = Array.from({ length: 3 }, () =>
      signedApproval(f, t, expiredApproval),
    );
    const live = Array.from({ length: 2 }, () => signedApproval(f, t));
    plantApprovals(f, [...expired, ...live]);
    await requestedApproval(
      f,
      t,
      approvalRows(f)!.filter((row) => row.expires_at > base),
    );
  },
);

type ApprovalEdit = Over | ((row: ApprovalFixtureFields) => Over);
const damagedApprovals: [
  string,
  Partial<ApprovalFixtureFields>,
  ApprovalEdit?,
][] = [
  ["pending edited to approved with an old MAC", {}, { status: "approved" }],
  [
    "an edited token id with an old MAC",
    {},
    (row) => ({ token_id: flipHex(row.token_id) }),
  ],
  [
    "denied edited to approved with an old MAC",
    deniedFixture,
    { status: "approved" },
  ],
  ["a signed unknown status", { status: "unknown" }],
  [
    "signed approved with no decision time",
    { ...approvedFixture, decided_at: null },
  ],
  ["signed pending with a decision time", { decided_at: base + 1 }],
  [
    "signed spent before the decision",
    {
      ...approvedFixture,
      status: "spent",
      decided_at: base + 1,
      spent_at: base,
    },
  ],
  [
    "signed spent before the request",
    {
      ...approvedFixture,
      status: "spent",
      decided_at: base - 2,
      spent_at: base - 1,
    },
  ],
  ["a signed inconsistent expiry", { expires_at: base + approvalLifetime + 1 }],
  [
    "a signed wrong operation digest",
    { operation_digest: digestValue(["unrelated"]) },
  ],
  ["an edited UUID with an old MAC", {}, (row) => ({ id: flipHex(row.id) })],
  ["a text expiry", {}, { expires_at: "not-a-time" }],
  ["an 80-byte MAC", {}, { mac: "0".repeat(80) }],
];

for (const [label, fields, edited] of damagedApprovals)
  approvalCase(`RED I5 rejects ${label}`, async (f, t) => {
    const row = signedApproval(f, t, fields);
    plantApprovals(f, [row]);
    if (edited) {
      const patch = typeof edited === "function" ? edited(row) : edited;
      editApproval(f, row.id, patch);
      expect(approvalRows(f)).toEqual([{ ...row, ...patch }]);
      expect(approvalRows(f)![0]).not.toEqual(row);
    }
    await approvalUnavailable(f, t);
  });

approvalCase(
  "CONTROL I6 authenticates all four stored approval states",
  async (f, t) => {
    plantApprovals(
      f,
      [
        {},
        approvedFixture,
        deniedFixture,
        { ...approvedFixture, status: "spent", spent_at: base },
      ].map((fields) => signedApproval(f, t, fields)),
    );
    await requestedApproval(f, t);
    expect(approvalRows(f)).toHaveLength(5);
  },
);

approvalCase(
  "RED I7 refuses an approval signed for another object with the same key",
  async (f, t) => {
    const other = guardFixture(env, { key: String(f.env.V3_SEAL_KEY) });
    using _db = other.db;
    expect(other.context.id!.toString()).not.toBe(f.context.id!.toString());
    const row = signedApproval(f, t);
    plantApprovals(f, [{ ...row, mac: approvalMac(other, row) }]);
    await approvalUnavailable(f, t);
  },
);

approvalCase(
  "RED I8 refuses an approval signed by a removed key",
  async (f, t) => {
    const row = signedApproval(f, t);
    Reflect.set(f.env, "V3_SEAL_KEY_PREVIOUS", newKey());
    const removed = newKey();
    const ring = f.seal().keys.map(({ id }) => id);
    expect(ring).toHaveLength(2);
    expect(ring).not.toContain(
      sha(Buffer.from(removed, "base64url")).slice(0, 16),
    );
    plantApprovals(f, [{ ...row, mac: approvalMac(f, row, removed) }]);
    await approvalUnavailable(f, t);
  },
);

approvalCase(
  "CONTROL I9 retains an approval signed by the previous key",
  async (f, t) => {
    const oldKey = String(f.env.V3_SEAL_KEY);
    const row = signedApproval(f, t);
    plantApprovals(f, [row]);
    Reflect.set(f.env, "V3_SEAL_KEY", newKey());
    Reflect.set(f.env, "V3_SEAL_KEY_PREVIOUS", oldKey);
    expect(f.seal().keys.map(({ id }) => id)).toHaveLength(2);
    await requestedApproval(f, t, [row]);
  },
);

approvalCase("RED I10 preserves an inventory quota failure", async (f, t) => {
  plantApprovals(f, [signedApproval(f, t, expiredApproval)]);
  const executeSql = f.storage.sql.exec.bind(f.storage.sql);
  let armed = true;
  f.storage.sql.exec = (statement, ...bindings) => {
    if (armed && statement.includes(`FROM ${approvalTable} ORDER BY`)) {
      armed = false;
      throw Error("Exceeded allowed rows read in Durable Objects free tier.");
    }
    return executeSql(statement, ...bindings);
  };
  const before = approvalRows(f);
  const effects = f.observeEffects();
  const reply = await askApproval(f, t);
  expect(armed).toBe(false);
  approvalRefusal(reply, 503, "QUOTA_EXHAUSTED", 1);
  expect(reply.body).toMatchObject({ error: { retry: "safe" } });
  expect(approvalRows(f)).toEqual(before);
  expect(effects()).toEqual(noWrites);
});

for (const [label, table] of [
  ["P1", approvalTable],
  ["P2", "cloud_v3_approval_browser"],
] as const)
  for (const route of ["restore", "provision"] as const)
    test(
      `RED ${label} orphan ${table} blocks ${route}`,
      async () => {
        at(base);
        const f = guardFixture(env);
        using _db = f.db;
        f.db.run(
          `CREATE TABLE ${table} (id TEXT PRIMARY KEY, body TEXT NOT NULL)`,
        );
        f.db.run(`INSERT INTO ${table} VALUES (?, ?)`, [
          "orphan",
          "preserve these bytes",
        ]);
        const orphan = () => f.db.query(`SELECT * FROM ${table}`).all();
        const before = orphan();
        expect(tableNames(f)).toEqual([table]);
        let send = () => f.send(probe, {});
        let status = 503;
        let code = "UNAVAILABLE";
        if (route === "restore") {
          const source = guardFixture(env);
          using _source = source.db;
          await provision(source);
          answers(
            await source.send(`${probe}/commits`, { frames: [note] }),
            200,
          );
          answers(await source.send(`${probe}/checkpoint`, {}), 200);
          const portable = portableOf(source);
          const control = guardFixture(env);
          using _control = control.db;
          expect(await portableUpload(control, portable)(0)).toEqual({
            status: 200,
            body: { ok: true, value: { page: 0, verified: false } },
          });
          const upload = portableUpload(f, portable);
          send = () => upload(0);
          status = 409;
          code = "RESTORE_TARGET_NOT_EMPTY";
        }
        const effects = f.observeEffects();
        approvalRefusal(await send(), status, code, 1);
        expect(orphan()).toEqual(before);
        expect(tableNames(f)).toEqual([table]);
        expect(effects()).toEqual(noWrites);
      },
      timeout,
    );

async function preservesApprovalRetry(f: Fixture, p: Portable) {
  const before = approvalRows(f);
  const authority = core(f);
  const effects = f.observeEffects();
  const reply = await p.upload(2);
  expect(reply).toEqual({
    status: 200,
    body: { ok: true, value: { page: 2, verified: true } },
  });
  expect(exitCode(reply.body as Parameters<typeof exitCode>[0])).toBe(0);
  expect(approvalRows(f)).toEqual(before);
  expect(core(f)).toBe(authority);
  expect(effects()).toEqual(noWrites);
}

approvalCase(
  "CONTROL X1 exact restore retry preserves a requested pending approval",
  async (f, t, p) => {
    await requestedApproval(f, t);
    await preservesApprovalRetry(f, p);
  },
);

approvalCase(
  "RED X2 exact restore retry preserves pending and terminal authority",
  async (f, t, p) => {
    plantApprovals(
      f,
      [{}, approvedFixture, deniedFixture].map((fields) =>
        signedApproval(f, t, fields),
      ),
    );
    await preservesApprovalRetry(f, p);
  },
);

const promoteOrigin = "https://fixture.example";
const promotePage = "/promote-approval";
const promoteCookie = "__Host-forge_promote";
const promoteState = "forge-promote.";
const promoteProvider = "https://issuer.example/provider";
const promoteEnv = {
  ...approvalOwner,
  CLERK_REDIRECT_URI: promoteOrigin + "/callback",
};
const browserTable = "cloud_v3_approval_browser";
const randomBrowserValue = () => randomBytes(32).toString("base64url");
const emptyState = () => promoteState + randomBrowserValue();
const cookiePair = (name: string, value: string) => `${name}=${value}`;
const browserCookieName = (state: string) =>
  `${promoteCookie}_${sha(state).slice(0, 24)}`;
const authInvalid = [401, "AUTH_INVALID"] as const;
const inputInvalid = [400, "INPUT_INVALID"] as const;
const inputConflict = [409, "INPUT_CONFLICT"] as const;
const needsApproval = [409, "APPROVAL_REQUIRED"] as const;
const unavailableApproval = [503, "UNAVAILABLE"] as const;
const browserStorageMessage = "Cloud v3 approval storage is unavailable";
const bindingMessage = "Lane control or authorization binding changed";

type BrowserAction = "approve" | "deny";
interface BrowserTicket {
  action: BrowserAction;
  approvalId: string;
  cookieHash: string;
  expiresAt: number;
  issuedAt: number;
  nonce: string;
  payloadDigest: string;
  project: string;
}
interface BrowserRow {
  state_hash: string;
  bind_hash: string;
  project: string;
  approval_id: string;
  payload_digest: string;
  action: BrowserAction;
  nonce: string;
  verifier: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  mac: string;
}
type BrowserReply =
  [status: number, code: string] | readonly [status: number, code: string];
type Claim = {
  hash: string;
  until: number;
  outcome: "won" | "refused" | "threw";
};

function proofMac(
  f: Base,
  parts: readonly unknown[],
  key = f.env.V3_SEAL_KEY,
  scope = String(f.context.id),
) {
  const bytes = Buffer.from(String(key), "base64url");
  const [domain, ...fields] = parts;
  return `${sha(bytes).slice(0, 16)}.${createHmac("sha256", bytes)
    .update(canonicalJson([domain, scope, ...fields]))
    .digest("hex")}`;
}

const approvalDigest = (f: Base, row: ApprovalFixtureRow) =>
  digestValue([
    "forge/v3/approval/1",
    String(f.context.id),
    row.id,
    row.project,
    row.incarnation,
    row.restore_epoch,
    row.activation_digest,
    row.operation,
    row.operation_digest,
    row.token_id,
    row.device,
    row.session,
    row.control_epoch,
    row.policy_identity,
    row.status,
    row.requested_at,
    row.expires_at,
    row.decided_at,
    row.decider_issuer,
    row.decider_subject,
    row.spent_at,
  ]);

function ticketProof(
  f: Base,
  row: BrowserTicket,
  key?: string,
  scope?: string,
) {
  return proofMac(
    f,
    [
      "forge/v3/approval-ticket/1",
      row.project,
      row.approvalId,
      row.payloadDigest,
      row.action,
      row.cookieHash,
      row.nonce,
      row.issuedAt,
      row.expiresAt,
    ],
    key,
    scope,
  );
}

function browserProof(
  f: Base,
  row: Omit<BrowserRow, "mac">,
  key?: string,
  scope?: string,
) {
  return proofMac(
    f,
    [
      "forge/v3/approval-browser/1",
      row.state_hash,
      row.bind_hash,
      row.project,
      row.approval_id,
      row.payload_digest,
      row.action,
      row.nonce,
      row.verifier,
      row.created_at,
      row.expires_at,
      row.used_at,
    ],
    key,
    scope,
  );
}

const packTicket = (fields: object, mac: string) =>
  `${Buffer.from(canonicalJson(fields)).toString("base64url")}.${mac}`;
const ticketFields = (ticket: string) =>
  JSON.parse(
    Buffer.from(ticket.split(".")[0]!, "base64url").toString(),
  ) as BrowserTicket;
const committedKey = (f: Base, row: BrowserRow) =>
  sha(
    canonicalJson([
      "forge/v3/approval-decision/1",
      String(f.context.id),
      row.project,
      row.approval_id,
      row.payload_digest,
    ]),
  );
const upstreamKey = (row: BrowserRow) =>
  sha(`promote-upstream:${row.verifier}`);

function browserTicket(
  f: Base,
  approval: ApprovalFixtureRow,
  cookie: string,
  action: BrowserAction = "approve",
  patch: Partial<BrowserTicket> = {},
) {
  const row: BrowserTicket = {
    action,
    approvalId: String(approval.id),
    cookieHash: sha(cookie),
    expiresAt: approval.expires_at,
    issuedAt: Date.now(),
    nonce: randomBrowserValue(),
    payloadDigest: approvalDigest(f, approval),
    project: approval.project,
    ...patch,
  };
  return packTicket(row, ticketProof(f, row));
}

const browserRows = (f: Base) =>
  tableNames(f).includes(browserTable)
    ? f.db
        .query<BrowserRow, []>(
          `SELECT * FROM ${browserTable} ORDER BY state_hash`,
        )
        .all()
    : undefined;

function testBrowserRow(
  f: Base,
  row: BrowserRow,
  patch: Partial<BrowserRow> = {},
) {
  const next = {
    ...row,
    state_hash: sha(randomBrowserValue()),
    nonce: randomBrowserValue(),
    verifier: randomBrowserValue(),
    ...patch,
  };
  return { ...next, mac: browserProof(f, next) };
}

function addBrowserRows(f: Base, rows: BrowserRow[]) {
  for (const row of rows) {
    const fields = Object.keys(row);
    f.db.run(
      `INSERT INTO ${browserTable} (${fields.join(", ")}) VALUES (${fields.map(() => "?").join(", ")})`,
      Object.values(row),
    );
  }
}

function editBrowser(f: Base, row: BrowserRow, patch: Partial<BrowserRow>) {
  f.db.run(
    `UPDATE ${browserTable} SET ${Object.keys(patch)
      .map((field) => `${field}=?`)
      .join(", ")} WHERE state_hash=?`,
    [...Object.values(patch), row.state_hash],
  );
}

function duplicateBrowser(f: Base, row: BrowserRow) {
  expect(browserRows(f)).toContainEqual(row);
  f.db.run(`DROP TABLE ${browserTable}`);
  f.db.run(`CREATE TABLE ${browserTable} (${Object.keys(row).join(", ")})`);
  addBrowserRows(f, [row, row]);
  expect(browserRows(f)).toEqual([row, row]);
}

function duplicateApproval(f: Base, row: ApprovalFixtureRow) {
  expect(approvalRows(f)).toContainEqual(row);
  f.db.run(`DROP TABLE ${approvalTable}`);
  plantApprovals(f, [row, row], unconstrainedApprovals);
}

function rotateBrowserSeal(f: Base) {
  Object.assign(f.env, {
    V3_SEAL_KEY_PREVIOUS: f.env.V3_SEAL_KEY,
    V3_SEAL_KEY: newKey(),
  });
}

function browserRequest(
  path: string,
  input?: URLSearchParams | string,
  jar?: string,
  origin: string | null = promoteOrigin,
) {
  return new Request(promoteOrigin + path, {
    method: input === undefined ? "GET" : "POST",
    headers: {
      ...(jar === undefined ? {} : { Cookie: jar }),
      ...(origin === null ? {} : { Origin: origin }),
    },
    ...(input === undefined ? {} : { body: input }),
  });
}

const previewRequest = (id: string | number, cookie: string) =>
  browserRequest(
    promotePage,
    new URLSearchParams({ csrf: cookie, id: String(id) }),
    cookiePair(promoteCookie, cookie),
  );
const browserForm = (
  ticket: string,
  csrf: string,
  action: BrowserAction = "approve",
) =>
  new URLSearchParams({
    ticket,
    csrf,
    ...(action === "approve" ? { confirm: "yes" } : {}),
  });
const decisionRequest = (
  ticket: string,
  cookie: string,
  action: BrowserAction = "approve",
) =>
  browserRequest(
    `${promotePage}/${action}`,
    browserForm(ticket, cookie, action),
    cookiePair(promoteCookie, cookie),
  );
const callbackRequest = (state: string, jar?: string) =>
  browserRequest(`/callback?${new URLSearchParams({ state })}`, undefined, jar);
const identityClaims = () => ({
  issuer: approvalOwner.CLERK_ISSUER,
  subject: approvalOwner.FORGE_OWNER_SUBJECT,
  audience: approvalOwner.CLERK_CLIENT_ID,
  expiresAt: base + HOUR,
  authenticatedAt: base,
});

function browserPorts() {
  const begins: [string, string][] = [];
  const verifies: [string, number, string][] = [];
  const claims: Claim[] = [];
  const held = new Set<string>();
  const behavior = {
    begin: () => Promise.resolve(promoteProvider),
    verify: (): ReturnType<DeviceUpstream["verify"]> => {
      const identity = identityClaims();
      return testIdentityVerifier(new Map([["proof", identity]])).verify(
        "proof",
        identity.audience,
        base,
      );
    },
    claim: (hash: string, _until: number): Promise<boolean> => {
      if (held.has(hash)) return Promise.resolve(false);
      held.add(hash);
      return Promise.resolve(true);
    },
  };
  const upstream: DeviceUpstream = {
    begin(state, verifier) {
      begins.push([state, verifier]);
      return behavior.begin();
    },
    verify(request, now, verifier) {
      verifies.push([request.url, now, verifier]);
      return behavior.verify();
    },
  };
  const redemption: NonNullable<DeviceBrowserOptions["redemption"]> = {
    async claimOnce(hash, until) {
      const call: Claim = { hash, until, outcome: "threw" };
      claims.push(call);
      const won = await behavior.claim(hash, until);
      call.outcome = won ? "won" : "refused";
      return won;
    },
  };
  return {
    begins,
    verifies,
    claims,
    held,
    behavior,
    upstream,
    redemption,
    decisionClaims: (f: Base, row: BrowserRow) =>
      claims.filter(({ hash }) => hash === committedKey(f, row)),
  };
}

function browserProject(f: Base, ports: DeviceBrowserOptions, selected = true) {
  return new Project({ ...f.context, testV3: selected }, f.env, ports);
}

const browserEnv = (f: Base) => Object.assign(f.env, promoteEnv);

function browserCase(
  name: string,
  run: (
    f: Fixture,
    t: Issued,
    p: Portable,
    ports: ReturnType<typeof browserPorts>,
    client: Project,
  ) => Promise<void>,
) {
  approvalCase(name, async (f, t, p) => {
    browserEnv(f);
    const ports = browserPorts();
    await run(f, t, p, ports, browserProject(f, ports));
  });
}

async function browserRefusal(
  response: Response,
  [status, code]: BrowserReply,
  message?: string,
) {
  expect(response.status).toBe(status);
  const payload = await response.json();
  expect(payload).toMatchObject({
    ok: false,
    error: { code, ...(message === undefined ? {} : { message }) },
  });
  expect(response.headers.get("Location")).toBeNull();
  return (payload as { error: ForgeError }).error;
}

async function beforeBrowserWrite(
  f: Fixture,
  send: () => Promise<Response>,
  result: BrowserReply,
  message?: string,
) {
  const approvals = approvalRows(f);
  const browsers = browserRows(f);
  const effects = f.observeEffects();
  const error = await browserRefusal(await send(), result, message);
  expect(approvalRows(f)).toEqual(approvals);
  expect(browserRows(f)).toEqual(browsers);
  expect(effects()).toEqual(noWrites);
  return error;
}

function expectConsumed(
  f: Base,
  row: BrowserRow,
  now: number,
  before: BrowserRow[],
) {
  const used = { ...row, used_at: now };
  expect(browserRows(f)).toEqual(
    before.map((candidate) =>
      candidate.state_hash === row.state_hash
        ? { ...used, mac: browserProof(f, used) }
        : candidate,
    ),
  );
}

function expectDecided(
  f: Base,
  approval: ApprovalFixtureRow,
  action: BrowserAction,
  now = Date.now(),
  owner = approvalOwner.FORGE_OWNER_SUBJECT,
) {
  const expected = {
    ...approval,
    status: action === "approve" ? "approved" : "denied",
    decided_at: now,
    decider_issuer: approvalOwner.CLERK_ISSUER,
    decider_subject: owner,
  };
  expect(approvalRows(f)!.filter(({ id }) => id === approval.id)).toEqual([
    { ...expected, mac: approvalMac(f, expected) },
  ]);
}

async function browserChoice(
  client: Project,
  f: Base,
  h: ApprovalFixtureRow,
  action: BrowserAction = "approve",
  ticket?: string,
  cookie = randomBrowserValue(),
) {
  const chosen = ticket ?? browserTicket(f, h, cookie, action);
  const response = await client.fetch(decisionRequest(chosen, cookie, action));
  expect(response.status).toBe(302);
  expect(response.headers.get("Location")).toBe(promoteProvider);
  const setCookie = response.headers.get("Set-Cookie") ?? "";
  const jar = setCookie.split(";")[0]!;
  const row = browserRows(f)?.find(
    ({ nonce }) => nonce === ticketFields(chosen).nonce,
  );
  expect(row).toBeDefined();
  return { row: row!, jar, setCookie, ticket: chosen, cookie };
}

type BrowserChoice = Awaited<ReturnType<typeof browserChoice>>;
const callbackFor = (
  ports: ReturnType<typeof browserPorts>,
  choice: BrowserChoice,
) => {
  const state = ports.begins.find(
    ([state]) => sha(state) === choice.row.state_hash,
  )?.[0];
  expect(state).toBeDefined();
  return callbackRequest(state!, choice.jar);
};
const browserState = (
  ports: ReturnType<typeof browserPorts>,
  choice: BrowserChoice,
) => new URL(callbackFor(ports, choice).url).searchParams.get("state")!;

function claimCalls(
  f: Base,
  row: BrowserRow,
  first: Claim["outcome"] = "won",
  second?: Claim["outcome"],
) {
  const calls: Claim[] = [
    { hash: upstreamKey(row), until: row.expires_at, outcome: first },
  ];
  if (second)
    calls.push({
      hash: committedKey(f, row),
      until: row.expires_at,
      outcome: second,
    });
  return calls;
}

async function successfulCallback(
  client: Project,
  f: Base,
  ports: ReturnType<typeof browserPorts>,
  h: ApprovalFixtureRow,
  choice: BrowserChoice,
  action: BrowserAction = "approve",
) {
  const response = await client.fetch(callbackFor(ports, choice));
  expect(response.status).toBe(200);
  expect(response.headers.get("Location")).toBeNull();
  expect(await response.text()).toContain(
    action === "approve" ? "approved" : "denied",
  );
  expectDecided(f, h, action);
}

function deferredBrowser<T>() {
  const { promise, resolve } = Promise.withResolvers<T>();
  return { promise, resolve };
}

function pauseBrowser<T>(resume: () => Promise<T>) {
  const reached = deferredBrowser<void>();
  const released = deferredBrowser<void>();
  return {
    reached: reached.promise,
    release: () => released.resolve(),
    awaitPort: async () => {
      reached.resolve();
      await released.promise;
      return await resume();
    },
  };
}

async function requirePause(
  pause: { reached: Promise<void> },
  reply: Promise<Response>,
) {
  expect(
    await Promise.race([
      pause.reached.then(() => "port reached"),
      reply.then(() => "reply arrived"),
    ]),
  ).toBe("port reached");
}

function interceptSql(
  f: Base,
  match: RegExp,
  fault: Error | ForgeFailure,
  after = false,
) {
  const original = f.storage.sql.exec;
  f.storage.sql.exec = (statement, ...params) => {
    if (!match.test(statement)) return original(statement, ...params);
    if (after) original(statement, ...params);
    throw fault;
  };
  return () => {
    f.storage.sql.exec = original;
  };
}

const browserRoutes = ["page", "preview", "decision", "callback"] as const;
type BrowserRoute = (typeof browserRoutes)[number];

function routeRequest(
  f: Base,
  route: BrowserRoute,
  h?: ApprovalFixtureRow,
  malformed = false,
  state = emptyState(),
) {
  const cookie = randomBrowserValue();
  const id = String(h?.id ?? crypto.randomUUID());
  if (route === "page") return browserRequest(`${promotePage}?id=${id}`);
  const form = new URLSearchParams({
    csrf: malformed ? "bad-csrf" : cookie,
    id,
  });
  const jar = cookiePair(promoteCookie, cookie);
  if (route === "preview") return browserRequest(promotePage, form, jar);
  if (route === "decision") {
    const ticket = h
      ? browserTicket(f, h, cookie)
      : browserTicket(
          f,
          {
            ...approvalFields(
              f,
              {
                id: "0123456789abcdef",
                token: "",
                parts: { id: "", hash: "" },
              },
              id,
            ),
            id,
            mac: "",
          },
          cookie,
        );
    form.set("ticket", ticket);
    form.set("confirm", "yes");
    return browserRequest(promotePage + "/approve", form, jar);
  }
  const query = new URLSearchParams({
    state: malformed ? emptyState() : state,
  });
  if (malformed) query.append("state", state);
  return browserRequest(`/callback?${query}`);
}

browserCase(
  "CONTROL G0 promotion test selection off (five requests)",
  async (f, t, _p, ports) => {
    const h = await requestedApproval(f, t);
    const client = browserProject(f, ports, false);
    const cookie = randomBrowserValue();
    for (const request of [
      ...browserRoutes.map((route) => routeRequest(f, route, h)),
      decisionRequest(browserTicket(f, h, cookie, "deny"), cookie, "deny"),
    ])
      await beforeBrowserWrite(f, () => client.fetch(request), [
        404,
        "UNKNOWN_COMMAND",
      ]);
    expect(ports.begins).toEqual([]);
    expect(ports.verifies).toEqual([]);
    expect(ports.claims).toEqual([]);
  },
);

async function readPromotionPage(client: Project, id: string, jar?: string) {
  const response = await client.fetch(
    browserRequest(`${promotePage}?id=${id}`, undefined, jar),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("Location")).toBeNull();
  const cookie = response.headers.get("Set-Cookie");
  return { cookie, html: await response.text(), headers: response.headers };
}

browserCase(
  "CONTROL G1 promotion page sets and keeps a browser cookie without writes",
  async (f, t, _p, _ports, client) => {
    const h = await requestedApproval(f, t);
    const effects = f.observeEffects();
    const { cookie, html, headers } = await readPromotionPage(
      client,
      String(h.id),
    );
    expect(cookie).toMatch(
      /^__Host-forge_promote=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=900$/,
    );
    const jar = cookie!.split(";")[0]!;
    const csrf = jar.slice(promoteCookie.length + 1);
    expect(html).toContain('action="/promote-approval"');
    expect(html).toContain(`name="csrf" value="${csrf}"`);
    expect(html).toContain(`name="id" value="${h.id}"`);
    expect(html).toContain("Continue");
    expect(headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(headers.get("Cache-Control")).toBe("no-store");
    expect(headers.get("X-Frame-Options")).toBe("DENY");
    expect(headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    );
    expect(headers.get("Referrer-Policy")).toBe("same-origin");
    const kept = await readPromotionPage(client, String(h.id), jar);
    expect(kept.cookie).toBeNull();
    expect(kept.html).toContain(`name="csrf" value="${csrf}"`);
    const invalid = await readPromotionPage(client, "not-an-id", jar);
    expect(invalid.html).toContain('name="id" value=""');
    expect(tableNames(f).some((name) => name.startsWith("domain_cloud_"))).toBe(
      false,
    );
    expect(effects()).toEqual(noWrites);
  },
);

for (const route of browserRoutes) {
  for (const configured of [true, false]) {
    v3test(
      `RED G2 ordinary root refuses ${route} with configuration ${configured ? "present" : "absent"}`,
      async (f) => {
        await issued(f);
        expect(approvalRoot(f).generation).toBe(0);
        expect(approvalRoot(f).activationDigest).toBeUndefined();
        if (configured) browserEnv(f);
        const ports = browserPorts();
        const client = browserProject(f, ports);
        await beforeBrowserWrite(
          f,
          () => client.fetch(routeRequest(f, route)),
          inputConflict,
          "The restored project is not awaiting promotion",
        );
        expect(ports.begins).toEqual([]);
        expect(ports.verifies).toEqual([]);
        expect(ports.claims).toEqual([]);
      },
    );
  }
  browserCase(
    `RED G3 invalid root MAC refuses ${route}`,
    async (f, t, _p, ports, client) => {
      const h = await requestedApproval(f, t);
      expect(approvalRoot(f).activationDigest).toBeDefined();
      f.db.run("UPDATE cloud_v3_root SET seal=?", ["0".repeat(81)]);
      await beforeBrowserWrite(
        f,
        () => client.fetch(routeRequest(f, route, h)),
        unavailableApproval,
      );
      expect(ports.begins).toEqual([]);
      expect(ports.verifies).toEqual([]);
      expect(ports.claims).toEqual([]);
    },
  );
}

const configurationGaps = [
  ...(
    ["CLERK_ISSUER", "FORGE_OWNER_SUBJECT", "CLERK_CLIENT_ID"] as const
  ).flatMap((setting) => [
    { setting, value: undefined },
    { setting, value: "" },
  ]),
  ...[
    "https://outside.example/callback",
    "//fixture.example/callback",
    promoteOrigin + "/callback?extra=1",
  ].map((value) => ({ setting: "CLERK_REDIRECT_URI", value })),
  { setting: "upstream port", value: undefined },
  { setting: "redemption port", value: undefined },
];

for (const { setting, value } of configurationGaps) {
  for (const route of browserRoutes) {
    browserCase(
      `RED G4 ${setting} ${JSON.stringify(value) ?? "absent"} before ${route} input checks`,
      async (f, t, _p, ports, client) => {
        const h = await requestedApproval(f, t);
        const choice = await browserChoice(client, f, h);
        expect(choice.row.used_at).toBeNull();
        const brokenPorts =
          setting === "upstream port"
            ? { redemption: ports.redemption }
            : setting === "redemption port"
              ? { upstream: ports.upstream }
              : ports;
        if (!setting.endsWith(" port")) {
          if (value === undefined) Reflect.deleteProperty(f.env, setting);
          else Object.assign(f.env, { [setting]: value });
        }
        const broken = browserProject(f, brokenPorts);
        await beforeBrowserWrite(
          f,
          () =>
            broken.fetch(
              routeRequest(f, route, h, true, browserState(ports, choice)),
            ),
          [503, "AUTH_CONFIG_UNAVAILABLE"],
        );
        expect(ports.begins).toHaveLength(1);
        expect(ports.verifies).toEqual([]);
        expect(ports.claims).toEqual([]);
      },
    );
  }
}

async function browserPreview(
  client: Project,
  h: ApprovalFixtureRow,
  cookie: string,
) {
  const response = await client.fetch(previewRequest(h.id, cookie));
  expect(response.status).toBe(200);
  expect(response.headers.get("Location")).toBeNull();
  const html = await response.text();
  const tickets = [...html.matchAll(/name="ticket" value="([^"]+)"/g)].map(
    (match) => match[1]!,
  );
  expect(tickets).toHaveLength(2);
  return { html, approve: tickets[0]!, deny: tickets[1]! };
}

browserCase(
  "CONTROL V1 preview displays the pending binding and signs two distinct tickets",
  async (f, t, _p, _ports, client) => {
    const h = await requestedApproval(f, t);
    const page = await readPromotionPage(client, String(h.id));
    const cookie = page.cookie!.split(";")[0]!.slice(promoteCookie.length + 1);
    const effects = f.observeEffects();
    const preview = await browserPreview(client, h, cookie);
    for (const value of [
      h.project,
      h.operation,
      h.activation_digest.slice(7, 19),
      h.device,
      h.session,
      new Date(h.expires_at).toISOString(),
    ])
      expect(preview.html).toContain(`<dd>${value}</dd>`);
    expect(preview.html).toContain('action="/promote-approval/approve"');
    expect(preview.html).toContain('action="/promote-approval/deny"');
    expect(preview.html).toContain(
      'type="checkbox" name="confirm" value="yes" required',
    );
    for (const action of ["approve", "deny"] as const) {
      const actual = preview[action];
      const fields = ticketFields(actual);
      expect(fields).toEqual({
        action,
        approvalId: h.id,
        cookieHash: sha(cookie),
        expiresAt: h.expires_at,
        issuedAt: base,
        nonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        payloadDigest: approvalDigest(f, h),
        project: h.project,
      });
      expect(actual).toBe(packTicket(fields, ticketProof(f, fields)));
      expect(Buffer.byteLength(actual)).toBeLessThanOrEqual(1024);
    }
    expect(ticketFields(preview.approve).nonce).not.toBe(
      ticketFields(preview.deny).nonce,
    );
    expect(effects()).toEqual(noWrites);
  },
);

for (const variant of [
  "missing Origin",
  "wrong Origin",
  "missing cookie",
  "missing csrf",
  "wrong csrf",
]) {
  browserCase(
    `RED V2 ${variant} before preview id validation`,
    async (f, t, _p, _ports, client) => {
      await requestedApproval(f, t);
      const csrf = randomBrowserValue();
      const form = new URLSearchParams({ id: "not-an-id", csrf });
      if (variant === "missing csrf") form.delete("csrf");
      if (variant === "wrong csrf") form.set("csrf", randomBrowserValue());
      const origin =
        variant === "missing Origin"
          ? null
          : variant === "wrong Origin"
            ? "https://outside.example"
            : promoteOrigin;
      const jar =
        variant === "missing cookie"
          ? undefined
          : cookiePair(promoteCookie, csrf);
      await beforeBrowserWrite(
        f,
        () => client.fetch(browserRequest(promotePage, form, jar, origin)),
        authInvalid,
      );
    },
  );
}

for (const variant of ["invalid", "uppercase", "duplicate"]) {
  browserCase(
    `RED V3 preview refuses a ${variant} id`,
    async (f, t, _p, _ports, client) => {
      const h = await requestedApproval(f, t);
      const id =
        variant === "invalid"
          ? "invalid"
          : variant === "uppercase"
            ? "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"
            : String(h.id);
      const csrf = randomBrowserValue();
      const form = new URLSearchParams({ csrf, id });
      if (variant === "duplicate") form.append("id", String(h.id));
      await beforeBrowserWrite(
        f,
        () =>
          client.fetch(
            browserRequest(promotePage, form, cookiePair(promoteCookie, csrf)),
          ),
        inputInvalid,
      );
    },
  );
}

for (const table of [true, false]) {
  browserCase(
    `RED V4 preview absent approval with ${table ? "existing" : "absent"} table`,
    async (f, t, _p, _ports, client) => {
      if (table) await requestedApproval(f, t);
      expect(approvalRows(f) !== undefined).toBe(table);
      await beforeBrowserWrite(
        f,
        () =>
          client.fetch(
            previewRequest(crypto.randomUUID(), randomBrowserValue()),
          ),
        needsApproval,
      );
    },
  );
}

type ApprovalEdit = (
  f: Fixture,
  h: ApprovalFixtureRow,
  t: Issued,
) => Promise<void> | void;

const replaceApproval = (
  f: Base,
  h: ApprovalFixtureRow,
  patch: Partial<ApprovalFixtureRow>,
  key?: string,
) => {
  const next = { ...h, ...patch };
  editApproval(f, String(h.id), { ...next, mac: approvalMac(f, next, key) });
};

const swapApproval = (
  f: Base,
  h: ApprovalFixtureRow,
  x: ApprovalFixtureRow,
) => {
  const { id: _id, ...other } = x;
  editApproval(f, String(h.id), other);
};
const otherApprovalKey = (f: Base, h: ApprovalFixtureRow) =>
  replaceApproval(f, h, {}, newKey());
const otherApprovalScope = (f: Base, h: ApprovalFixtureRow) => {
  const other = guardFixture(env, { key: String(f.env.V3_SEAL_KEY) });
  using _db = other.db;
  editApproval(f, String(h.id), { mac: approvalMac(other, h) });
};
const changeOwner = (f: Base) => {
  Object.assign(f.env, { FORGE_OWNER_SUBJECT: "another-owner" });
};
const alternateActivation = () => {
  const digest = digestValue(["another-activation"]);
  return {
    activation_digest: digest,
    operation_digest: digestValue(["restore.promote", digest]),
  };
};

const previewTamper: [string, ApprovalEdit][] = [
  [
    "status with old MAC",
    (f, h) => {
      editApproval(f, String(h.id), approvedFixture);
    },
  ],
  [
    "token id",
    (f, h) => {
      editApproval(f, String(h.id), { token_id: "0".repeat(16) });
    },
  ],
  [
    "swapped approval",
    async (f, h, t) => swapApproval(f, h, await requestedApproval(f, t)),
  ],
  ["removed key (B10)", otherApprovalKey],
  ["cross-object MAC", otherApprovalScope],
  [
    "edited expiry",
    (f, h) => {
      editApproval(f, String(h.id), { expires_at: h.expires_at - 1 });
    },
  ],
];
for (const [variant, edit] of previewTamper) {
  browserCase(
    `RED V5 preview refuses ${variant}`,
    async (f, t, _p, _ports, client) => {
      const h = await requestedApproval(f, t);
      await edit(f, h, t);
      await beforeBrowserWrite(
        f,
        () => client.fetch(previewRequest(h.id, randomBrowserValue())),
        unavailableApproval,
        browserStorageMessage,
      );
    },
  );
}

const terminalApprovals = [
  approvedFixture,
  deniedFixture,
  { ...approvedFixture, status: "spent", spent_at: base },
];
for (const variant of [...terminalApprovals, { status: "expired" }]) {
  browserCase(
    `RED V6 preview refuses ${variant.status}`,
    async (f, t, _p, _ports, client) => {
      const h = await requestedApproval(f, t);
      if (variant.status === "expired") at(h.expires_at);
      else replaceApproval(f, h, variant);
      await beforeBrowserWrite(
        f,
        () => client.fetch(previewRequest(h.id, randomBrowserValue())),
        needsApproval,
      );
    },
  );
}

const previewBindingEdits: [string, ApprovalEdit][] = [
  [
    "different activation and epoch",
    (f, h) =>
      replaceApproval(f, h, {
        ...alternateActivation(),
        restore_epoch: "other-epoch",
      }),
  ],
  ["different project", (f, h) => replaceApproval(f, h, { project: "b" })],
  ["different owner policy", changeOwner],
];

for (const [variant, edit] of previewBindingEdits) {
  browserCase(
    `RED V7 preview refuses ${variant}`,
    async (f, t, _p, _ports, client) => {
      const h = await requestedApproval(f, t);
      await edit(f, h, t);
      await beforeBrowserWrite(
        f,
        () => client.fetch(previewRequest(h.id, randomBrowserValue())),
        inputConflict,
        bindingMessage,
      );
    },
  );
}

browserCase(
  "RED V8 preview refuses a policy configured after the request",
  async (f, t, _p, _ports, client) => {
    for (const setting of Object.keys(approvalOwner))
      Reflect.deleteProperty(f.env, setting);
    const h = await requestedApproval(f, t);
    expect(h.policy_identity).toBe(digestValue([null, null, null]));
    browserEnv(f);
    await beforeBrowserWrite(
      f,
      () => client.fetch(previewRequest(h.id, randomBrowserValue())),
      inputConflict,
      bindingMessage,
    );
  },
);

browserCase(
  "CONTROL B10 previous approval key still previews and decides",
  async (f, t, _p, ports, client) => {
    const h = await requestedApproval(f, t);
    rotateBrowserSeal(f);
    const cookie = randomBrowserValue();
    const { approve } = await browserPreview(client, h, cookie);
    const choice = await browserChoice(
      client,
      f,
      h,
      "approve",
      approve,
      cookie,
    );
    await successfulCallback(client, f, ports, h, choice);
  },
);

for (const action of ["approve", "deny"] as const) {
  browserCase(
    `CONTROL ${action === "approve" ? "H1" : "H2"} honest ${action} consumes and decides an exact pending payload`,
    async (f, t, _p, ports, client) => {
      const h = await requestedApproval(f, t);
      const x = await requestedApproval(f, t);
      const authority = core(f);
      const tokens = tokenRows(f);
      const page = await readPromotionPage(client, String(h.id));
      const cookie = page
        .cookie!.split(";")[0]!
        .slice(promoteCookie.length + 1);
      const tickets = await browserPreview(client, h, cookie);
      const choice = await browserChoice(
        client,
        f,
        h,
        action,
        tickets[action],
        cookie,
      );
      const request = callbackFor(ports, choice);
      const state = new URL(request.url).searchParams.get("state")!;
      expect(state).toMatch(/^forge-promote\.[A-Za-z0-9_-]{43}$/);
      const bind = choice.jar.split("=")[1]!;
      expect(bind).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(choice.setCookie).toBe(
        `${browserCookieName(state)}=${bind}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
      );
      const stored = choice.row;
      expect(stored).toEqual({
        state_hash: sha(state),
        bind_hash: sha(bind),
        project: h.project,
        approval_id: h.id,
        payload_digest: approvalDigest(f, h),
        action,
        nonce: ticketFields(tickets[action]).nonce,
        verifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        created_at: base,
        expires_at: h.expires_at,
        used_at: null,
        mac: browserProof(f, stored),
      });
      expect(browserRows(f)).toEqual([stored]);
      expect(ports.begins).toEqual([[state, stored.verifier]]);
      at(base + 11);
      await successfulCallback(client, f, ports, h, choice, action);
      expectConsumed(f, stored, base + 11, [stored]);
      expect(approvalRows(f)).toContainEqual(x);
      expect(core(f)).toBe(authority);
      expect(tokenRows(f)).toEqual(tokens);
      expect(
        tableNames(f).some((name) => name.startsWith("domain_cloud_")),
      ).toBe(false);
      expect(ports.verifies).toEqual([
        [request.url, base + 11, stored.verifier],
      ]);
      expect(ports.claims).toEqual(claimCalls(f, stored, "won", "won"));
    },
  );
}

for (const target of [
  "https://outside.example/return",
  "//outside.example/return",
  "https%3A%2F%2Foutside.example%2Freturn",
]) {
  browserCase(
    `CONTROL browser routes ignore caller return fields ${target}`,
    async (f, t, _p, ports, client) => {
      const h = await requestedApproval(f, t);
      const fields = Object.fromEntries(
        ["redirect", "redirect_uri", "next", "return_to"].map((key) => [
          key,
          target,
        ]),
      );
      const page = await client.fetch(
        browserRequest(
          `${promotePage}?${new URLSearchParams({ id: String(h.id), ...fields })}`,
        ),
      );
      expect(page.status).toBe(200);
      expect(page.headers.get("Location")).toBeNull();
      const jar = page.headers.get("Set-Cookie")!.split(";")[0]!;
      const csrf = jar.slice(promoteCookie.length + 1);
      const preview = await client.fetch(
        browserRequest(
          `${promotePage}?${new URLSearchParams(fields)}`,
          new URLSearchParams({ id: String(h.id), csrf, ...fields }),
          jar,
        ),
      );
      expect(preview.status).toBe(200);
      expect(preview.headers.get("Location")).toBeNull();
      const [ticket] = [
        ...(await preview.text()).matchAll(/name="ticket" value="([^"]+)"/g),
      ];
      const selected = await client.fetch(
        browserRequest(
          `${promotePage}/approve?${new URLSearchParams(fields)}`,
          new URLSearchParams({
            csrf,
            ticket: ticket![1]!,
            confirm: "yes",
            ...fields,
          }),
          jar,
        ),
      );
      expect(selected.status).toBe(302);
      expect(selected.headers.get("Location")).toBe(promoteProvider);
      expect(approvalRows(f)).toEqual([h]);
      const [state, verifier] = ports.begins[0]!;
      const [stored] = browserRows(f)!;
      expect(ports.begins).toEqual([[state, stored!.verifier]]);
      expect(state).toMatch(/^forge-promote\.[A-Za-z0-9_-]{43}$/);
      expect(stored!.state_hash).toBe(sha(state));
      expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const bind = selected.headers.get("Set-Cookie")!.split(";")[0]!;
      const callback = await client.fetch(
        browserRequest(
          `/callback?${new URLSearchParams({ state, ...fields })}`,
          undefined,
          bind,
        ),
      );
      expect(callback.status).toBe(200);
      expect(callback.headers.get("Location")).toBeNull();
      expect(await callback.text()).toContain("approved");
      expectConsumed(f, stored!, base, [stored!]);
      expectDecided(f, h, "approve");
    },
  );
}

for (const tamper of [false, true]) {
  browserCase(
    `${tamper ? "RED" : "CONTROL"} S1 ${tamper ? "approval swapped before decision POST" : "unchanged approval decides only H"}`,
    async (f, t, _p, ports, client) => {
      const h = await requestedApproval(f, t);
      const x = await requestedApproval(f, t);
      const cookie = randomBrowserValue();
      const { approve } = await browserPreview(client, h, cookie);
      if (tamper) {
        swapApproval(f, h, x);
        await beforeBrowserWrite(
          f,
          () => client.fetch(decisionRequest(approve, cookie)),
          unavailableApproval,
          browserStorageMessage,
        );
        expect(browserRows(f)).toBeUndefined();
      } else {
        const choice = await browserChoice(
          client,
          f,
          h,
          "approve",
          approve,
          cookie,
        );
        await successfulCallback(client, f, ports, h, choice);
      }
      expect(approvalRows(f)).toContainEqual(x);
    },
  );
}

for (const variant of [
  "missing Origin",
  "wrong Origin",
  "missing cookie",
  "wrong csrf",
  "missing confirm",
  "wrong confirm",
]) {
  browserCase(
    `RED Q1 decision POST refuses ${variant}`,
    async (f, t, _p, ports, client) => {
      const h = await requestedApproval(f, t);
      const cookie = randomBrowserValue();
      const form = browserForm(browserTicket(f, h, cookie), cookie);
      if (variant === "wrong csrf") form.set("csrf", randomBrowserValue());
      if (variant === "missing confirm") form.delete("confirm");
      if (variant === "wrong confirm") form.set("confirm", "no");
      const jar =
        variant === "missing cookie"
          ? undefined
          : cookiePair(promoteCookie, cookie);
      const origin =
        variant === "missing Origin"
          ? null
          : variant === "wrong Origin"
            ? "https://outside.example"
            : promoteOrigin;
      await beforeBrowserWrite(
        f,
        () =>
          client.fetch(
            browserRequest(promotePage + "/approve", form, jar, origin),
          ),
        authInvalid,
      );
      expect(ports.begins).toEqual([]);
    },
  );
}

browserCase(
  "RED Q2 decision POST refuses 2049 bytes before reading the ticket",
  async (f, t, _p, ports, client) => {
    const h = await requestedApproval(f, t);
    const cookie = randomBrowserValue();
    const form =
      browserForm(browserTicket(f, h, cookie), cookie).toString() + "&pad=";
    const oversized = form.padEnd(2049, "x");
    expect(Buffer.byteLength(oversized)).toBe(2049);
    await beforeBrowserWrite(
      f,
      () =>
        client.fetch(
          browserRequest(
            promotePage + "/approve",
            oversized,
            cookiePair(promoteCookie, cookie),
          ),
        ),
      inputInvalid,
    );
    expect(ports.begins).toEqual([]);
  },
);

const ticketEdits: [
  keyof BrowserTicket,
  (h: ApprovalFixtureRow, x: ApprovalFixtureRow) => string | number,
][] = [
  ["approvalId", (_h, x) => String(x.id)],
  ["action", () => "deny"],
  ["payloadDigest", () => digestValue(["other-payload"])],
  ["nonce", randomBrowserValue],
  ["cookieHash", () => sha(randomBrowserValue())],
  ["project", () => "other"],
  ["expiresAt", (h) => h.expires_at - 1],
  ["issuedAt", () => base + 1],
];
for (const [field, value] of ticketEdits) {
  browserCase(
    `RED S4 edited ticket ${field} fails before approval lookup`,
    async (f, t, _p, ports, client) => {
      const h = await requestedApproval(f, t);
      const x = await requestedApproval(f, t);
      const cookie = randomBrowserValue();
      const valid = browserTicket(f, h, cookie);
      const [, key, mac] = valid.split(".");
      const edited = packTicket(
        { ...ticketFields(valid), [field]: value(h, x) },
        `${key}.${mac}`,
      );
      f.db.run(`DELETE FROM ${approvalTable} WHERE id=?`, [h.id]);
      await beforeBrowserWrite(
        f,
        () => client.fetch(decisionRequest(edited, cookie)),
        authInvalid,
      );
      expect(ports.begins).toEqual([]);
    },
  );
}

for (const variant of [
  "extra key",
  "missing key",
  "not base64url",
  "over 1024 bytes",
  "duplicate ticket",
  "removed key",
]) {
  browserCase(
    `RED Q3 ticket refuses ${variant}`,
    async (f, t, _p, ports, client) => {
      const h = await requestedApproval(f, t);
      const cookie = randomBrowserValue();
      const ticket = browserTicket(f, h, cookie);
      const fields = ticketFields(ticket);
      const [, key, tag] = ticket.split(".");
      const mac = `${key}.${tag}`;
      const form = browserForm(ticket, cookie);
      if (variant === "extra key")
        form.set("ticket", packTicket({ ...fields, extra: true }, mac));
      if (variant === "missing key") {
        const { issuedAt: _issuedAt, ...short } = fields;
        form.set("ticket", packTicket(short, mac));
      }
      if (variant === "not base64url") form.set("ticket", `!.${mac}`);
      if (variant === "over 1024 bytes") {
        const wide = { ...fields, project: "a".repeat(600) };
        const long = packTicket(wide, ticketProof(f, wide));
        expect(Buffer.byteLength(long)).toBeGreaterThan(1024);
        expect(Buffer.byteLength(long)).toBeLessThan(1800);
        form.set("ticket", long);
      }
      if (variant === "duplicate ticket") form.append("ticket", ticket);
      if (variant === "removed key")
        form.set(
          "ticket",
          packTicket(fields, ticketProof(f, fields, newKey())),
        );
      await beforeBrowserWrite(
        f,
        () =>
          client.fetch(
            browserRequest(
              promotePage + "/approve",
              form,
              cookiePair(promoteCookie, cookie),
            ),
          ),
        authInvalid,
      );
      expect(ports.begins).toEqual([]);
    },
  );
}

browserCase(
  "CONTROL Q3b previous seal key still validates a preview ticket",
  async (f, t, _p, _ports, client) => {
    const h = await requestedApproval(f, t);
    const cookie = randomBrowserValue();
    const preview = await browserPreview(client, h, cookie);
    rotateBrowserSeal(f);
    const choice = await browserChoice(
      client,
      f,
      h,
      "approve",
      preview.approve,
      cookie,
    );
    expect(choice.row.mac).toBe(browserProof(f, choice.row));
    expect(approvalRows(f)).toEqual([h]);
  },
);

for (const action of ["approve", "deny"] as const) {
  browserCase(
    `RED Q4 decision ${action} ticket refused at the other action`,
    async (f, t, _p, _ports, client) => {
      const h = await requestedApproval(f, t);
      const cookie = randomBrowserValue();
      const ticket = browserTicket(f, h, cookie, action);
      await beforeBrowserWrite(
        f,
        () =>
          client.fetch(
            decisionRequest(
              ticket,
              cookie,
              action === "approve" ? "deny" : "approve",
            ),
          ),
        authInvalid,
      );
    },
  );
}

for (const variant of [
  "another browser",
  "another object",
  "at expiry",
] as const) {
  browserCase(
    `RED ${{ "another browser": "B1", "another object": "B3", "at expiry": "Q5" }[variant]} decision ticket ${variant}`,
    async (f, t, _p, _ports, client) => {
      const h = await requestedApproval(f, t);
      const cookie = randomBrowserValue();
      const ticket = browserTicket(f, h, cookie);
      if (variant === "at expiry") at(h.expires_at);
      const fields = ticketFields(ticket);
      const proof =
        variant === "another object"
          ? packTicket(
              fields,
              ticketProof(f, fields, undefined, sha("other object scope")),
            )
          : ticket;
      const pageCookie =
        variant === "another browser" ? randomBrowserValue() : cookie;
      await beforeBrowserWrite(
        f,
        () => client.fetch(decisionRequest(proof, pageCookie)),
        authInvalid,
      );
    },
  );
}

const postApprovalEdits: [string, ApprovalEdit, BrowserReply, string?][] = [
  [
    "missing row",
    (f, h) => {
      f.db.run(`DELETE FROM ${approvalTable} WHERE id=?`, [h.id]);
    },
    needsApproval,
  ],
  [
    "edited status",
    (f, h) => {
      editApproval(f, String(h.id), approvedFixture);
    },
    unavailableApproval,
    browserStorageMessage,
  ],
  ...terminalApprovals.map((state): [string, ApprovalEdit, BrowserReply] => [
    state.status,
    (f, h) => replaceApproval(f, h, state),
    needsApproval,
  ]),
  [
    "expired row",
    (f, h) => replaceApproval(f, h, expiredApproval),
    needsApproval,
  ],
  [
    "different pending payload",
    (f, h) =>
      replaceApproval(f, h, {
        requested_at: h.requested_at + 1,
        expires_at: h.expires_at + 1,
      }),
    inputConflict,
    bindingMessage,
  ],
  ["changed owner policy", changeOwner, inputConflict, bindingMessage],
  [
    "removed approval key (B10)",
    otherApprovalKey,
    unavailableApproval,
    browserStorageMessage,
  ],
  [
    "cross-object approval MAC",
    otherApprovalScope,
    unavailableApproval,
    browserStorageMessage,
  ],
];
for (const [variant, edit, result, message] of postApprovalEdits) {
  browserCase(
    `RED Q6 decision POST refuses ${variant}`,
    async (f, t, _p, ports, client) => {
      const h = await requestedApproval(f, t);
      const cookie = randomBrowserValue();
      await edit(f, h, t);
      const ticket = browserTicket(
        f,
        h,
        cookie,
        "approve",
        variant === "expired row"
          ? { payloadDigest: approvalDigest(f, { ...h, ...expiredApproval }) }
          : {},
      );
      await beforeBrowserWrite(
        f,
        () => client.fetch(decisionRequest(ticket, cookie)),
        result,
        message,
      );
      expect(ports.begins).toEqual([]);
    },
  );
}

for (const route of ["preview", "decision", "callback"] as const) {
  browserCase(
    `RED duplicate selected approval at ${route} rejects two coherent signed rows`,
    async (f, t, _p, ports, client) => {
      const h = await requestedApproval(f, t);
      if (route !== "callback") {
        duplicateApproval(f, h);
        await beforeBrowserWrite(
          f,
          () => client.fetch(routeRequest(f, route, h)),
          unavailableApproval,
          browserStorageMessage,
        );
        return;
      }
      const choice = await browserChoice(client, f, h);
      const before = browserRows(f)!;
      const pause = pauseBrowser(ports.behavior.verify);
      ports.behavior.verify = pause.awaitPort;
      const pending = client.fetch(callbackFor(ports, choice));
      try {
        await requirePause(pause, pending);
        expectConsumed(f, choice.row, base, before);
        duplicateApproval(f, h);
      } finally {
        pause.release();
      }
      await browserRefusal(
        await pending,
        unavailableApproval,
        browserStorageMessage,
      );
      expect(approvalRows(f)).toEqual([h, h]);
      expectConsumed(f, choice.row, base, before);
      expect(ports.claims).toEqual(claimCalls(f, choice.row, "won", "won"));
    },
  );
}

for (const phase of [
  "unused pending",
  "consumed pending",
  "terminal",
  "at full cap",
] as const) {
  browserCase(
    `RED ${phase === "terminal" ? "B6b" : phase === "at full cap" ? "Q7" : "B6"} repeated ticket ${phase}`,
    async (f, t, _p, ports, client) => {
      const h = await requestedApproval(f, t);
      const choice = await browserChoice(client, f, h);
      const before = browserRows(f)!;
      if (phase === "consumed pending") {
        ports.behavior.verify = () =>
          Promise.resolve({ ok: false, reason: "unavailable" });
        await browserRefusal(
          await client.fetch(callbackFor(ports, choice)),
          unavailableApproval,
        );
        expectConsumed(f, choice.row, base, before);
        expect(approvalRows(f)).toEqual([h]);
      }
      if (phase === "terminal")
        await successfulCallback(client, f, ports, h, choice);
      if (phase === "at full cap") {
        await browserChoice(client, f, h);
        await browserChoice(client, f, h);
        expect(browserRows(f)).toHaveLength(3);
      }
      const beginCalls = [...ports.begins];
      await beforeBrowserWrite(
        f,
        () => client.fetch(decisionRequest(choice.ticket, choice.cookie)),
        phase === "terminal" ? needsApproval : authInvalid,
      );
      expect(ports.begins).toEqual(beginCalls);
    },
  );
}

function expiredContext(
  f: Base,
  row: BrowserRow,
  approvalId: string | number = row.approval_id,
) {
  return testBrowserRow(f, row, {
    approval_id: String(approvalId),
    created_at: base - approvalLifetime,
    expires_at: base,
    used_at: null,
  });
}

for (const [label, live, expired, refusal] of [
  ["Q8 per-approval live cap", 3, 1, inputConflict],
  ["Q9 overall live cap", 24, 0, inputConflict],
  ["Q10 over physical bound with an expired row", 24, 1, unavailableApproval],
  ["Q11 over physical bound with live rows", 25, 0, unavailableApproval],
] as const) {
  browserCase(
    `RED ${label} preserves every browser row`,
    async (f, t, _p, ports, client) => {
      const h = await requestedApproval(f, t);
      const x = await requestedApproval(f, t);
      const seed = await browserChoice(client, f, h);
      if (expired) replaceApproval(f, x, expiredApproval);
      addBrowserRows(f, [
        ...Array.from({ length: live - 1 }, (_, index) =>
          testBrowserRow(f, seed.row, {
            approval_id:
              live === 3 || index === 0 ? String(h.id) : crypto.randomUUID(),
          }),
        ),
        ...Array.from({ length: expired }, () =>
          expiredContext(f, seed.row, x.id),
        ),
      ]);
      expect(browserRows(f)).toHaveLength(live + expired);
      const cookie = randomBrowserValue();
      await beforeBrowserWrite(
        f,
        () =>
          client.fetch(decisionRequest(browserTicket(f, h, cookie), cookie)),
        refusal,
      );
      expect(ports.begins).toHaveLength(1);
    },
  );
}

browserCase(
  "RED Q12 authenticate coherent shifted expiry before cleanup",
  async (f, t, _p, _ports, client) => {
    const h = await requestedApproval(f, t);
    const original = await browserChoice(client, f, h);
    await browserChoice(client, f, h);
    expect(browserRows(f)).toContainEqual(original.row);
    await withActivated(async (other) => {
      browserEnv(other);
      const ports = browserPorts();
      const otherClient = browserProject(other, ports);
      const otherToken = await issued(other);
      const approval = await requestedApproval(other, otherToken);
      const { row } = await browserChoice(otherClient, other, approval);
      const delta = row.expires_at - base;
      const shifted = {
        ...row,
        created_at: row.created_at - delta,
        expires_at: row.expires_at - delta,
      };
      expect(shifted.created_at).toBeGreaterThanOrEqual(0);
      expect(shifted.expires_at).toBeLessThanOrEqual(base);
      expect(shifted.created_at).toBeLessThan(shifted.expires_at);
      expect(shifted.expires_at - shifted.created_at).toBe(
        row.expires_at - row.created_at,
      );
      expect(shifted.expires_at - shifted.created_at).toBeLessThanOrEqual(
        approvalLifetime,
      );
      expect(shifted.used_at).toBeNull();
      expect(browserProof(other, shifted)).not.toBe(row.mac);
      editBrowser(other, row, {
        created_at: shifted.created_at,
        expires_at: shifted.expires_at,
      });
      expect(browserRows(other)).toEqual([shifted]);
      const cookie = randomBrowserValue();
      await beforeBrowserWrite(
        other,
        () =>
          otherClient.fetch(
            decisionRequest(browserTicket(other, approval, cookie), cookie),
          ),
        unavailableApproval,
        browserStorageMessage,
      );
    });
  },
);

browserCase(
  "CONTROL Q13 removes only authenticated expired browser rows",
  async (f, t, _p, _ports, client) => {
    const h = await requestedApproval(f, t);
    const { row } = await browserChoice(client, f, h);
    addBrowserRows(
      f,
      Array.from({ length: 3 }, () => expiredContext(f, row)),
    );
    expect(browserRows(f)).toHaveLength(4);
    const inserted = await browserChoice(client, f, h);
    expect(browserRows(f)).toEqual(
      [row, inserted.row].toSorted((a, b) =>
        a.state_hash.localeCompare(b.state_hash),
      ),
    );
    expect(approvalRows(f)).toEqual([h]);
  },
);

const browserEdits: [string, (f: Base, row: BrowserRow) => void][] = [
  ["MAC", (f, row) => editBrowser(f, row, { mac: "0".repeat(81) })],
  ["action", (f, row) => editBrowser(f, row, { action: "deny" })],
  [
    "approval_id",
    (f, row) => editBrowser(f, row, { approval_id: crypto.randomUUID() }),
  ],
  ["used_at", (f, row) => editBrowser(f, row, { used_at: base })],
  [
    "state_hash",
    (f, row) => editBrowser(f, row, { state_hash: "invalid-state" }),
  ],
  [
    "text expires_at",
    (f, row) =>
      f.db.run(
        `UPDATE ${browserTable} SET expires_at='invalid' WHERE state_hash=?`,
        [row.state_hash],
      ),
  ],
  [
    "other object MAC",
    (f, row) =>
      editBrowser(f, row, {
        mac: browserProof(f, row, undefined, sha("other scope")),
      }),
  ],
  [
    "removed key",
    (f, row) => editBrowser(f, row, { mac: browserProof(f, row, newKey()) }),
  ],
  ["duplicate state hash", duplicateBrowser],
];
for (const [variant, edit] of browserEdits) {
  browserCase(
    `RED Q14 browser inventory refuses ${variant}`,
    async (f, t, _p, ports, client) => {
      const h = await requestedApproval(f, t);
      const { row } = await browserChoice(client, f, h);
      edit(f, row);
      const cookie = randomBrowserValue();
      await beforeBrowserWrite(
        f,
        () =>
          client.fetch(decisionRequest(browserTicket(f, h, cookie), cookie)),
        unavailableApproval,
        browserStorageMessage,
      );
      expect(ports.begins).toHaveLength(1);
    },
  );
}

browserCase(
  "CONTROL Q15 previous-key browser rows are retained and count",
  async (f, t, _p, _ports, client) => {
    const h = await requestedApproval(f, t);
    const { row } = await browserChoice(client, f, h);
    rotateBrowserSeal(f);
    const fresh = await browserChoice(client, f, h);
    expect(browserRows(f)).toContainEqual(row);
    expect(fresh.row.mac).toBe(browserProof(f, fresh.row));
    expect(browserRows(f)).toHaveLength(2);
    expect(approvalRows(f)).toEqual([h]);
  },
);

browserCase(
  "RED Q16 provider begin fault maps to unavailable after exactly one browser insert",
  async (f, t, _p, ports, client) => {
    const h = await requestedApproval(f, t);
    const cookie = randomBrowserValue();
    const ticket = browserTicket(f, h, cookie);
    ports.behavior.begin = () =>
      Promise.reject(new Error("fixture provider failure"));
    const authority = core(f);
    const effects = f.observeEffects();
    await browserRefusal(
      await client.fetch(decisionRequest(ticket, cookie)),
      unavailableApproval,
    );
    expect(approvalRows(f)).toEqual([h]);
    expect(core(f)).toBe(authority);
    const [row] = browserRows(f)!;
    expect(browserRows(f)).toHaveLength(1);
    expect(row).toMatchObject({
      approval_id: h.id,
      nonce: ticketFields(ticket).nonce,
      used_at: null,
      mac: browserProof(f, row!),
    });
    expect(effects()).toEqual({
      sqlWriteAttempts: 2,
      alarmWrites: 0,
      sqlAndKvIntact: false,
    });
  },
);

for (const table of [true, false]) {
  browserCase(
    `CONTROL CB1 absent state with ${table ? "existing" : "missing"} browser table`,
    async (f, t, _p, ports, client) => {
      const h = await requestedApproval(f, t);
      if (table) await browserChoice(client, f, h);
      expect(browserRows(f) !== undefined).toBe(table);
      await beforeBrowserWrite(
        f,
        () => client.fetch(callbackRequest(emptyState())),
        authInvalid,
      );
      expect(ports.claims).toEqual([]);
      expect(ports.verifies).toEqual([]);
    },
  );
}

for (const other of [
  emptyState,
  () => "forge-device." + randomBrowserValue(),
]) {
  const namespace = other === emptyState ? "promotion" : "device";
  browserCase(
    `RED CB2 callback refuses a second ${namespace} state`,
    async (f, t, _p, ports, client) => {
      const h = await requestedApproval(f, t);
      const choice = await browserChoice(client, f, h);
      const query = new URLSearchParams([
        ["state", browserState(ports, choice)],
        ["state", other()],
      ]);
      await beforeBrowserWrite(
        f,
        () =>
          client.fetch(
            browserRequest(`/callback?${query}`, undefined, choice.jar),
          ),
        authInvalid,
      );
      expect(ports.claims).toEqual([]);
      expect(ports.verifies).toEqual([]);
    },
  );
}

for (const variant of [
  "selector edit",
  "action edit",
  "cross-object MAC",
  "duplicate state",
  "removed key",
  "expired malformed row",
] as const) {
  browserCase(
    `RED callback authenticates browser ${variant}${variant === "cross-object MAC" ? " (B5)" : variant === "expired malformed row" ? " (CB3)" : ""}`,
    async (f, t, _p, ports, client) => {
      const h = await requestedApproval(f, t);
      const x = await requestedApproval(f, t);
      const choice = await browserChoice(
        client,
        f,
        h,
        variant === "action edit" ? "deny" : "approve",
      );
      const { row } = choice;
      if (variant === "selector edit")
        editBrowser(f, row, {
          approval_id: String(x.id),
          payload_digest: approvalDigest(f, x),
        });
      if (variant === "action edit") editBrowser(f, row, { action: "approve" });
      if (variant === "cross-object MAC")
        editBrowser(f, row, {
          mac: browserProof(f, row, undefined, sha("the other object")),
        });
      if (variant === "duplicate state") duplicateBrowser(f, row);
      if (variant === "removed key")
        editBrowser(f, row, { mac: browserProof(f, row, newKey()) });
      if (variant === "expired malformed row")
        editBrowser(f, row, { expires_at: base - 1, mac: "0".repeat(81) });
      await beforeBrowserWrite(
        f,
        () => client.fetch(callbackFor(ports, choice)),
        unavailableApproval,
        browserStorageMessage,
      );
      expect(ports.claims).toEqual([]);
      expect(ports.verifies).toEqual([]);
    },
  );
}

for (const action of ["approve", "deny"] as const) {
  browserCase(
    `CONTROL unchanged browser context decides selected ${action} on H only`,
    async (f, t, _p, ports, client) => {
      const h = await requestedApproval(f, t);
      const x = await requestedApproval(f, t);
      const choice = await browserChoice(client, f, h, action);
      await successfulCallback(client, f, ports, h, choice, action);
      expectConsumed(f, choice.row, base, [choice.row]);
      expect(approvalRows(f)).toContainEqual(x);
      expect(ports.claims).toEqual(claimCalls(f, choice.row, "won", "won"));
    },
  );
}

browserCase(
  "CONTROL callback accepts previous-key browser context and rewrites with current key",
  async (f, t, _p, ports, client) => {
    const h = await requestedApproval(f, t);
    const x = await requestedApproval(f, t);
    const selected = await browserChoice(client, f, h, "deny");
    await browserChoice(client, f, x);
    const browsers = browserRows(f)!;
    const authority = core(f);
    rotateBrowserSeal(f);
    expect(browserProof(f, selected.row)).not.toBe(selected.row.mac);
    await successfulCallback(client, f, ports, h, selected, "deny");
    expectConsumed(f, selected.row, base, browsers);
    expect(approvalRows(f)).toContainEqual(x);
    expect(core(f)).toBe(authority);
    expect(ports.claims).toEqual(claimCalls(f, selected.row, "won", "won"));
  },
);

for (const variant of [
  "no bind cookie",
  "another state's bind cookie",
] as const) {
  browserCase(
    `RED B2 callback refuses ${variant}`,
    async (f, t, _p, ports, client) => {
      const h = await requestedApproval(f, t);
      const choice = await browserChoice(client, f, h);
      const jar =
        variant === "no bind cookie"
          ? undefined
          : (await browserChoice(client, f, h)).jar;
      await beforeBrowserWrite(
        f,
        () => client.fetch(callbackRequest(browserState(ports, choice), jar)),
        authInvalid,
      );
      expect(ports.claims).toEqual([]);
      expect(ports.verifies).toEqual([]);
    },
  );
}

for (const variant of [
  "used",
  "usedAt rolled back",
  "at expiry",
  "pending approval rolled back",
] as const) {
  const caseName = {
    used: "B7",
    "usedAt rolled back": "B8",
    "at expiry": "E1",
    "pending approval rolled back": "D4",
  }[variant];
  browserCase(
    `RED ${caseName} callback replay boundary: ${variant}`,
    async (f, t, _p, ports, client) => {
      const h = await requestedApproval(f, t);
      const selected = await browserChoice(client, f, h);
      const before = browserRows(f)!;
      if (variant === "at expiry") at(h.expires_at);
      else {
        await successfulCallback(client, f, ports, h, selected);
        expectConsumed(f, selected.row, base, before);
      }
      if (variant === "pending approval rolled back") replaceApproval(f, h, {});
      const claims = [...ports.claims];
      const verification = [...ports.verifies];
      if (variant === "usedAt rolled back") {
        editBrowser(f, selected.row, { used_at: null, mac: selected.row.mac });
        expect(browserRows(f)).toEqual(before);
        const approvals = approvalRows(f);
        await browserRefusal(
          await client.fetch(callbackFor(ports, selected)),
          authInvalid,
        );
        expectConsumed(f, selected.row, base, before);
        expect(approvalRows(f)).toEqual(approvals);
        expect(ports.claims).toEqual([
          ...claims,
          ...claimCalls(f, selected.row, "refused"),
        ]);
      } else {
        await beforeBrowserWrite(
          f,
          () => client.fetch(callbackFor(ports, selected)),
          authInvalid,
        );
        expect(ports.claims).toEqual(claims);
      }
      expect(ports.verifies).toEqual(verification);
    },
  );
}

const proofFor = (
  patch: Partial<ReturnType<typeof identityClaims>> = {},
  minted = base,
) => {
  const proof = { ...identityClaims(), ...patch };
  return testIdentityVerifier(new Map([["proof", proof]])).verify(
    "proof",
    proof.audience,
    minted,
  );
};

const k1Cases = [
  ["upstream claim false", authInvalid, "refused", undefined],
  ["upstream claim throws", unavailableApproval, "threw", undefined],
  ["decision claim false", needsApproval, "won", "refused"],
  ["decision claim throws", unavailableApproval, "won", "threw"],
  ["provider unavailable", unavailableApproval, "won", undefined],
  ["wrong audience", authInvalid, "won", undefined],
  ["expired identity", authInvalid, "won", undefined],
  ["future identity", authInvalid, "won", undefined],
  ["non-owner", [403, "AUTH_FORBIDDEN"], "won", undefined],
] as const;

for (const [variant, result, first, second] of k1Cases) {
  browserCase(
    `RED K1 callback refuses ${variant}`,
    async (f, t, _p, ports, client) => {
      const h = await requestedApproval(f, t);
      const choice = await browserChoice(client, f, h);
      const before = browserRows(f)!;
      const normalClaim = ports.behavior.claim;
      if (
        variant.startsWith("upstream claim") ||
        variant.startsWith("decision claim")
      ) {
        const target = variant.startsWith("upstream")
          ? upstreamKey(choice.row)
          : committedKey(f, choice.row);
        ports.behavior.claim = (hash, until) =>
          hash !== target
            ? normalClaim(hash, until)
            : variant.endsWith("throws")
              ? Promise.reject(new Error("fixture claim fault"))
              : Promise.resolve(false);
      }
      if (variant === "provider unavailable")
        ports.behavior.verify = () =>
          Promise.resolve({ ok: false, reason: "unavailable" });
      if (variant === "wrong audience")
        ports.behavior.verify = () => proofFor({ audience: "other-client" });
      if (variant === "expired identity")
        ports.behavior.verify = () =>
          proofFor({ authenticatedAt: base - 1, expiresAt: base }, base - 1);
      if (variant === "future identity")
        ports.behavior.verify = () => proofFor({ authenticatedAt: base + 1 });
      if (variant === "non-owner")
        ports.behavior.verify = () => proofFor({ subject: "another-owner" });
      await browserRefusal(
        await client.fetch(callbackFor(ports, choice)),
        result,
      );
      expectConsumed(f, choice.row, base, before);
      expect(approvalRows(f)).toEqual([h]);
      expect(ports.verifies).toHaveLength(first === "won" ? 1 : 0);
      expect(ports.claims).toEqual(claimCalls(f, choice.row, first, second));
    },
  );
}

for (const variant of ["approve edit", "deny edit", "honest"] as const) {
  browserCase(
    `CONTROL S2 captured callback context ${variant}`,
    async (f, t, _p, ports, client) => {
      const h = await requestedApproval(f, t);
      const x = await requestedApproval(f, t);
      const action = variant === "deny edit" ? "deny" : "approve";
      const choice = await browserChoice(client, f, h, action);
      const before = browserRows(f)!;
      const pause = pauseBrowser(ports.behavior.verify);
      ports.behavior.verify = pause.awaitPort;
      const pending = client.fetch(callbackFor(ports, choice));
      let external: BrowserRow[] | undefined;
      try {
        await requirePause(pause, pending);
        expectConsumed(f, choice.row, base, before);
        if (variant !== "honest")
          editBrowser(f, choice.row, {
            approval_id: String(x.id),
            payload_digest: approvalDigest(f, x),
            ...(variant === "deny edit" ? { action: "approve" } : {}),
          });
        external = browserRows(f);
      } finally {
        pause.release();
      }
      const response = await pending;
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(
        action === "deny" ? "denied" : "approved",
      );
      expectDecided(f, h, action);
      expect(approvalRows(f)).toContainEqual(x);
      expect(browserRows(f)).toEqual(external);
      expect(ports.claims).toEqual(claimCalls(f, choice.row, "won", "won"));
    },
  );
}

type BrowserPorts = ReturnType<typeof browserPorts>;
type LateEdit = (
  f: Fixture,
  h: ApprovalFixtureRow,
  x: ApprovalFixtureRow,
  ports: BrowserPorts,
) => void;
const lateApprovalEdits: [string, LateEdit, BrowserReply, string?][] = [
  [
    "S3 swapped approval during verify",
    swapApproval,
    unavailableApproval,
    browserStorageMessage,
  ],
  [
    "T6 authentic same-id replacement",
    (f, h) => replaceApproval(f, h, alternateActivation()),
    inputConflict,
    bindingMessage,
  ],
  [
    "T5 corrupted root during verify",
    (f) => {
      f.db.run("UPDATE cloud_v3_root SET seal=?", ["0".repeat(81)]);
    },
    unavailableApproval,
  ],
  [
    "CB4 missing approval during verify",
    (f, h) => {
      f.db.run(`DELETE FROM ${approvalTable} WHERE id=?`, [h.id]);
    },
    needsApproval,
  ],
  [
    "CB5 edited approval during verify",
    (f, h) => {
      editApproval(f, String(h.id), approvedFixture);
    },
    unavailableApproval,
    browserStorageMessage,
  ],
  [
    "E4 approval expires during verify",
    (_f, h) => {
      at(h.expires_at);
    },
    needsApproval,
  ],
];

for (const [variant, edit, result, message] of lateApprovalEdits) {
  browserCase(`RED ${variant}`, async (f, t, _p, ports, client) => {
    const h = await requestedApproval(f, t);
    const x = await requestedApproval(f, t);
    const choice = await browserChoice(client, f, h);
    await browserChoice(client, f, x, "deny");
    const before = browserRows(f)!;
    const originalClaim = ports.behavior.claim;
    if (variant.startsWith("E4")) {
      ports.behavior.claim = (hash, until) =>
        Date.now() >= until
          ? Promise.resolve(false)
          : originalClaim(hash, until);
    }
    const pause = pauseBrowser(ports.behavior.verify);
    ports.behavior.verify = pause.awaitPort;
    const pending = client.fetch(callbackFor(ports, choice));
    let approvals: ApprovalFixtureRow[] | undefined;
    try {
      await requirePause(pause, pending);
      expectConsumed(f, choice.row, base, before);
      edit(f, h, x, ports);
      approvals = approvalRows(f);
    } finally {
      pause.release();
    }
    await browserRefusal(await pending, result, message);
    expectConsumed(f, choice.row, base, before);
    expect(approvalRows(f)).toEqual(approvals);
    expect(ports.claims).toEqual(
      claimCalls(
        f,
        choice.row,
        "won",
        variant.startsWith("E4") ? "refused" : "won",
      ),
    );
  });
}

for (const newOwner of [false, true]) {
  browserCase(
    `RED ${newOwner ? "T2b new owner with old policy" : "T2 stale owner"} after request`,
    async (f, t, _p, ports, client) => {
      const h = await requestedApproval(f, t);
      const choice = await browserChoice(client, f, h);
      const before = browserRows(f)!;
      changeOwner(f);
      if (newOwner)
        ports.behavior.verify = () => proofFor({ subject: "another-owner" });
      await browserRefusal(
        await client.fetch(callbackFor(ports, choice)),
        newOwner ? inputConflict : [403, "AUTH_FORBIDDEN"],
        newOwner ? bindingMessage : undefined,
      );
      expectConsumed(f, choice.row, base, before);
      expect(approvalRows(f)).toEqual([h]);
      expect(ports.claims).toEqual(
        claimCalls(f, choice.row, "won", newOwner ? "won" : undefined),
      );
    },
  );
}

for (const rollback of [false, true]) {
  browserCase(
    `${rollback ? "RED D5 pending rollback" : "CONTROL D1 terminal race"} preserves the deny winner`,
    async (f, t, _p, ports, client) => {
      const h = await requestedApproval(f, t);
      const approve = await browserChoice(client, f, h);
      const deny = await browserChoice(client, f, h, "deny");
      const authority = core(f);
      expect(committedKey(f, approve.row)).toBe(committedKey(f, deny.row));
      expect(upstreamKey(approve.row)).not.toBe(upstreamKey(deny.row));
      await successfulCallback(client, f, ports, h, deny, "deny");
      if (rollback) replaceApproval(f, h, {});
      const approvals = approvalRows(f);
      const browsers = browserRows(f)!;
      await browserRefusal(
        await client.fetch(callbackFor(ports, approve)),
        needsApproval,
      );
      expect(approvalRows(f)).toEqual(approvals);
      expectConsumed(f, approve.row, base, browsers);
      expect(core(f)).toBe(authority);
      expect(ports.claims).toEqual([
        ...claimCalls(f, deny.row, "won", "won"),
        ...claimCalls(f, approve.row, "won", "refused"),
      ]);
    },
  );
}

browserCase(
  "RED D6 parallel callbacks for the same approve payload have one winner",
  async (f, t, _p, ports, client) => {
    const h = await requestedApproval(f, t);
    const choices = [
      await browserChoice(client, f, h),
      await browserChoice(client, f, h),
    ];
    const pauses = choices.map(() => pauseBrowser(ports.behavior.verify));
    let next = 0;
    ports.behavior.verify = () => pauses[next++]!.awaitPort();
    const pending = choices.map((choice) =>
      client.fetch(callbackFor(ports, choice)),
    );
    try {
      for (const pause of pauses) {
        expect(
          await Promise.race([
            pause.reached.then(() => "port reached"),
            ...pending.map((response) => response.then(() => "reply arrived")),
          ]),
        ).toBe("port reached");
      }
    } finally {
      for (const pause of pauses) pause.release();
    }
    const responses = await Promise.all(pending);
    const winners = responses.filter(({ status }) => status === 200);
    expect(winners).toHaveLength(1);
    expect(await winners[0]!.text()).toContain("approved");
    await browserRefusal(
      responses.find((response) => response !== winners[0])!,
      needsApproval,
    );
    expectDecided(f, h, "approve");
    expect(browserRows(f)).toEqual(
      choices
        .map(({ row }) => {
          const used = { ...row, used_at: base };
          return { ...used, mac: browserProof(f, used) };
        })
        .toSorted((a, b) => a.state_hash.localeCompare(b.state_hash)),
    );
    expect(
      ports.claims.filter(({ hash }) =>
        [upstreamKey(choices[0]!.row), upstreamKey(choices[1]!.row)].includes(
          hash,
        ),
      ),
    ).toEqual(
      expect.arrayContaining(choices.map(({ row }) => claimCalls(f, row)[0]!)),
    );
    expect(ports.decisionClaims(f, choices[0]!.row)).toEqual([
      {
        hash: committedKey(f, choices[0]!.row),
        until: h.expires_at,
        outcome: "won",
      },
      {
        hash: committedKey(f, choices[0]!.row),
        until: h.expires_at,
        outcome: "refused",
      },
    ]);
  },
);

const finalWrite = /^UPDATE cloud_v3_approvals SET status=/i;

async function faultedDecision(
  f: Fixture,
  client: Project,
  ports: BrowserPorts,
  choice: BrowserChoice,
  fault: Error | ForgeFailure,
) {
  const undo = interceptSql(f, finalWrite, fault, true);
  try {
    return await client.fetch(callbackFor(ports, choice));
  } finally {
    undo();
  }
}

for (const variant of ["plain", "UNAVAILABLE", "retryable"] as const) {
  browserCase(
    `RED ${variant === "retryable" ? "callback reconciles retryable storage fault" : `K2 ${variant} local decision failure keeps the won claim`}`,
    async (f, t, _p, ports, client) => {
      const h = await requestedApproval(f, t);
      const approve = await browserChoice(client, f, h);
      const deny = await browserChoice(client, f, h, "deny");
      const before = browserRows(f)!;
      const authority = core(f);
      const effects = f.observeEffects();
      const fault =
        variant === "plain"
          ? new Error("fixture final write aborted")
          : variant === "retryable"
            ? Object.assign(new Error("fixture retryable final write"), {
                retryable: true,
              })
            : new ForgeFailure({
                code: "UNAVAILABLE",
                message: "fixture final write unavailable",
                retry: "never",
              });
      const reply = await faultedDecision(f, client, ports, approve, fault);
      const error = await browserRefusal(
        reply,
        variant === "plain" ? [500, "INTERNAL"] : unavailableApproval,
      );
      if (variant === "retryable") expect(error.retry).toBe("reconcile_first");
      expect(approvalRows(f)).toEqual([h]);
      expectConsumed(f, approve.row, base, before);
      expect(effects()).toEqual({
        sqlWriteAttempts: 2,
        alarmWrites: 0,
        sqlAndKvIntact: false,
      });
      expect(core(f)).toBe(authority);
      const postFault = browserRows(f)!;
      await browserRefusal(
        await client.fetch(callbackFor(ports, deny)),
        needsApproval,
      );
      expectConsumed(f, deny.row, base, postFault);
      expect(approvalRows(f)).toEqual([h]);
      expect(ports.held.has(committedKey(f, approve.row))).toBe(true);
      expect(ports.claims).toEqual([
        ...claimCalls(f, approve.row, "won", "won"),
        ...claimCalls(f, deny.row, "won", "refused"),
      ]);
    },
  );
}

browserCase(
  "CONTROL unrelated GET retains safe retry for a retryable storage error",
  async (f, t, _p, ports, client) => {
    await requestedApproval(f, t);
    const undo = interceptSql(
      f,
      /\bFROM cloud_v3_root\b/i,
      Object.assign(new Error("fixture retryable root read"), {
        retryable: true,
      }),
    );
    try {
      const error = await beforeBrowserWrite(
        f,
        () => client.fetch(f.request(probe)),
        unavailableApproval,
      );
      expect(error.retry).toBe("safe");
    } finally {
      undo();
    }
    expect(ports.claims).toEqual([]);
    expect(ports.verifies).toEqual([]);
  },
);

browserCase(
  "RED K3 decision claim committed before its reply was lost",
  async (f, t, _p, ports, client) => {
    const h = await requestedApproval(f, t);
    const approve = await browserChoice(client, f, h);
    const deny = await browserChoice(client, f, h, "deny");
    const before = browserRows(f)!;
    const claim = ports.behavior.claim;
    const key = committedKey(f, approve.row);
    ports.behavior.claim = async (hash, until) => {
      const won = await claim(hash, until);
      if (hash === key && won) throw new Error("fixture lost claim reply");
      return won;
    };
    await browserRefusal(
      await client.fetch(callbackFor(ports, approve)),
      unavailableApproval,
    );
    expectConsumed(f, approve.row, base, before);
    expect(approvalRows(f)).toEqual([h]);
    expect(ports.held.has(key)).toBe(true);
    const retained = browserRows(f)!;
    await browserRefusal(
      await client.fetch(callbackFor(ports, deny)),
      needsApproval,
    );
    expectConsumed(f, deny.row, base, retained);
    expect(approvalRows(f)).toEqual([h]);
    expect(ports.claims).toEqual([
      ...claimCalls(f, approve.row, "won", "threw"),
      ...claimCalls(f, deny.row, "won", "refused"),
    ]);
  },
);

browserCase(
  "RED K4 committed decision whose response was lost cannot decide twice after rollback",
  async (f, t, _p, ports, client) => {
    const h = await requestedApproval(f, t);
    const approve = await browserChoice(client, f, h);
    const deny = await browserChoice(client, f, h, "deny");
    const authority = core(f);
    const before = browserRows(f)!;
    const deliver = async () => {
      await client.fetch(callbackFor(ports, approve));
      throw new Error("fixture discarded callback response");
    };
    await expect(deliver()).rejects.toThrow(
      "fixture discarded callback response",
    );
    expectDecided(f, h, "approve");
    expectConsumed(f, approve.row, base, before);
    replaceApproval(f, h, {});
    const retained = browserRows(f)!;
    await browserRefusal(
      await client.fetch(callbackFor(ports, deny)),
      needsApproval,
    );
    expectConsumed(f, deny.row, base, retained);
    expect(approvalRows(f)).toEqual([h]);
    expect(core(f)).toBe(authority);
    expect(ports.claims).toEqual([
      ...claimCalls(f, approve.row, "won", "won"),
      ...claimCalls(f, deny.row, "won", "refused"),
    ]);
  },
);

for (const lapse of ["identity expiry", "policy change"] as const) {
  browserCase(
    `RED ${lapse === "identity expiry" ? "K5" : "K6"} ${lapse} during winning decision claim`,
    async (f, t, _p, ports, client) => {
      const h = await requestedApproval(f, t);
      const approve = await browserChoice(client, f, h);
      const deny = await browserChoice(client, f, h, "deny");
      const browsers = browserRows(f)!;
      const expiresAt = base + 100;
      ports.behavior.verify = () => proofFor({ expiresAt });
      const claim = ports.behavior.claim;
      const key = committedKey(f, approve.row);
      const pause = pauseBrowser(() => claim(key, h.expires_at));
      ports.behavior.claim = (hash, until) =>
        hash === key ? pause.awaitPort() : claim(hash, until);
      const reply = client.fetch(callbackFor(ports, approve));
      try {
        await requirePause(pause, reply);
        expect(ports.claims.map(({ hash }) => hash)).toEqual([
          upstreamKey(approve.row),
          key,
        ]);
        expectConsumed(f, approve.row, base, browsers);
        expect(approvalRows(f)).toEqual([h]);
        if (lapse === "identity expiry") at(expiresAt);
        else changeOwner(f);
      } finally {
        pause.release();
      }
      await browserRefusal(
        await reply,
        lapse === "identity expiry" ? authInvalid : [403, "AUTH_FORBIDDEN"],
      );
      expect(approvalRows(f)).toEqual([h]);
      expect(ports.held.has(key)).toBe(true);
      expect(ports.claims).toEqual(claimCalls(f, approve.row, "won", "won"));
      if (lapse === "identity expiry") {
        ports.behavior.verify = () => proofFor();
        ports.behavior.claim = claim;
        const retained = browserRows(f)!;
        await browserRefusal(
          await client.fetch(callbackFor(ports, deny)),
          needsApproval,
        );
        expectConsumed(f, deny.row, expiresAt, retained);
        expect(approvalRows(f)).toEqual([h]);
        expect(ports.claims).toEqual([
          ...claimCalls(f, approve.row, "won", "won"),
          ...claimCalls(f, deny.row, "won", "refused"),
        ]);
      }
    },
  );
}

function realBrowserClaims() {
  let now = base;
  const held = new Map<string, number>();
  const calls: { hash: string; until: number; status: number }[] = [];
  const claimStore: ClaimStore = {
    get: <T>(key: string) => Promise.resolve(held.get(key) as T | undefined),
    put: (key, value) => {
      held.set(key, value);
      return Promise.resolve();
    },
    setAlarm: () => Promise.resolve(),
  };
  let previous = Promise.resolve();
  const object = new CodeRedemption(
    {
      storage: {
        ...claimStore,
        deleteAll: () => {
          held.clear();
          return Promise.resolve();
        },
        transaction<T>(apply: (state: ClaimStore) => Promise<T>) {
          const pending = previous.then(() => apply(claimStore));
          previous = pending.then(
            () => undefined,
            () => undefined,
          );
          return pending;
        },
      },
    },
    undefined,
    { now: () => now },
  );
  const port = durableRedemption({
    idFromName: (hash) => hash,
    get: () => ({
      async fetch(request) {
        const url = new URL(request.url);
        const reply = await object.fetch(request);
        calls.push({
          hash: url.pathname.slice(1),
          until: Number(url.searchParams.get("until")),
          status: reply.status,
        });
        return reply;
      },
    }),
  });
  const direct = async (hash: string, until: number) =>
    (
      await object.fetch(
        new Request(`https://redemption.internal/${hash}?until=${until}`, {
          method: "POST",
        }),
      )
    ).status;
  return {
    port,
    direct,
    calls,
    held,
    time: (value: number) => {
      now = value;
    },
  };
}

for (const boundary of ["upper window", "expired"] as const) {
  browserCase(
    `RED ${boundary === "upper window" ? "K7" : "K8"} real claim-store ${boundary} refuses the final decision`,
    async (f, t, _p, ports) => {
      const store = realBrowserClaims();
      for (const until of boundary === "upper window"
        ? [base + 660_001]
        : [base, base - 1]) {
        const direct = sha(randomBrowserValue());
        const through = sha(randomBrowserValue());
        expect(await store.direct(direct, until)).toBe(400);
        expect(await store.port.claimOnce(through, until)).toBe(false);
      }
      store.calls.length = 0;
      const h = await requestedApproval(f, t);
      const client = browserProject(f, {
        upstream: ports.upstream,
        redemption: store.port,
      });
      const choice = await browserChoice(client, f, h);
      const verify = ports.behavior.verify;
      ports.behavior.verify = () => {
        store.time(boundary === "upper window" ? base - 60_001 : h.expires_at);
        return verify();
      };
      const browsers = browserRows(f)!;
      await browserRefusal(
        await client.fetch(callbackFor(ports, choice)),
        needsApproval,
      );
      expect(approvalRows(f)).toEqual([h]);
      expectConsumed(f, choice.row, base, browsers);
      expect(store.calls).toEqual([
        { hash: upstreamKey(choice.row), until: h.expires_at, status: 200 },
        { hash: committedKey(f, choice.row), until: h.expires_at, status: 400 },
      ]);
      expect(store.held.has(committedKey(f, choice.row))).toBe(false);
    },
  );
}

test(
  "CONTROL K9 real claim store accepts the exact upper window once",
  async () => {
    const { port, direct, calls } = realBrowserClaims();
    const directHash = sha(randomBrowserValue());
    const adapterHash = sha(randomBrowserValue());
    const until = base + 660_000;
    expect(await direct(directHash, until)).toBe(200);
    expect(await direct(directHash, until)).toBe(400);
    expect(await port.claimOnce(adapterHash, until)).toBe(true);
    expect(await port.claimOnce(adapterHash, until)).toBe(false);
    expect(calls).toEqual([
      { hash: adapterHash, until, status: 200 },
      { hash: adapterHash, until, status: 400 },
    ]);
  },
  timeout,
);

browserCase(
  "CONTROL K10 a fresh approval id recovers after an ambiguous old decision",
  async (f, t, _p, ports, client) => {
    const h = await requestedApproval(f, t);
    const failed = await browserChoice(client, f, h);
    const old = await browserChoice(client, f, h, "deny");
    const first = browserRows(f)!;
    await browserRefusal(
      await faultedDecision(
        f,
        client,
        ports,
        failed,
        new Error("fixture final write aborted"),
      ),
      [500, "INTERNAL"],
    );
    expectConsumed(f, failed.row, base, first);
    expect(approvalRows(f)).toEqual([h]);
    const x = await requestedApproval(f, t);
    expect(x.id).not.toBe(h.id);
    const cookie = randomBrowserValue();
    const preview = await browserPreview(client, x, cookie);
    const fresh = await browserChoice(
      client,
      f,
      x,
      "approve",
      preview.approve,
      cookie,
    );
    await successfulCallback(client, f, ports, x, fresh);
    const before = browserRows(f)!;
    const approvals = approvalRows(f);
    await browserRefusal(
      await client.fetch(callbackFor(ports, old)),
      needsApproval,
    );
    expect(approvalRows(f)).toEqual(approvals);
    expectConsumed(f, old.row, base, before);
    expect(ports.held.has(committedKey(f, failed.row))).toBe(true);
    expect(ports.claims).toEqual([
      ...claimCalls(f, failed.row, "won", "won"),
      ...claimCalls(f, fresh.row, "won", "won"),
      ...claimCalls(f, old.row, "won", "refused"),
    ]);
  },
);

for (const decided of [true, false]) {
  browserCase(
    `${decided ? "RED X6" : "CONTROL X7"} exact restore retry preserves browser authority`,
    async (f, t, p, ports, client) => {
      const h = await requestedApproval(f, t);
      const choice = await browserChoice(client, f, h);
      if (decided) {
        await successfulCallback(client, f, ports, h, choice);
        const x = await requestedApproval(f, t, approvalRows(f));
        await browserChoice(client, f, x, "deny");
        const terminal = terminalApprovals
          .slice(0, 2)
          .map((fields) => signedApproval(f, t, fields));
        for (const row of terminal) {
          const values = Object.values(row);
          f.db.run(
            `INSERT INTO ${approvalTable} (${Object.keys(row).join(", ")}) VALUES (${values.map(() => "?").join(", ")})`,
            values,
          );
        }
        expect(
          browserRows(f)!.filter(({ used_at }) => used_at === null),
        ).toHaveLength(1);
        expect(
          browserRows(f)!.filter(({ used_at }) => used_at !== null),
        ).toHaveLength(1);
        expect(approvalRows(f)).toEqual(expect.arrayContaining(terminal));
      }
      const browsers = browserRows(f);
      const approvals = approvalRows(f);
      const authority = core(f);
      const effects = f.observeEffects();
      const reply = await p.upload(2);
      expect(reply).toEqual({
        status: 200,
        body: { ok: true, value: { page: 2, verified: true } },
      });
      expect(browserRows(f)).toEqual(browsers);
      expect(approvalRows(f)).toEqual(approvals);
      expect(core(f)).toBe(authority);
      expect(effects()).toEqual(noWrites);
      expect(exitCode(reply.body as Parameters<typeof exitCode>[0])).toBe(0);
    },
  );
}
