import { timingSafeEqual } from "node:crypto";
import {
  afterEach,
  beforeEach,
  expect,
  setDefaultTimeout,
  setSystemTime,
  test,
} from "bun:test";
import { prepareReceipt } from "../../cloud/src/command-write.ts";
import { failed } from "../../cloud/src/issue-commands.ts";
import { receiptScope } from "../../cloud/src/issue-request-id.ts";
import { writableStore } from "../../cloud/src/store.ts";
import { append, readV3Value, viewV3 } from "../../cloud/src/v3-store.ts";
import { canonicalJson, digestBytes } from "../../src/core/config/pointer.ts";
import type { ForgeError } from "../../src/generated/types.ts";
import { exitCode } from "../../src/surface/result.ts";
import {
  guardFixture,
  noWrites,
  observeRestoreReset,
  type Portable,
  portableOf,
  portableUpload,
  probe,
  recovered,
  trustedSeal,
} from "./v3-project.fixture.ts";

if (!("timingSafeEqual" in crypto.subtle))
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    value: timingSafeEqual,
  });

setDefaultTimeout(30_000);
const time = Date.parse("2026-11-20T12:00:00.000Z");
const ttlMs = 3_600_000;
const expiry = time + 2 * ttlMs;
const env = { FORGE_CLOUD_PROJECT: "a", FORGE_CLOUD_ID_PREFIX: "forge" };
const actor = { kind: "agent", id: "fixture" };
const session = { id: "fixture" };
const subject = "issue:work-1";
const checkpointRoute = `${probe}/checkpoint`;
const create = {
  op: "issue.create",
  requestId: "k",
  input: { title: "Before" },
  context: { actor },
};
const update = {
  op: "issue.update",
  requestId: "k",
  input: { id: "forge-1", expectRevision: 1, title: "After" },
  context: { actor, session, leaseGeneration: 1 },
};
const typedClaim = {
  op: "issue.claim",
  requestId: "k",
  input: { id: "forge-1", ttlSeconds: 60 },
  context: { actor, session },
};
const initial = {
  id: "work-1",
  prefix: "forge",
  title: "Before",
  status: "open",
  labels: [],
  dependsOn: [] as string[],
  createdAt: new Date(time).toISOString(),
};

beforeEach(() => setSystemTime(time));
afterEach(() => setSystemTime());

type Fixture = ReturnType<typeof guardFixture>;
type Json = Record<string, unknown>;
type Mode = "owner" | "token";
type Err = Json & { code: string };
type Setup = (f: Fixture) => Promise<void>;
type Edit = { result?: (r: Json) => void; frame?: (row: Json) => void };
type Place = "cold" | "checkpoint" | "portable";

const never = (code: string, message: string) => ({
  code,
  message,
  retry: "never",
});
const leased = (code: string, message: string, lease: object) => ({
  code,
  message,
  retry: "reconcile_first",
  lease,
});
const refused = (status: number, code: string, message: string) => ({
  status,
  body: { ok: false, error: never(code, message) },
});
const unavailable = refused(503, "UNAVAILABLE", "Cloud v3 root is unavailable");
const restoreRefusal = refused(
  400,
  "RESTORE_INVALID_ROW",
  "Cloud v3 portable restore could not be verified",
);
const answer = (mode: Mode, error: Err) =>
  mode === "owner"
    ? { ok: false, error }
    : failed(error as unknown as ForgeError);
const exitFor = (code?: string) =>
  code === undefined
    ? 0
    : code === "INPUT_INVALID"
      ? 6
      : code === "NOT_FOUND"
        ? 3
        : /CONFLICT|LEASE_/.test(code)
          ? 4
          : 1;
const wire = (reply: { body: unknown }) =>
  (reply.body as { error?: Err }).error;
function exited(reply: { body: unknown }, code?: string) {
  const body = reply.body as { status?: string; error?: ForgeError };
  const envelope = "status" in body ? reply.body : failed(body.error!);
  expect(exitCode(envelope as ReturnType<typeof failed>)).toBe(exitFor(code));
}

const tokens = new WeakMap<Fixture, Map<string, string>>();
async function enroll(
  f: Fixture,
  mode: Mode,
  device = "laptop",
  sid = "fixture",
) {
  if (mode === "owner") return;
  const body = { device, session: sid, ttlMs: 2 * ttlMs };
  const reply = await f.send("devices", body);
  expect(reply.status).toBe(200);
  const known = tokens.get(f) ?? new Map<string, string>();
  tokens.set(f, known);
  known.set(
    `${device}/${sid}`,
    (reply.body as { value: { token: string } }).value.token,
  );
}
const owner = (device = "laptop", at = expiry) => ({
  "X-Forge-Owner": device,
  "X-Forge-Owner-Expires": String(at),
});
const send = (f: Fixture, body: object, device = "laptop", sid = "fixture") => {
  const token = tokens.get(f)?.get(`${device}/${sid}`);
  return token
    ? f.send("command", body, { authorization: `Bearer ${token}` })
    : f.send(`${probe}/command`, body, owner(device));
};
const frames = ({ db }: Fixture) =>
  db
    .query<{ body: string }, []>(
      "SELECT body FROM cloud_v3_commits ORDER BY sequence",
    )
    .all()
    .map(({ body }) => JSON.parse(body) as Json);
const last = (f: Fixture) => frames(f).at(-1)!;
const idOf = (row: Json) => (row.outcome as Json).id as string;
const imageOf = (f: Fixture) => {
  const db = writableStore(f.storage);
  return { db, image: recovered(db, f.seal()) };
};
const stored = (f: Fixture, id: string) => {
  const { db, image } = imageOf(f);
  return readV3Value(db, image, "outcome", id);
};
const provision = async (f: Fixture) =>
  expect(await f.send(probe, {})).toMatchObject({ status: 200 });

async function fixtureIssue(f: Fixture, value = initial, revision = 1) {
  const key = `r${value.id.slice(5)}`;
  const frame = {
    operation: "fixture.put",
    time,
    events: [{ key, revision, value }],
    changes: [{ key, value: { revision, value } }],
  };
  const reply = await f.send(`${probe}/commits`, { frames: [frame] });
  expect(reply).toMatchObject({ status: 200 });
}
async function leasedIssue(f: Fixture) {
  await fixtureIssue(f);
  const claim = {
    requestId: "raw",
    subject,
    holder: { actor, session },
    ttlMs,
  };
  const reply = await f.send(`${probe}/claim`, claim, owner());
  expect(reply).toMatchObject({ status: 200 });
}
function lease(f: Fixture) {
  const { db, image } = imageOf(f);
  const { holder, generation, expiresAt } = readV3Value(
    db,
    image,
    "lease",
    subject,
  ) as unknown as { holder: object; generation: number; expiresAt: string };
  return { subject, holder, generation, expiresAt };
}

async function checkpoint(f: Fixture) {
  const { image, coveredHead } = viewV3(imageOf(f).image);
  let covered = coveredHead;
  do {
    const reply = await f.send(checkpointRoute, {});
    expect(reply.status).toBe(200);
    const next = (reply.body as { value: { coveredHead: number } }).value
      .coveredHead;
    if (covered < image.head) expect(next).toBeGreaterThan(covered);
    covered = next;
  } while (covered < image.head);
  expect(frames(f)).toEqual([]);
  f.restart();
  expect(await f.send(probe)).toMatchObject({
    status: 200,
    body: { value: { image } },
  });
}
async function restoreAll(target: Fixture, data: Portable) {
  const upload = portableUpload(target, data);
  for (const page of [0, 1])
    expect(await upload(page)).toMatchObject({ status: 200 });
  expect(await upload(2)).toMatchObject({
    status: 200,
    body: { ok: true, value: { page: 2, verified: true } },
  });
}
async function refusedRestore(target: Fixture, data: Portable) {
  const upload = portableUpload(target, data);
  for (const page of [0, 1])
    expect(await upload(page)).toMatchObject({ status: 200 });
  const reset = observeRestoreReset(target);
  for (const attempt of [1, 2]) {
    const effects = attempt === 2 ? target.observeEffects() : undefined;
    const reply = await upload(2);
    expect(reply).toEqual(restoreRefusal);
    exited(reply, "RESTORE_INVALID_ROW");
    if (effects) expect(effects()).toEqual(noWrites);
    else reset();
  }
}

const holder = { actor, session: { ...session, device: "laptop" } };
const IN = { stage: "input" };
const state = (id: string, extra: Json, who: Json = holder) => ({
  stage: "state",
  id,
  prefix: "forge",
  holder: who,
  ...extra,
});
const ub = (id: string, expectRevision = 1, generation = 1) =>
  state(id, { expectRevision, generation });
const cb = (id: string, seconds = 60) => state(id, { ttlMs: seconds * 1000 });
const upd = (input: Json, context: Json = update.context) => ({
  ...update,
  input,
  context,
});
const u = (patch: Json) => upd({ ...update.input, ...patch });
const clm = (input: Json) => ({ ...typedClaim, input });
const crt = (input: Json) => ({ ...create, input });
const grant = (id: string, ttlSeconds = 60) => clm({ id, ttlSeconds });

const bad = (message: string) => never("INPUT_INVALID", message);
const conflict = (n: number) => ({
  code: "REVISION_CONFLICT",
  message: `Expected revision ${n}; current revision is 1`,
  retry: "reconcile_first",
  currentRevision: 1,
});
const E = {
  graph: bad("Kind, parent and dependencies are not supported in cloud yet"),
  crtGraph: bad("Parent and dependencies are not supported in cloud yet"),
  updSchema: bad("input must be a valid issue.update input"),
  crtSchema: bad("input must be a valid issue.create input"),
  badKind: bad("kind must be one of task, bug, feature, epic"),
  clmInput: bad("Expected a valid issue claim"),
  id: bad("Invalid issue id"),
  prefix: bad("Unknown issue id prefix"),
  ttl24: bad("ttlMs is over 24 hours"),
  ttlToken: bad("ttlMs would exceed the token expiry"),
  missing: never("NOT_FOUND", "Issue was not found"),
  gone: (id = "forge-9") => never("NOT_FOUND", `Issue ${id} was not found`),
  noLease: leased("LEASE_NOT_HELD", `${subject} has no lease`, { subject }),
  closed: never("INPUT_CONFLICT", "Closed issues cannot be claimed"),
  blocked: {
    code: "CLAIM_BLOCKED",
    message: "forge-1 (open) ",
    retry: "never",
    observed: { blockers: [{ id: "forge-1" }] },
  },
  stale: (f: Fixture) =>
    leased(
      "LEASE_STALE",
      `generation 2 is not the current generation 1 of ${subject}`,
      lease(f),
    ),
  expired: (f: Fixture) =>
    leased(
      "LEASE_EXPIRED",
      `the lease on ${subject} expired at ${lease(f).expiresAt}; a lapsed lease is reacquired, never renewed`,
      lease(f),
    ),
  held: (f: Fixture) => {
    const l = lease(f);
    const who =
      "device laptop, agent fixture, harness unspecified, session fixture";
    const text = `${l.subject} is leased by ${who} until ${l.expiresAt}`;
    const advice = "read its state to reconcile instead of retrying";
    return leased("LEASE_HELD", `${text}; ${advice}`, l);
  },
};
const waiting: Setup = async (f) => {
  await leasedIssue(f);
  setSystemTime(time + ttlMs);
};
const blocking: Setup = async (f) => {
  await fixtureIssue(f);
  await fixtureIssue(f, { ...initial, id: "work-2", dependsOn: ["work-1"] });
};
const closed: Setup = (f) => fixtureIssue(f, { ...initial, status: "closed" });
const second: Setup = (f) => fixtureIssue(f, { ...initial, id: "work-2" });

const wide = "\u{1F600}".repeat(200);
const widest = {
  actor: { kind: "agent", id: wide },
  session: { id: wide, agent: wide, harness: wide },
};
const device = "d".repeat(256);
const wideHolder = { ...widest, session: { ...widest.session, device } };
const sid = "s".repeat(200);
const longId = `forge-${"1".repeat(194)}`;
const named = (body: Json, id: string): Json => ({
  ...body,
  context: {
    ...(body.context as Json),
    ...widest,
    session: { ...widest.session, id },
  },
});
const tokenHolder = {
  ...wideHolder,
  session: { ...wideHolder.session, id: sid },
};
const stale = upd(update.input, { ...update.context, leaseGeneration: 2 });

type Kind = [
  name: string,
  body: Json,
  status: number,
  error: Err | ((f: Fixture) => Err),
  basis: Json,
  setup?: Setup | undefined,
  mode?: Mode | undefined,
  who?: string | undefined,
];
const kinds: Kind[] = [
  ["update graph field", u({ parent: "x" }), 400, E.graph, IN],
  ["update schema violation", upd({ id: "forge-1" }), 400, E.updSchema, IN],
  ["update invalid id", u({ id: "bad" }), 400, E.id, IN],
  ["update unknown prefix", u({ id: "other-1" }), 400, E.prefix, ub("other-1")],
  ["update not found", u({ id: "forge-9" }), 404, E.missing, ub("forge-9")],
  ["update lease not held", u({}), 409, E.noLease, ub("forge-1"), fixtureIssue],
  ["update lease stale", stale, 409, E.stale, ub("forge-1", 1, 2), leasedIssue],
  ["update lease expired", u({}), 409, E.expired, ub("forge-1"), waiting],
  [
    "update revision conflict",
    u({ expectRevision: 2 }),
    409,
    conflict(2),
    ub("forge-1", 2),
    leasedIssue,
  ],
  ["claim invalid input", clm({}), 400, E.clmInput, IN],
  ["claim invalid id", grant("bad"), 400, E.id, IN],
  ["claim unknown prefix", grant("other-1"), 400, E.prefix, cb("other-1")],
  ["claim not found", grant("forge-9"), 404, E.gone(), cb("forge-9")],
  ["claim closed", grant("forge-1"), 409, E.closed, cb("forge-1"), closed],
  ["claim blocked", grant("forge-2"), 409, E.blocked, cb("forge-2"), blocking],
  [
    "claim ttl over 24 hours",
    grant("forge-1", 86_401),
    400,
    E.ttl24,
    cb("forge-1", 86_401),
    fixtureIssue,
  ],
  [
    "claim ttl over token expiry",
    grant("forge-1", 7_201),
    400,
    E.ttlToken,
    cb("forge-1", 7_201),
    fixtureIssue,
  ],
  [
    "claim lease held",
    grant("forge-1"),
    409,
    E.held,
    cb("forge-1"),
    leasedIssue,
  ],
  [
    "create graph field",
    crt({ title: "x", parent: "f-1" }),
    400,
    E.crtGraph,
    IN,
  ],
  ["create schema violation", crt({}), 400, E.crtSchema, IN],
  [
    "create invalid kind",
    crt({ title: "x", kind: "chore" }),
    400,
    E.badKind,
    IN,
  ],
];
const K = (name: string) => kinds.find(([n]) => n === name)!;
const tokenKinds = [
  "update lease not held",
  "update not found",
  "claim lease held",
  "create schema violation",
].map((name): Kind => {
  const [n, body, status, error, basis, setup] = K(name);
  return [n, body, status, error, basis, setup, "token"];
});
const owned = { ...crt({}), context: { actor: widest.actor } };
const pins: Kind[] = [
  [
    "claim by a holder at every schema maximum",
    { ...grant("forge-9"), context: widest },
    404,
    E.gone(),
    { ...cb("forge-9"), holder: wideHolder },
    undefined,
    "owner",
    device,
  ],
  [
    "update by the same holder",
    { ...update, context: { ...widest, leaseGeneration: 1 } },
    409,
    E.noLease,
    { ...ub("forge-1"), holder: wideHolder },
    fixtureIssue,
    "owner",
    device,
  ],
  [
    "update with an expectRevision past the safe integers",
    u({ expectRevision: 2 ** 53 }),
    409,
    conflict(2 ** 53),
    ub("forge-1", 2 ** 53),
    leasedIssue,
  ],
  [
    "claim of a 200-character id",
    grant(longId),
    404,
    E.gone(longId),
    cb(longId),
  ],
  [
    "claim with a ttl of seven days",
    grant("forge-1", 604_800),
    400,
    E.ttl24,
    cb("forge-1", 604_800),
    fixtureIssue,
  ],
  ["create schema refusal in owner mode", owned, 400, E.crtSchema, IN],
  [
    "create schema refusal in token mode",
    owned,
    400,
    E.crtSchema,
    IN,
    undefined,
    "token",
  ],
  [
    "update refusal in token mode at the device and session limits",
    named(u({}), sid),
    409,
    E.noLease,
    { ...ub("forge-1"), holder: tokenHolder },
    fixtureIssue,
    "token",
    device,
  ],
  [
    "claim refusal in token mode at the device and session limits",
    named(grant("forge-9"), sid),
    404,
    E.gone(),
    { ...cb("forge-9"), holder: tokenHolder },
    undefined,
    "token",
    device,
  ],
];

async function lifecycle([
  ,
  body,
  status,
  error,
  basis,
  setup,
  mode = "owner",
  who = "laptop",
]: Kind) {
  const own = who === device ? sid : "fixture";
  const go = (f: Fixture, b: Json = body) => send(f, b, who, own);
  const f = guardFixture(env);
  using _db = f.db;
  await provision(f);
  await enroll(f, mode, who, own);
  await setup?.(f);
  const before = frames(f).length;
  const effects = f.observeEffects();
  const reply = await go(f);
  const seen = effects();
  const expected = typeof error === "function" ? error(f) : error;
  expect(reply).toEqual({ status, body: answer(mode, expected) });
  exited(reply, expected.code);
  expect(seen).toMatchObject({ sqlWriteAttempts: 1, alarmWrites: 0 });
  expect(frames(f)).toHaveLength(before + 1);
  expect(last(f).basis).toEqual(basis);
  const id = idOf(last(f));
  const clash = {
    status: 409,
    body: answer(mode, {
      code: "INPUT_CONFLICT",
      message: "Request ID belongs to a different input",
      retry: "reconcile_first",
    }),
  };
  const replays = async (g: Fixture) => {
    const replay = g.observeEffects();
    expect(await go(g)).toEqual(reply);
    const changed = await go(g, { ...body, input: { changed: true } });
    expect(changed).toEqual(clash);
    exited(changed, "INPUT_CONFLICT");
    expect(replay()).toEqual(noWrites);
  };
  const again = () => replays(f);
  await again();
  f.restart();
  await again();
  await checkpoint(f);
  await again();
  await checkpoint(f);
  f.restart();
  await again();
  const target = guardFixture(env);
  using _target = target.db;
  await restoreAll(target, portableOf(f));
  target.restart();
  if (mode === "token")
    return expect(stored(target, id)).toEqual(stored(f, id));
  await replays(target);
}

const via = "through recovery, checkpoints and restore";
for (const k of [...kinds, ...tokenKinds, ...pins]) {
  const title = `v3 stores the basis of a ${k[0]} refusal and keeps it ${via}`;
  test(`${title} (${k[6] ?? "owner"})`, () => lifecycle(k));
}

const r = (body: Json, requestId: string) => ({ ...body, requestId });
const two = grant("forge-2");
const histories: [string, Setup, Json[], number[]][] = [
  [
    "create, refused update, refused create",
    () => Promise.resolve(),
    [r(create, "a1"), r(update, "a2"), r(crt({}), "a3")],
    [200, 409, 400],
  ],
  [
    "claim refusals and one grant",
    async (f) => {
      await closed(f);
      await second(f);
    },
    [
      r(grant("forge-9"), "b1"),
      r(grant("forge-1"), "b2"),
      r(grant("forge-2", 7_201), "b3"),
      r(two, "b4"),
      r(two, "b5"),
    ],
    [404, 409, 400, 200, 409],
  ],
  [
    "claim blocked by a dependency that holds a lease",
    async (f) => {
      await leasedIssue(f);
      await fixtureIssue(f, {
        ...initial,
        id: "work-2",
        dependsOn: ["work-1"],
      });
    },
    [r(two, "c1")],
    [409],
  ],
];
async function history(
  [, prep, bodies, statuses]: (typeof histories)[number],
  restored: boolean,
) {
  const f = guardFixture(env);
  using _db = f.db;
  await provision(f);
  await prep(f);
  const replies = [];
  for (const body of bodies) replies.push(await send(f, body));
  expect(replies.map(({ status }) => status)).toEqual(statuses);
  await checkpoint(f);
  await checkpoint(f);
  for (const row of JSON.parse(portableOf(f).pages[2]!.body) as Json[]) {
    const status = (row.outcome as Json | undefined)?.status;
    const typed = String(row.operation).startsWith("issue.") && status !== "ok";
    expect(row.basis !== undefined).toBe(typed);
  }
  f.restart();
  const target = guardFixture(env);
  using _target = target.db;
  if (restored) {
    await restoreAll(target, portableOf(f));
    target.restart();
  }
  const same = restored ? target : f;
  const effects = same.observeEffects();
  for (const [i, body] of bodies.entries()) {
    const again = await send(same, body);
    if (restored && statuses[i] === 200 && body.op === "issue.claim") {
      expect(again.status).toBe(409);
      expect(wire(again)).toMatchObject({ code: "LEASE_STALE" });
      exited(again, "LEASE_STALE");
    } else {
      expect(again).toEqual(replies[i]!);
      exited(again, wire(again)?.code);
    }
  }
  expect(effects()).toEqual(noWrites);
}
for (const h of histories) {
  const keeps = "keeps basis in the transcript and replays every request";
  test(`v3 ${keeps} after two checkpoints and cold recovery: ${h[0]}`, () =>
    history(h, false));
  test(`v3 restores the history and replays every request after activation: ${h[0]}`, () =>
    history(h, true));
}

function install(f: Fixture, row: Json, sequence = frames(f).length + 1) {
  const body = canonicalJson({
    ...row,
    format: "forge-cloud-commit/3",
    sequence,
  });
  const mac = f.sign(sequence, body);
  f.db.run("INSERT INTO cloud_v3_commits VALUES (?, ?, ?)", [
    sequence,
    body,
    mac,
  ]);
  f.restart();
}
function retamper(f: Fixture, sequence: number, edit: (row: Json) => void) {
  const row = frames(f)[sequence - 1]!;
  edit(row);
  const body = canonicalJson(row);
  const mac = f.sign(sequence, body);
  f.db.run("UPDATE cloud_v3_commits SET body=?, mac=? WHERE sequence=?", [
    body,
    mac,
    sequence,
  ]);
  f.restart();
}
function forge(data: Portable, id: string, { result, frame }: Edit) {
  const [directory, snapshot, transcript] = data.pages as [
    Portable["pages"][number],
    Portable["pages"][number],
    Portable["pages"][number],
  ];
  const history = JSON.parse(transcript.body) as Json[];
  const row = history.find((e) => (e.outcome as Json | undefined)?.id === id)!;
  frame?.(row);
  if (result) {
    const entries = JSON.parse(directory.body) as Json[];
    const bytes = Buffer.from(snapshot.body);
    const parts = entries.map((e) =>
      e.offset === undefined
        ? ""
        : bytes
            .subarray(
              e.offset as number,
              (e.offset as number) + (e.length as number),
            )
            .toString(),
    );
    const at = entries.findIndex(
      (e) => e.collection === "outcome" && e.key === id,
    );
    const saved = JSON.parse(parts[at]!) as { outcome: { result: Json } };
    result(saved.outcome.result);
    parts[at] = canonicalJson(saved);
    (row.outcome as Json).resultDigest = digestBytes(
      canonicalJson(saved.outcome.result),
    );
    let offset = 0;
    for (const [i, entry] of entries.entries()) {
      if (entry.deleted) continue;
      const length = Buffer.byteLength(parts[i]!);
      Object.assign(entry, { offset, length, digest: digestBytes(parts[i]!) });
      offset += length;
    }
    snapshot.body = parts.join("");
    directory.body = canonicalJson(entries);
    const leaf = ({ revision, digest }: Json) =>
      revision === undefined
        ? (digest ?? null)
        : digestBytes(canonicalJson([revision, digest ?? null]));
    data.publicDigest = digestBytes(
      canonicalJson(entries.map((e) => [e.collection, e.key, leaf(e)])),
    );
  }
  transcript.body = canonicalJson(history);
}
function rewritePages(f: Fixture, id: string, edit: Edit) {
  const data = portableOf(f);
  forge(data, id, edit);
  const root = JSON.parse(
    f.db.query<{ body: string }, []>("SELECT body FROM cloud_v3_root").get()!
      .body,
  ) as Json;
  const listed = root.pages as Json[];
  for (const entry of listed) {
    const body = data.pages.find(({ id: page }) => page === entry.id)!.body;
    Object.assign(entry, {
      bytes: Buffer.byteLength(body),
      hash: digestBytes(body),
    });
  }
  root.bytes = Object.fromEntries(listed.map((e) => [String(e.kind), e.bytes]));
  root.transcriptDigest = digestBytes(data.pages[2]!.body);
  root.publicDigest = data.publicDigest;
  for (const { id: page, body } of data.pages)
    f.db.run("UPDATE cloud_v3_pages SET body=? WHERE id=?", [body, page]);
  const body = canonicalJson(root);
  f.db.run("UPDATE cloud_v3_root SET body=?, seal=? WHERE id=1", [
    body,
    trustedSeal(f.db, body),
  ]);
  f.restart();
}
const tail =
  ({ result, frame }: Edit) =>
  (row: Json) => {
    frame?.(row);
    result?.((row.outcome as Json).result as Json);
  };

async function honest([, body, status, , basis, setup]: Kind, extra?: Setup) {
  const f = guardFixture(env);
  await provision(f);
  await setup?.(f);
  await extra?.(f);
  expect((await send(f, body)).status).toBe(status);
  expect(last(f).basis).toEqual(basis);
  return { f, id: idOf(last(f)), sequence: frames(f).length };
}
const reach = (f: Fixture, place: Place) =>
  place === "cold" ? f.send(probe) : f.send(checkpointRoute, {});
async function rejects(
  f: Fixture,
  request: () => Promise<{ status: number; body: unknown }>,
  expected = unavailable,
) {
  const before = f.snapshot();
  const effects = f.observeEffects();
  const reply = await request();
  expect(reply).toEqual(expected);
  exited(reply, expected.body.error.code);
  expect(effects()).toEqual(noWrites);
  expect(f.snapshot()).toEqual(before);
}
async function tampered(name: string, edit: Edit, place: Place, extra?: Setup) {
  const { f, id, sequence } = await honest(K(name), extra);
  using _db = f.db;
  if (place === "portable") {
    await checkpoint(f);
    const data = portableOf(f);
    forge(data, id, edit);
    const target = guardFixture(env);
    using _target = target.db;
    await refusedRestore(target, data);
    return;
  }
  retamper(f, sequence, tail(edit));
  await rejects(f, () => reach(f, place));
}
const message: Edit = {
  result: (x) => Object.assign(x, { message: "Edited message" }),
};
const places: Place[] = ["cold", "checkpoint", "portable"];
const stateEdits: [string, string, Edit, Setup?][] = [
  ["a claim LEASE_HELD message", "claim lease held", message],
  [
    "a claim LEASE_HELD generation",
    "claim lease held",
    { result: (x) => Object.assign(x.lease as Json, { generation: 2 }) },
  ],
  [
    "a claim basis whose claim would be granted",
    "claim not found",
    { frame: (row) => Object.assign(row.basis as Json, { id: "forge-2" }) },
    second,
  ],
  [
    "an update REVISION_CONFLICT currentRevision",
    "update revision conflict",
    { result: (x) => Object.assign(x, { currentRevision: 2 }) },
  ],
  [
    "an update NOT_FOUND basis naming a held record",
    "update not found",
    { frame: (row) => Object.assign(row.basis as Json, { id: "forge-1" }) },
    leasedIssue,
  ],
];
for (const [label, name, edit, extra] of stateEdits)
  for (const place of places)
    test(`v3 refuses ${label} edited in the ${place} path`, () =>
      tampered(name, edit, place, extra));
for (const name of [
  "create graph field",
  "update schema violation",
  "claim invalid input",
])
  for (const place of ["cold", "portable"] as Place[])
    test(`v3 refuses a ${name} refusal whose message is outside its list in the ${place} path`, () =>
      tampered(name, message, place));

for (const name of ["update not found", "claim not found"])
  test(`v3 refuses an edited ${name} refusal inside a checkpointed and re-signed transcript`, async () => {
    const { f, id } = await honest(K(name));
    using _db = f.db;
    await checkpoint(f);
    rewritePages(f, id, message);
    await rejects(f, () => f.send(probe));
  });
test("v3 refuses an edited refusal inside the transcript of an activated restore", async () => {
  const { f, id } = await honest(K("claim not found"));
  using _db = f.db;
  await checkpoint(f);
  const target = guardFixture(env);
  using _target = target.db;
  await restoreAll(target, portableOf(f));
  rewritePages(target, id, message);
  await rejects(target, () => target.send(probe));
});

const refusal = (
  op: string,
  requestId: string,
  error: object,
  basis?: unknown,
  who = "laptop",
  input: object = { requestId },
  mode: Json = { leaseMode: "acquire" },
): Json => {
  const principal = ["owner", who, who] as const;
  const context = {
    variant: "leased",
    actor,
    session: { ...session, device: who },
    project: { id: "a" },
    ...mode,
  };
  const receipt = prepareReceipt("command", principal, requestId, {
    op,
    input,
    context,
    device: who,
  });
  return {
    operation: op,
    time,
    events: [],
    outcome: {
      id: receipt.requestId,
      fingerprint: receipt.fingerprint,
      scope: { family: "command", ...receiptScope(principal) },
      status: (error as Err).code,
      result: error,
      retryUntil: expiry,
    },
    ...(basis === undefined ? {} : { basis }),
  };
};
const appendTo = (f: Fixture, ...rows: Json[]) => {
  const { db, image } = imageOf(f);
  return append(db, f.seal(), image, rows);
};
function refuses(f: Fixture, text: string | undefined, ...rows: Json[]) {
  const before = f.snapshot();
  const effects = f.observeEffects();
  expect(() => appendTo(f, ...rows)).toThrow(text);
  expect(effects()).toEqual(noWrites);
  expect(f.snapshot()).toEqual(before);
}
const claimGone = (id: string, basis?: unknown) =>
  refusal("issue.claim", id, E.gone(), basis);
const updateGone = (id: string, basis?: unknown) =>
  refusal("issue.update", id, E.missing, basis);
const noBasis = "Refusing a v3 frame with an invalid basis";
const noRefusal = "Refusing a v3 frame with an invalid refusal";

for (const [op, name] of [
  ["create", "create graph field"],
  ["update", "update not found"],
  ["claim", "claim not found"],
] as const) {
  test(`v3 append refuses a ${op} refusal that has no basis`, async () => {
    const { f } = await honest(K(name));
    using _db = f.db;
    const bare: Json = {
      ...last(f),
      outcome: { ...(last(f).outcome as Json), id: `c2:${"a".repeat(64)}` },
    };
    delete bare.basis;
    refuses(f, noBasis, bare);
  });
  test(`v3 cold recovery refuses a ${op} refusal that has no basis in the tail`, async () => {
    const { f, sequence } = await honest(K(name));
    using _db = f.db;
    retamper(f, sequence, (row) => delete row.basis);
    await rejects(f, () => f.send(probe));
  });
  test(`v3 cold recovery refuses a ${op} refusal that has no basis in a checkpointed transcript`, async () => {
    const { f, id } = await honest(K(name));
    using _db = f.db;
    await checkpoint(f);
    rewritePages(f, id, { frame: (row) => delete row.basis });
    await rejects(f, () => f.send(probe));
  });
}

const longDevice = "d".repeat(257);
const olds = [
  [
    "claim",
    "issue.claim",
    grant("forge-1").input,
    bad("Invalid lease"),
    { leaseMode: "acquire" },
  ],
  [
    "update",
    "issue.update",
    { ...update.input, id: "forge-9" },
    E.missing,
    { leaseMode: "held", leaseGeneration: 1 },
  ],
] as const;
for (const [name, op, input, result, mode] of olds)
  for (const place of ["append", "cold", "checkpoint"] as const)
    test(`v3 refuses an old ${name} refusal from an over-long holder with no basis: ${place}`, async () => {
      const f = guardFixture(env);
      using _db = f.db;
      await provision(f);
      if (name === "claim") await fixtureIssue(f);
      const row = refusal(
        op,
        `old-${name}`,
        result,
        undefined,
        longDevice,
        input,
        mode,
      );
      if (place === "append") return refuses(f, noBasis, row);
      install(f, row);
      await rejects(f, () => reach(f, place));
    });

const malformed: [string, "claim" | "update", Json, boolean?][] = [
  ["an extra key", "claim", { ...cb("forge-9"), extra: 1 }],
  ["a raw input field", "update", { ...ub("forge-9"), title: "After" }],
  [
    "a wrong type in a member",
    "update",
    { ...ub("forge-9"), expectRevision: "1" },
  ],
  [
    "an over-bound string",
    "claim",
    { ...cb("forge-9"), id: `forge-${"1".repeat(195)}` },
  ],
  [
    "a device of 257 characters",
    "claim",
    state(
      "forge-9",
      { ttlMs: 60_000 },
      { actor, session: { ...session, device: longDevice } },
    ),
  ],
  ["an expectRevision of 0", "update", ub("forge-9", 0), false],
  [
    "a ttlMs that is not a whole second",
    "claim",
    { ...cb("forge-9"), ttlMs: 1_500 },
    false,
  ],
];
for (const [name, op, wrong, both] of malformed)
  for (const place of ["append", "cold"] as const) {
    if (place === "cold" && both === false) continue;
    test(`v3 refuses a refusal whose basis has ${name}: ${place}`, async () => {
      const f = guardFixture(env);
      using _db = f.db;
      await provision(f);
      const make = op === "claim" ? claimGone : updateGone;
      const good = make("good", op === "claim" ? cb("forge-9") : ub("forge-9"));
      if (place === "append") {
        expect(() => appendTo(f, good)).not.toThrow();
        return refuses(f, noRefusal, make("bad", wrong));
      }
      install(f, good);
      expect((await f.send(probe)).status).toBe(200);
      f.db.run("DELETE FROM cloud_v3_commits");
      install(f, make("bad", wrong), 1);
      await rejects(f, () => f.send(probe));
    });
  }

const oks: [string, Json, Setup?][] = [
  ["create", create],
  ["update", update, leasedIssue],
  ["claim", typedClaim, fixtureIssue],
];
for (const [op, body, setup] of oks) {
  const attach = (row: Json) => Object.assign(row, { basis: IN });
  const written = async () => {
    const f = guardFixture(env);
    await provision(f);
    await setup?.(f);
    expect((await send(f, body)).status).toBe(200);
    expect(last(f)).toMatchObject({
      operation: body.op,
      outcome: { status: "ok" },
    });
    return f;
  };
  test(`v3 append refuses an ok ${op} frame that carries a basis`, async () => {
    const f = await written();
    using _db = f.db;
    refuses(f, noBasis, attach({ ...last(f) }));
  });
  test(`v3 cold recovery refuses an ok ${op} frame that carries a basis`, async () => {
    const f = await written();
    using _db = f.db;
    retamper(f, frames(f).length, attach);
    await rejects(f, () => f.send(probe));
  });
}

const lone = (id: string, error: object) =>
  refusal("issue.claim", id, error, cb("forge-1"));
const unfollowed: [string, (f: Fixture) => Json, Setup?][] = [
  [
    "an update LEASE_NOT_HELD while the holder holds the lease",
    () => refusal("issue.update", "u1", E.noLease, ub("forge-1")),
    leasedIssue,
  ],
  [
    "an update NOT_FOUND while the record exists",
    () => updateGone("u2", ub("forge-1")),
    leasedIssue,
  ],
  [
    "a claim state basis that claimEffect grants",
    () => lone("c1", leased("LEASE_HELD", "held", { subject })),
    fixtureIssue,
  ],
  [
    "a claim refusal while a witness exists for its request id",
    (f) => lone("w", E.held(f)),
    async (f) => {
      await fixtureIssue(f);
      await send(f, { ...typedClaim, requestId: "w" });
    },
  ],
  [
    "a create refusal whose text is outside the list",
    () => refusal("issue.create", "x1", bad("Another message"), IN),
  ],
  ["an input basis carrying a state error", () => claimGone("x2", IN)],
  [
    "a state basis carrying an input-list error",
    () => refusal("issue.claim", "x3", E.clmInput, cb("forge-9")),
  ],
];
for (const [name, candidate, setup] of unfollowed)
  test(`v3 append refuses ${name}`, async () => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    await setup?.(f);
    refuses(f, noRefusal, candidate(f));
  });
test("v3 append refuses a valid refusal at batch index 1", async () => {
  const f = guardFixture(env);
  using _db = f.db;
  await provision(f);
  const note = { operation: "fixture.note", time, events: [] };
  refuses(f, noRefusal, note, claimGone("y1", cb("forge-9")));
});

const witnessed = [
  ["structurally invalid input", {}, IN, E.clmInput],
  ["an invalid id shape", { id: "bad", ttlSeconds: 60 }, IN, E.id],
  [
    "an unknown prefix",
    { id: "other-1", ttlSeconds: 60 },
    cb("other-1"),
    E.prefix,
  ],
] as const;
for (const [name, input, basis, error] of witnessed)
  test(`v3 records a refusal for ${name} while the claim witness for its request id exists`, async () => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    await fixtureIssue(f);
    expect((await send(f, typedClaim)).status).toBe(200);
    setSystemTime(expiry + 1);
    const reply = await f.send(
      `${probe}/command`,
      { ...typedClaim, input },
      owner("laptop", expiry + 1 + 2 * ttlMs),
    );
    expect(reply).toEqual({ status: 400, body: { ok: false, error } });
    exited(reply, "INPUT_INVALID");
    expect(last(f).basis).toEqual(basis);
    f.restart();
    expect((await f.send(probe)).status).toBe(200);
    await checkpoint(f);
  });
