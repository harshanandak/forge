import { expect, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { Dump } from "../../cloud/src/dump.ts";
import { PAGE_FORMAT } from "../../cloud/src/dump.ts";
import { Project } from "../../cloud/src/project.ts";
import { TABLE_PROBE, type DurableStorage } from "../../cloud/src/store.ts";
import { TOKEN_LOOKUP } from "../../cloud/src/tokens.ts";
import { createWorker } from "../../cloud/src/worker.ts";
import { createSqliteStore } from "../../src/adapters/store-sqlite/index.ts";
import { StateOwner } from "../../src/core/state/index.ts";
import type {
  ForgeError,
  LeaseHolder,
  LeaseRecord,
  StateEvent,
} from "../../src/generated/types.ts";
import { OLD_SCHEMA } from "./old-schema.ts";

if (!("timingSafeEqual" in crypto.subtle))
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    value: crypto.timingSafeEqual.bind(crypto),
  });
await mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
const { createConfiguredWorker } =
  await import("../../cloud/src/adapters/workers-oauth/compose.ts");
const now = 1_800_000_000_000,
  day = 86_400_000,
  minute = 60_000;
const holder = (device = "phone", session = device): LeaseHolder => ({
  actor: { kind: "agent", id: "builder" },
  session: { id: session, device },
});
type Device = { id: string; token: string; device: string };
type Via = "direct" | "worker" | "configured";
const defaults = {
  subject: "issue",
  holder: holder(),
  generation: 1,
  ttlMs: minute,
};
function fixture(env?: unknown) {
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const db = new Database(":memory:"),
    values = new Map<string, unknown>(),
    // Every statement, transaction and key-value call, so setup or a stray read shows even when no row changes.
    calls: string[] = [];
  let failRelease = false;
  let failRestoredRelease = false;
  let claimNumber = 0;
  const storage: DurableStorage = {
    sql: {
      exec: (sql, ...bindings) => {
        calls.push(sql);
        if (
          (failRelease ||
            (failRestoredRelease &&
              bindings.some(
                (v) => typeof v === "string" && v.includes(":lease.released@1"),
              ))) &&
          sql.startsWith("INSERT INTO state_events")
        )
          throw new Error("injected event failure");
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
    transactionSync: (body) => {
      calls.push("transaction");
      return db.transaction(body)();
    },
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
  const bindings = {
    PROJECTS: { idFromName: (name: string) => name, get: () => project },
  };
  async function send(
    route: string,
    input?: unknown,
    token = "owner",
    expiry = now + 2 * day,
  ) {
    const headers =
      token === "owner"
        ? { "X-Forge-Owner": "phone", "X-Forge-Owner-Expires": String(expiry) }
        : { authorization: `Bearer ${token}` };
    const response = await project.fetch(
      new Request(`https://fixture.example/p/a/${route}`, {
        method: input === undefined ? "GET" : "POST",
        headers,
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      }),
    );
    return {
      status: response.status,
      body: (await response.json()) as { value: unknown; error?: ForgeError },
    };
  }
  // One request to /p/a/<route>, straight to the Project or through a real Worker; the calls it made come back.
  async function raw(
    route: string,
    input: unknown,
    headers: Record<string, string>,
    via: Via = "direct",
  ) {
    const request = new Request(`https://fixture.example/p/a/${route}`, {
      method: input === undefined ? "GET" : "POST",
      headers,
      ...(input === undefined
        ? {}
        : {
            body:
              input instanceof ReadableStream ? input : JSON.stringify(input),
            duplex: "half",
          }),
    });
    calls.length = 0;
    const response =
      via === "direct"
        ? await project.fetch(request)
        : await (
            via === "worker" ? createWorker() : createConfiguredWorker()
          ).fetch(request, bindings);
    return {
      status: response.status,
      body: (await response.json()) as { value: unknown; error?: ForgeError },
      calls: [...calls],
    };
  }
  const write = (
    route: string,
    input: Record<string, unknown>,
    token: string,
    expiry?: number,
  ) => send(route, { ...defaults, requestId: route, ...input }, token, expiry);
  const issue = async (device = "phone", session: string | null = device) => {
    const reply = await send("devices", {
      device,
      ...(session === null ? {} : { session }),
      ttlMs: 2 * day,
    });
    expect(reply.status).toBe(200);
    return reply.body.value as Device;
  };
  const claim = async (
    subject: string,
    device: Device,
    session = device.device,
  ) => {
    const input = {
      subject,
      holder: holder(device.device, session),
      requestId: `${subject}:${device.device}:${++claimNumber}`,
    };
    const reply = await write("claim", input, device.token);
    expect(reply.status).toBe(200);
    return reply.body.value as LeaseRecord;
  };
  const lookup = async (subject = "issue") =>
    (await send(`holder?subject=${subject}`)).body.value as LeaseRecord | null;
  const row = (sql: string, id: string) => db.query(sql).get(id);
  const rows = (table: string) =>
    db.query(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
  // Schema definitions, every row (ledgers included) and the key-value entries, read straight from the fixture.
  const snapshot = () => {
    const schema = db
      .query("SELECT type, name, sql FROM sqlite_schema ORDER BY 1, 2")
      .all() as { type: string; name: string }[];
    const tables = schema.filter((s) => s.type === "table");
    return JSON.stringify([
      schema,
      tables.map((t) => rows(t.name)),
      [...values],
    ]);
  };
  return {
    db,
    storage,
    calls,
    raw,
    snapshot,
    // A new Project over the same storage: nothing it has not read is set up.
    reopen: () => {
      project = new Project({ storage });
    },
    // The object as an older deploy left it.
    cold: () => {
      for (const sql of OLD_SCHEMA) db.run(sql);
      project = new Project({ storage });
    },
    send,
    write,
    issue,
    claim,
    lookup,
    clock,
    row,
    rows,
    revoke: (device: Device) => send("revoke", { id: device.id }),
    failRestore: () => {
      failRestoredRelease = true;
    },
    fail: () => {
      failRelease = true;
    },
    [Symbol.dispose]: () => {
      db.close();
      clock.mockRestore();
    },
  };
}

for (const route of ["claim", "renew"])
  for (const auth of ["device", "owner"]) {
    test(`${auth} ${route} enforces both limits, exact boundaries and refusal replay`, async () => {
      using f = fixture();
      const device = await f.issue(),
        token = auth === "device" ? device.token : "owner";
      for (const limit of [day, 10 * minute]) {
        const expiry = now + (limit === day ? 2 * day : limit),
          subject = `issue:${limit}`;
        f.db.run("UPDATE domain_cloud_tokens SET expires_at=? WHERE id=?", [
          expiry,
          device.id,
        ]);
        const send = (operation: string, ttlMs: unknown, requestId: string) =>
          f.write(operation, { subject, ttlMs, requestId }, token, expiry);
        if (route === "renew")
          expect((await send("claim", minute, `seed-${limit}`)).status).toBe(
            200,
          );
        const before = await f.lookup(subject),
          requestId = `${route}-${limit}`;
        const priorIds = new Set(
          f.rows("domain_cloud_requests").map((r) => r.request_id),
        );
        const refused = await send(route, limit + 1, requestId);
        expect(refused.status).toBe(400);
        expect(refused.body.error?.code).toBe("INPUT_INVALID");
        expect(refused.body.error?.message).toMatch(
          limit === day
            ? /24\s*(?:hours?|h)|86400000/i
            : /token.*expir|expir.*token/i,
        );
        expect(await f.lookup(subject)).toEqual(before);
        expect(
          f
            .rows("domain_cloud_requests")
            .filter((r) => !priorIds.has(r.request_id))
            .map((r) => r.outcome),
        ).toEqual(["INPUT_INVALID"]);
        f.clock.mockReturnValue(now + 1);
        expect(await send(route, limit + 1, requestId)).toEqual(refused);
        f.clock.mockReturnValue(now);
        const accepted = await send(route, limit, `boundary-${limit}`);
        expect(accepted.status).toBe(200);
        expect(accepted.body.value).toMatchObject({
          expiresAt: new Date(now + limit).toISOString(),
        });
        for (const ttlMs of [0, -1, 1.5, "60000"]) {
          const invalid = await send(route, ttlMs, `bad-${limit}-${ttlMs}`);
          expect(invalid.status).toBe(400);
          expect(invalid.body.error?.code).toBe("INPUT_INVALID");
          expect(await f.lookup(subject)).toEqual(
            accepted.body.value as LeaseRecord,
          );
        }
      }
    }, 30_000);
  }
const SESSION_REFUSAL = "The request names a session other than the token's";
for (const route of ["claim", "renew", "release"])
  test(`a session-bound token cannot ${route} as another session, on a first write or a replay`, async () => {
    using f = fixture();
    const s1 = await f.issue("phone", "s1"),
      s2 = await f.issue("phone", "s2");
    const held = await f.claim("issue:held", s1, "s1"),
      subject = route === "claim" ? "issue:free" : "issue:held";
    const as = (session: string, requestId: string) => ({
      subject,
      holder: holder("phone", session),
      generation: held.generation,
      ttlMs: minute,
      requestId,
    });
    const state = () => [
      f.rows("state_leases"),
      f.rows("state_events"),
      f.rows("domain_cloud_requests"),
    ];
    const refused = async (requestId: string) => {
      const reply = await f.write(route, as("s1", requestId), s2.token);
      expect([
        reply.status,
        reply.body.error?.code,
        reply.body.error?.message,
      ]).toEqual([403, "AUTH_DEVICE_MISMATCH", SESSION_REFUSAL]);
    };
    const before = state();
    await refused("shared-id");
    expect(state()).toEqual(before);
    // The refusal recorded nothing, so the honest request may reuse the id.
    const honest = await f.write(route, as("s1", "shared-id"), s1.token);
    expect(honest.status).toBe(200);
    // A replay by the other session's token is refused, never answered from the receipt.
    const after = state();
    expect(after).not.toEqual(before);
    await refused("shared-id");
    expect(state()).toEqual(after);
  }, 30_000);
test("a sessionless device token keeps the device as its boundary on the raw lease routes", async () => {
  using f = fixture();
  const bare = await f.issue("phone", null);
  for (const session of ["s1", "s2"]) {
    const reply = await f.write(
      "claim",
      {
        subject: `issue:${session}`,
        holder: holder("phone", session),
        requestId: `bare-${session}`,
      },
      bare.token,
    );
    expect(reply.status).toBe(200);
  }
}, 30_000);
test("revoke releases matching leases, records releases and preserves other holders", async () => {
  using f = fixture();
  const phone = await f.issue(),
    laptop = await f.issue("laptop");
  const otherSession = await f.issue("phone", "other");
  await f.claim("issue:revoke-1", phone);
  await f.claim("issue:revoke-2", phone);
  const before = await f.claim("issue:other", laptop);
  const session = await f.claim("issue:session", otherSession, "other");
  const revoked = await f.revoke(phone);
  expect(revoked.status).toBe(200);
  expect(revoked.body.value).toMatchObject({
    released: ["issue:revoke-1", "issue:revoke-2"],
  });
  for (const subject of ["issue:revoke-1", "issue:revoke-2"])
    expect(await f.lookup(subject)).toMatchObject({
      releasedAt: new Date(now).toISOString(),
    });
  const releases = f
    .rows("state_events")
    .filter((row) => String(row.body).includes("lease.released@1"));
  expect(releases).toHaveLength(2);
  expect(await f.lookup("issue:other")).toEqual(before);
  expect(await f.lookup("issue:session")).toEqual(session);
  const next = await f.claim("issue:revoke-1", laptop);
  expect(next).toMatchObject({ generation: 2, holder: holder("laptop") });
  const repeated = await f.revoke(phone);
  expect(repeated.status).toBe(200);
  expect(repeated.body.value).toMatchObject({
    device: "phone",
    session: "phone",
  });
  expect(
    (repeated.body.value as { released?: string[] }).released ?? [],
  ).toEqual([]);
  expect(await f.lookup("issue:revoke-1")).toEqual(next);
  const unknown = await f.send("revoke", { id: "unknown" });
  expect(unknown.status).toBe(400);
  expect(unknown.body.error?.code).toBe("INPUT_INVALID");
  expect(await f.lookup("issue:other")).toEqual(before);
}, 30_000);

for (const session of ["phone", null]) {
  test(`revoke preserves a valid sibling, excludes expired or revoked siblings (session ${session})`, async () => {
    using f = fixture();
    const first = await f.issue("phone", session),
      second = await f.issue("phone", session);
    const expired = await f.issue("phone", session),
      revoked = await f.issue("phone", session);
    await f.revoke(revoked);
    f.db.run("UPDATE domain_cloud_tokens SET expires_at=? WHERE id=?", [
      now,
      expired.id,
    ]);
    // A token bound to a session claims only as it, so another session's lease needs its own token.
    const before = await f.claim("issue:phone", first);
    await f.claim(
      "issue:other",
      session === null ? first : await f.issue("phone", "other"),
      "other",
    );
    const reply = await f.revoke(first);
    expect(reply.status).toBe(200);
    expect(reply.body.value).toMatchObject({ released: [] });
    expect(await f.lookup("issue:phone")).toEqual(before);
    const last = await f.revoke(second);
    expect(last.status).toBe(200);
    expect(last.body.value).toMatchObject({
      released:
        session === null ? ["issue:other", "issue:phone"] : ["issue:phone"],
    });
  }, 30_000);
}

test("a release event failure rolls revocation and lease releases back together", async () => {
  using f = fixture();
  const phone = await f.issue();
  const before = await f.claim("issue:atomic", phone);
  f.fail();
  expect((await f.revoke(phone)).status).toBe(500);
  expect(
    f.row("SELECT revoked_at FROM domain_cloud_tokens WHERE id=?", phone.id),
  ).toEqual({ revoked_at: null });
  expect(await f.lookup("issue:atomic")).toEqual(before);
  expect(
    (await f.send("holder?subject=issue:atomic", undefined, phone.token))
      .status,
  ).toBe(200);
}, 30_000);

for (const route of ["acquire", "renew"]) {
  test(`core ${route} refuses Date overflow without writing`, async () => {
    const opened = await createSqliteStore(import.meta.dirname).open({
      path: ":memory:",
      readOnly: false,
    });
    if (!opened.ok) throw new Error(opened.unavailable.reason);
    const db = opened.handle.value;
    await using f = {
      rows: (table: string) => db.all(`SELECT * FROM ${table}`),
      [Symbol.asyncDispose]: () => opened.handle.close(),
    };
    const owner = new StateOwner(db, { now: () => now });
    owner.initialize();
    const ns = "forge/work",
      subject = "issue",
      held = holder(),
      duration = 8_640_000_000_000_001 - now;
    if (route === "renew") owner.acquire(ns, subject, held, minute, "seed");
    const tables = ["state_leases", "state_events", "state_requests"],
      before = tables.map(f.rows);
    const write = () =>
      route === "acquire"
        ? owner.acquire(ns, subject, held, duration, "date")
        : owner.renew(ns, { subject, holder: held, generation: 1 }, duration);
    let code: string | undefined;
    try {
      write();
    } catch (error) {
      code = (error as { error?: ForgeError }).error?.code;
    }
    expect(code).toBe("INPUT_INVALID");
    expect(tables.map(f.rows)).toEqual(before);
  }, 30_000);
}

test("whole and paged restores preserve a refusal while a replacement token records its own refusal", async () => {
  for (const route of ["dump", "dump?cursor=start"]) {
    using source = fixture();
    const phone = await source.issue();
    const input = { ttlMs: day + 1, requestId: "oversized" };
    const refused = await source.write("claim", input, phone.token);
    expect(refused.status).toBe(400);
    expect(refused.body.error?.code).toBe("INPUT_INVALID");
    const dump = await source.send(route);
    expect(dump.status).toBe(200);
    using target = fixture();
    const restored = await target.send("restore", dump.body.value);
    expect(restored.status).toBe(200);
    expect(target.rows("domain_cloud_requests")).toEqual(
      source.rows("domain_cloud_requests"),
    );
    const token = (await target.issue()).token;
    expect(await target.write("claim", input, token)).toEqual(refused);
    const after = target.rows("domain_cloud_requests");
    expect(after).toHaveLength(source.rows("domain_cloud_requests").length + 1);
    for (const row of source.rows("domain_cloud_requests"))
      expect(after).toContainEqual(row);
    expect(await target.write("claim", input, token)).toEqual(refused);
    expect(target.rows("domain_cloud_requests")).toEqual(after);
  }
}, 30_000);

// A cold object is an older deploy's database, opened afresh. A refused credential or a holder read must
// set nothing up: the recorded calls stand beside the snapshot, so an idempotent CREATE fails too.
type Fixture = ReturnType<typeof fixture>;
const INVENTED = `fct_0123456789abcdef.${"A".repeat(43)}`;
const FORGED = { "X-Forge-Owner": "phone", "X-Forge-Owner-Expires": "9e12" };
const ROUTES = ["holder?subject=issue", "claim", "renew", "release"];
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const PROVISIONED = "get provisioned";
const TOKEN_READS = [PROVISIONED, TABLE_PROBE, TOKEN_LOOKUP];
const LEASE_READS = [
  ...TOKEN_READS,
  "SELECT body FROM state_leases WHERE namespace=? AND subject=?",
];
// What a request did: status, error code or value, calls beyond `allowed`, and whether storage changed.
const outcome = (
  f: Fixture,
  was: string,
  got: Awaited<ReturnType<Fixture["raw"]>>,
  allowed = TOKEN_READS,
) => [
  got.status,
  got.body.error?.code ?? got.body.value,
  got.calls.filter((sql) => !allowed.includes(sql)),
  f.snapshot() === was,
];
// Every route, each on a fresh Project, is refused with `code`; only `allowed` reads run and nothing changes.
async function refused(
  f: Fixture,
  name: string,
  headers: Record<string, string>,
  vias: readonly Via[],
  code: string,
  allowed = TOKEN_READS,
) {
  const was = f.snapshot();
  for (const route of ROUTES)
    for (const via of vias) {
      f.reopen();
      const body =
        route === ROUTES[0] ? undefined : { ...defaults, requestId: "c" };
      const got = await f.raw(route, body, headers, via);
      const done = [name, route, via, ...outcome(f, was, got, allowed)];
      expect(done).toEqual([name, route, via, 401, code, [], true]);
    }
}
const set = (column: string) =>
  `UPDATE domain_cloud_tokens SET ${column}=? WHERE id=?`;
const own = (d: Device) => d.token;
const wrong = (d: Device) => `${d.token.slice(0, 21)}${"B".repeat(43)}`;
const REFUSED: [string, (d: Device) => string, string, string][] = [
  ["an invented id", () => INVENTED, "", "AUTH_INVALID"],
  ["a wrong secret", wrong, "", "AUTH_INVALID"],
  ["a revoked token", own, set("revoked_at"), "AUTH_REVOKED"],
  ["a token expiring now", own, set("expires_at"), "AUTH_EXPIRED"],
  ["no token table", own, "DROP TABLE domain_cloud_tokens", "AUTH_INVALID"],
];

test("a refused device token never sets up a cold object on any raw route, direct or through the Worker", async () => {
  for (const [name, token, change, code] of REFUSED) {
    using f = fixture();
    const device = await f.issue();
    if (change !== "")
      f.db.run(change, change.includes("?") ? [now, device.id] : []);
    f.cold();
    const via = ["direct", "worker"] as const;
    await refused(f, name, bearer(token(device)), via, code);
  }
}, 60_000);

test("an unprovisioned object runs no SQL on any raw route, a staged restore and an owner read included", async () => {
  using f = fixture();
  await f.storage.put("restore:next", 1);
  const via = ["direct", "worker"] as const;
  await refused(f, "unprovisioned", bearer(INVENTED), via, "AUTH_INVALID", [
    PROVISIONED,
  ]);
  const was = f.snapshot();
  f.reopen();
  const owner = await f.raw("holder?subject=issue", undefined, FORGED);
  expect(outcome(f, was, owner, [PROVISIONED])).toEqual([200, null, [], true]);
}, 30_000);

test("a missing bearer or forged owner headers grant nothing and set nothing up on a cold object", async () => {
  using f = fixture();
  await f.issue();
  f.cold();
  const via = ["worker", "configured"] as const;
  const forged = { ...FORGED, ...bearer(INVENTED) };
  await refused(f, "no credential", {}, via, "AUTH_REQUIRED");
  await refused(f, "forged owner", FORGED, via, "AUTH_REQUIRED");
  await refused(f, "forged owner, bad token", forged, via, "AUTH_INVALID");
}, 30_000);

test("a credential lost while the body streams ends a raw write before any setup", async () => {
  for (const fault of ["revoked_at", "expires_at"])
    for (const route of ["claim", "renew", "release"]) {
      using f = fixture();
      const device = await f.issue();
      f.cold();
      const text = JSON.stringify({ ...defaults, requestId: "stream" });
      const seen = { lookups: 0, after: "" };
      // The fault lands when the second chunk is pulled: after the first check, before the second.
      const body = new ReadableStream({
        start: (c) => c.enqueue(new TextEncoder().encode(text.slice(0, 9))),
        pull(c) {
          seen.lookups = f.calls.filter((sql) => sql === TOKEN_LOOKUP).length;
          f.db.run(set(fault), [now, device.id]);
          seen.after = f.snapshot();
          c.enqueue(new TextEncoder().encode(text.slice(9)));
          c.close();
        },
      });
      const got = await f.raw(route, body, bearer(device.token));
      // The first check passed and the body was read; the fault is the only change since.
      const code = fault === "revoked_at" ? "AUTH_REVOKED" : "AUTH_EXPIRED";
      const done = [fault, route, seen.lookups, ...outcome(f, seen.after, got)];
      expect(done).toEqual([fault, route, 1, 401, code, [], true]);
    }
}, 60_000);

test("a holder read on a cold object returns the stored lease, or null, and sets nothing up", async () => {
  using f = fixture();
  const phone = await f.issue();
  await f.claim("issue:expired", phone);
  await f.claim("issue:done", phone);
  const done = { subject: "issue:done", requestId: "d" };
  expect((await f.write("release", done, phone.token)).status).toBe(200);
  f.clock.mockReturnValue(now + 10 * minute);
  await f.claim("issue:live", phone);
  const stored = (subject: string) => {
    const row = f.rows("state_leases").find((r) => r.subject === subject);
    return row === undefined
      ? null
      : (JSON.parse(String(row.body)) as LeaseRecord);
  };
  f.cold();
  const was = f.snapshot();
  const reads = [
    [bearer(phone.token), "direct"],
    [bearer(phone.token), "worker"],
    [FORGED, "direct"],
  ] as const;
  for (const [headers, via] of reads)
    for (const subject of ["expired", "done", "live", "none"]) {
      f.reopen();
      const route = `holder?subject=issue:${subject}`;
      const got = await f.raw(route, undefined, headers, via);
      const res = [subject, via, ...outcome(f, was, got, LEASE_READS)];
      const lease = stored(`issue:${subject}`);
      expect(res).toEqual([subject, via, 200, lease, [], true]);
    }
  // A missing subject is a client error, and a missing lease table is no lease.
  f.reopen();
  const bad = await f.raw("holder", undefined, bearer(phone.token));
  expect(outcome(f, was, bad)).toEqual([400, "INPUT_INVALID", [], true]);
  f.db.run("DROP TABLE state_leases");
  const bare = f.snapshot();
  for (const headers of [bearer(phone.token), FORGED]) {
    f.reopen();
    const got = await f.raw("holder?subject=issue:live", undefined, headers);
    expect(outcome(f, bare, got)).toEqual([200, null, [], true]);
  }
}, 30_000);

test("a cold object migrates once its token is accepted, then serves the lease journey and its replay", async () => {
  using f = fixture();
  const device = await f.issue();
  f.cold();
  const sent = [];
  for (const [route, id] of [
    ["claim", "c"],
    ["renew", "n"],
    ["release", "r"],
    ["release", "r"],
  ] as const) {
    const body = { ...defaults, requestId: id };
    sent.push(await f.raw(route, body, bearer(device.token), "worker"));
  }
  expect(sent.map((got) => got.status)).toEqual([200, 200, 200, 200]);
  expect(sent[0]?.body.value).toMatchObject({ generation: 1 });
  expect(sent[3]?.body).toEqual(sent[2]?.body);
  expect(f.snapshot()).toContain("domain_cloud_login");
}, 30_000);

// Table cases share the same valid history; only the final renewal and matching lease are forged.
for (const mode of ["whole", "paged"] as const)
  for (const state of ["future", "released", "expired"] as const)
    for (const limit of ["fits", "rows", "bytes", "event failure"] as const) {
      if (state !== "future" && limit !== "fits") continue;
      test(`${mode} restore: ${state} leases, ${limit}`, async () => {
        using source = fixture();
        const empty = (await source.send("dump")).body.value;
        expect((await source.send("restore", empty)).status).toBe(200);
        for (const subject of ["issue", "other"]) {
          expect(
            (await source.write("claim", { subject }, "owner")).status,
          ).toBe(200);
          expect(
            (await source.write("renew", { subject }, "owner")).status,
          ).toBe(200);
          if (state === "released")
            expect(
              (await source.write("release", { subject }, "owner")).status,
            ).toBe(200);
        }
        if (state === "expired") source.clock.mockReturnValue(now + minute);
        const dump = (await source.send("dump")).body.value as Dump;
        if (state === "future") {
          for (const row of dump.tables.state_leases!) {
            const lease = JSON.parse(String(row.body)) as LeaseRecord;
            row.body = JSON.stringify({
              ...lease,
              expiresAt: "9999-01-01T00:00:00.000Z",
            });
          }
          for (const row of dump.tables.state_events!) {
            const event = JSON.parse(String(row.body)) as StateEvent;
            if (event.type.endsWith(":lease.renewed@1")) {
              row.body = JSON.stringify({
                ...event,
                data: {
                  ...(event.data as LeaseRecord),
                  expiresAt: "9999-01-01T00:00:00.000Z",
                },
              });
            }
          }
        }
        const storedBytes = Object.values(dump.tables)
          .flat()
          .reduce(
            (sum, row) =>
              sum +
              Object.values(row).reduce<number>(
                (n, value) =>
                  n + new TextEncoder().encode(String(value)).length,
                0,
              ),
            0,
          );
        using target = fixture({
          ...(limit === "rows"
            ? { DUMP_MAX_ROWS: dump.tables.state_events!.length }
            : {}),
          ...(limit === "bytes" ? { DUMP_MAX_BYTES: storedBytes } : {}),
        });
        if (state === "expired") target.clock.mockReturnValue(now + minute);
        if (limit === "event failure") target.failRestore();
        const pages =
          mode === "whole"
            ? [dump]
            : [
                {
                  format: PAGE_FORMAT,
                  page: 0,
                  last: false,
                  next: "next",
                  tables: {
                    ...Object.fromEntries(
                      Object.keys(dump.tables).map((t) => [t, []]),
                    ),
                    state_records: dump.tables.state_records!,
                  },
                },
                {
                  format: PAGE_FORMAT,
                  page: 1,
                  last: true,
                  next: null,
                  tables: { ...dump.tables, state_records: [] },
                },
              ];
        for (const [index, page] of pages.entries()) {
          const reply = await target.send("restore", page);
          const final = index === pages.length - 1;
          expect(reply.status).toBe(
            !final || limit === "fits"
              ? 200
              : limit === "event failure"
                ? 500
                : 413,
          );
          if (!final) {
            expect((await target.send("status")).body.value).toEqual({
              initialized: false,
            });
            expect(target.rows("state_leases")).toEqual([]);
          } else if (limit !== "fits") {
            if (limit !== "event failure")
              expect(reply.body.error?.code).toBe("RESTORE_TOO_LARGE");
            expect((await target.send("status")).body.value).toEqual({
              initialized: false,
            });
            for (const table of Object.keys(dump.tables))
              expect(target.rows(table)).toEqual([]);
          }
        }
        if (limit !== "fits") return;
        const restored = (await target.send("dump")).body.value as Dump;
        for (const [table, rows] of Object.entries(dump.tables)) {
          if (!["state_leases", "state_events"].includes(table))
            expect(restored.tables[table]).toEqual(rows);
        }
        const events = restored.tables.state_events!;
        expect(events.slice(0, dump.tables.state_events!.length)).toEqual(
          dump.tables.state_events!,
        );
        expect(events.length).toBe(
          dump.tables.state_events!.length + (state === "future" ? 2 : 0),
        );
        for (const [index, row] of restored.tables.state_leases!.entries()) {
          const original = JSON.parse(
            String(dump.tables.state_leases![index]!.body),
          ) as LeaseRecord;
          const lease = JSON.parse(String(row.body)) as LeaseRecord;
          expect(lease).toEqual(
            state === "future"
              ? { ...original, releasedAt: new Date(now).toISOString() }
              : original,
          );
          expect(row.generation).toBe(original.generation);
          if (state === "future") {
            const event = JSON.parse(
              String(events[dump.tables.state_events!.length + index]!.body),
            ) as StateEvent;
            expect(event).toEqual({
              type: "forge/work:lease.released@1",
              namespace: "forge/work",
              key: lease.subject,
              revision: lease.generation,
              at: new Date(now).toISOString(),
              actor: lease.holder.actor,
              data: lease,
            });
          }
          const other = restored.tables.state_leases!.find(
            (r) => r.subject !== row.subject,
          )!;
          const beforeOther = await target.lookup(String(other.subject));
          const claim = await target.write(
            "claim",
            {
              subject: lease.subject,
              holder: holder("phone", "fresh"),
              requestId: `fresh-${lease.subject}`,
            },
            "owner",
          );
          expect(claim.status).toBe(200);
          expect((claim.body.value as LeaseRecord).generation).toBe(
            original.generation + 1,
          );
          expect(await target.lookup(String(other.subject))).toEqual(
            beforeOther,
          );
        }
      }, 30_000);
    }
