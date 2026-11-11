import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Project } from "../../cloud/src/project.ts";
import type { DurableStorage } from "../../cloud/src/store.ts";
import { createSqliteStore } from "../../src/adapters/store-sqlite/index.ts";
import { StateOwner } from "../../src/core/state/index.ts";
import type {
  ForgeError,
  LeaseHolder,
  LeaseRecord,
} from "../../src/generated/types.ts";

if (!("timingSafeEqual" in crypto.subtle))
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    value: crypto.timingSafeEqual.bind(crypto),
  });
const now = 1_800_000_000_000,
  day = 86_400_000,
  minute = 60_000;
const holder = (device = "phone", session = device): LeaseHolder => ({
  actor: { kind: "agent", id: "builder" },
  session: { id: session, device },
});
type Device = { id: string; token: string; device: string };
const defaults = {
  subject: "issue",
  holder: holder(),
  generation: 1,
  ttlMs: minute,
};
function fixture() {
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const db = new Database(":memory:"),
    values = new Map<string, unknown>();
  let failRelease = false;
  let claimNumber = 0;
  const storage: DurableStorage = {
    sql: {
      exec: (sql, ...bindings) => {
        if (failRelease && sql.startsWith("INSERT INTO state_events"))
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
    transactionSync: (body) => db.transaction(body)(),
    get: (key) => Promise.resolve(values.get(key)),
    put: (key, value) => {
      values.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => Promise.resolve(values.delete(key)),
  };
  const project = new Project({ storage });
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
  return {
    db,
    storage,
    send,
    write,
    issue,
    claim,
    lookup,
    clock,
    row,
    rows,
    revoke: (device: Device) => send("revoke", { id: device.id }),
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
          f.row(
            "SELECT outcome FROM domain_cloud_requests WHERE request_id=?",
            requestId,
          ),
        ).toEqual({ outcome: "INPUT_INVALID" });
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
    const before = await f.claim("issue:phone", first);
    await f.claim("issue:other", first, "other");
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

test("whole and paged restores preserve an oversized claim refusal and its replay", async () => {
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
  }
}, 30_000);
