import { expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { ForgeFailure } from "../../src/contract/failure.ts";
import { domain, Project } from "../../cloud/src/project.ts";
import { createIssue } from "../../cloud/src/issue-create.ts";
import { StateOwner } from "../../src/core/state/index.ts";
import { writableStore, type DurableStorage } from "../../cloud/src/store.ts";
import {
  admit,
  record,
  refused,
  replay,
  MAX_RECEIPTS,
} from "../../cloud/src/issue-receipts.ts";
import {
  COMMAND_RECEIPTS,
  EXPORT_STATE,
  dumpOf,
  restoreDump,
  limitsFrom,
} from "../../cloud/src/dump.ts";
import { fixture, actor, ns } from "../core/l5-state/retention.fixture.ts";

setDefaultTimeout(30_000);

const start = 1000;
const day = 24 * 60 * 60 * 1000;
const failure = new ForgeFailure({
  code: "INPUT_CONFLICT",
  message: "synthetic refused command",
  retry: "never",
});
const holder = { actor, session: { id: "synthetic", device: "synthetic" } };
type Fixture = Awaited<ReturnType<typeof fixture>>;
function initialize(s: Fixture) {
  s.db.exec(
    "CREATE TABLE domain_cloud_pragma (name TEXT PRIMARY KEY, value INTEGER NOT NULL)",
  );
  s.owner.initialize([domain]);
}
const receipts = (s: Fixture) =>
  s.db.all(`SELECT * FROM ${COMMAND_RECEIPTS} ORDER BY request_id`);
function cloud(s: Fixture, expiry = start + 2 * day) {
  const values = new Map<string, unknown>();
  const storage: DurableStorage = {
    sql: {
      exec: (sql, ...args) => ({
        toArray: () =>
          s.db
            .all(
              sql,
              args.map((arg) =>
                arg instanceof ArrayBuffer ? new Uint8Array(arg) : arg,
              ),
            )
            .map((row) =>
              Object.fromEntries(
                Object.entries(row).map(([key, value]) => [
                  key,
                  typeof value === "bigint" ? Number(value) : value,
                ]),
              ),
            ),
      }),
    },
    transactionSync: (work) => s.db.transaction(work),
    get: (key) => Promise.resolve(values.get(key)),
    put: (key, value) => {
      values.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => Promise.resolve(values.delete(key)),
  };
  const db = writableStore(storage);
  const owner = new StateOwner(db, { now: () => Date.now() });
  const project = new Project(
    { storage },
    { FORGE_CLOUD_PROJECT: "p", FORGE_CLOUD_ID_PREFIX: "forge" },
  );
  return {
    db,
    owner,
    create: (input: unknown, requestId = "r") =>
      createIssue(db, owner, {
        principal: ["token", "synthetic-principal", "synthetic"],
        requestId,
        input,
        context: { variant: "project", actor, project: { id: "p" } },
        device: "synthetic",
        prefix: "forge",
        expiresAt: expiry,
        recheck: () => {
          if (Date.now() >= expiry)
            throw new ForgeFailure({
              code: "AUTH_EXPIRED",
              message: "Expired",
              retry: "never",
            });
        },
      }),
    lease: (input: unknown, route = "claim") =>
      project.fetch(
        new Request(`https://fixture.example/p/p/${route}`, {
          method: "POST",
          headers: {
            "X-Forge-Owner": "synthetic",
            "X-Forge-Owner-Expires": String(expiry),
          },
          body: JSON.stringify(input),
        }),
      ),
  };
}
function write(s: Fixture, outcome: "ok" | "refused", expiry: number) {
  s.owner.acquire(ns, "subject", holder, 60_000, "lease");
  if (outcome === "refused")
    refused(
      s.db,
      "command",
      "synthetic-input",
      failure,
      () => undefined,
      expiry,
    );
  else
    record(
      s.db,
      "command",
      { fingerprint: "synthetic-input", outcome, result: { original: true } },
      expiry,
    );
}

test.each(["ok", "refused"] as const)(
  "checkpoint plus tail and image restore retain the original %s command witness",
  async (outcome) => {
    const full = await fixture(),
      saved = await fixture(),
      target = await fixture();
    const clock = spyOn(Date, "now").mockReturnValue(start);
    try {
      for (const s of [full, saved, target]) initialize(s);
      write(full, outcome, start + 2 * day);
      write(saved, outcome, start + 2 * day);
      const before = receipts(saved);
      saved.owner.checkpoint(1);
      expect(receipts(saved)).toEqual(before);
      expect(saved.db.all("SELECT * FROM state_checkpoint_denied")).toEqual([]);
      for (const s of [full, saved])
        s.owner.put(ns, "tail", {}, actor, { expectRevision: 0 });
      saved.owner.initialize([domain]);
      target.db.run(`DELETE FROM ${EXPORT_STATE}`);
      target.owner.restore(saved.owner.export(), undefined, 1);
      clock.mockReturnValue(start + day - 1);
      for (const s of [full, saved, target]) {
        expect(receipts(s)).toEqual(before);
        const beforeReplay = s.owner.export().eventHighWaterMark;
        const answer = () =>
          replay(s.db, s.owner, "command", "synthetic-input");
        if (outcome === "refused") expect(answer).toThrow(failure.message);
        else expect(answer()).toEqual({ original: true });
        expect(() =>
          replay(s.db, s.owner, "command", "different-input"),
        ).toThrow(/different input/);
        expect(s.owner.export().eventHighWaterMark).toBe(beforeReplay);
      }
    } finally {
      clock.mockRestore();
      await full.close();
      await saved.close();
      await target.close();
    }
  },
);

for (const outcome of ["ok", "refused"] as const)
  for (const window of ["24h", "credential"] as const)
    test(`${outcome} answer stops at ${window} expiry while denial lasts through credential validity`, async () => {
      const source = await fixture(),
        target = await fixture();
      const clock = spyOn(Date, "now").mockReturnValue(start);
      const expiry = start + (window === "24h" ? 2 * day : 60_000);
      const deadline = Math.min(start + day, expiry);
      try {
        initialize(source);
        initialize(target);
        write(source, outcome, expiry);
        source.owner.checkpoint(1);
        target.db.run(`DELETE FROM ${EXPORT_STATE}`);
        target.owner.restore(source.owner.export(), undefined, 1);
        clock.mockReturnValue(deadline - 1);
        const answer = () =>
          replay(target.db, target.owner, "command", "synthetic-input");
        if (outcome === "refused") expect(answer).toThrow(failure.message);
        else expect(answer()).toEqual({ original: true });
        for (const at of [deadline, deadline + 1]) {
          clock.mockReturnValue(at);
          if (outcome === "refused" && at < expiry) {
            expect(answer).toThrow(/refused/);
            expect(() =>
              replay(target.db, target.owner, "command", "new-input"),
            ).toThrow();
            expect(() =>
              record(
                target.db,
                "command",
                { fingerprint: "new-input", outcome: "ok", result: {} },
                expiry,
              ),
            ).toThrow(/not recorded/);
            admit(target.db);
            expect(receipts(target)).toHaveLength(1);
          } else expect(answer()).toBeUndefined();
        }
        clock.mockReturnValue(expiry);
        admit(target.db);
        expect(receipts(target)).toEqual([]);
        record(
          target.db,
          "command",
          {
            fingerprint: "new-input",
            outcome: "ok",
            result: { fresh: true },
          },
          expiry + 60_000,
        );
        expect(replay(target.db, target.owner, "command", "new-input")).toEqual(
          {
            fresh: true,
          },
        );
      } finally {
        clock.mockRestore();
        await source.close();
        await target.close();
      }
    });

test("a refused create id remains denied after 24h and checkpoint restore until its 48h credential ends", async () => {
  const source = await fixture(),
    target = await fixture();
  const clock = spyOn(Date, "now").mockReturnValue(start);
  try {
    initialize(source);
    initialize(target);
    expect(() => cloud(source).create({ title: null })).toThrow(/issue.create/);
    source.owner.acquire(ns, "anchor", holder, 60_000, "anchor");
    source.owner.checkpoint(1);
    target.db.run(`DELETE FROM ${EXPORT_STATE}`);
    target.owner.restore(source.owner.export(), undefined, 1);
    clock.mockReturnValue(start + day);
    const client = cloud(target);
    expect(() => client.create({ title: "Valid now" })).toThrow();
    expect(target.owner.list("forge/work")).toEqual([]);
    clock.mockReturnValue(start + 2 * day);
    expect(() => client.create({ title: "Expired" })).toThrow(/Expired/);
  } finally {
    clock.mockRestore();
    await source.close();
    await target.close();
  }
});

test("a saturation refusal remains durable after answer capacity frees", async () => {
  const source = await fixture();
  const clock = spyOn(Date, "now").mockReturnValue(start);
  try {
    initialize(source);
    source.db.run(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?) INSERT INTO ${COMMAND_RECEIPTS}(request_id,fingerprint,outcome,result,created_at,expires_at) SELECT 'fill-'||i,'{}','ok','{}',?,CASE WHEN i=1 THEN ? ELSE ? END FROM n`,
      [MAX_RECEIPTS, start, start + 60_000, start + day],
    );
    const client = cloud(source);
    expect(() => client.create({ title: null })).toThrow(/issue.create/);
    expect(() => client.create({ title: "At capacity" }, "cap")).toThrow(
      /receipts/,
    );
    clock.mockReturnValue(start + 60_001);
    expect(() => client.create({ title: "Capacity freed" })).toThrow(
      /different input|refused/,
    );
    expect(() => client.create({ title: "At capacity" }, "cap")).toThrow();
    expect(source.owner.list("forge/work")).toEqual([]);
    clock.mockReturnValue(start + day);
    expect(() => admit(source.db)).not.toThrow();
    expect(() => client.create({ title: "After capacity frees" })).toThrow(
      /refused/,
    );
    expect(client.create({ title: "Fresh id" }, "fresh").title).toBe(
      "Fresh id",
    );
  } finally {
    clock.mockRestore();
    await source.close();
  }
});

test("lease-route refusal answers expire at 24h while their ids remain denied", async () => {
  const source = await fixture(),
    target = await fixture();
  const clock = spyOn(Date, "now").mockReturnValue(start);
  try {
    initialize(source);
    initialize(target);
    const client = cloud(source);
    const input = { subject: "s", requestId: "r", holder, ttlMs: 0 };
    const first = await client.lease(input);
    expect(first.status).toBe(400);
    source.owner.acquire(ns, "anchor", holder, 60_000, "anchor");
    source.owner.checkpoint(1);
    target.db.run(`DELETE FROM ${EXPORT_STATE}`);
    target.owner.restore(source.owner.export(), undefined, 1);
    const restored = cloud(target);
    clock.mockReturnValue(start + day);
    const replayed = await restored.lease(input);
    expect(replayed.status).toBe(409);
    const changed = await restored.lease({ ...input, ttlMs: 60_000 });
    expect(changed.status).toBe(409);
    expect(target.owner.lease("forge/work", "s")).toBeUndefined();
    clock.mockReturnValue(start + 2 * day);
    expect((await restored.lease(input)).status).toBe(401);
    expect(
      (await cloud(target, start + 3 * day).lease({ ...input, ttlMs: 60_000 }))
        .status,
    ).toBe(200);
  } finally {
    clock.mockRestore();
    await source.close();
    await target.close();
  }
});

test("lease-route release does not return its original answer after 24h", async () => {
  const source = await fixture();
  const clock = spyOn(Date, "now").mockReturnValue(start);
  try {
    initialize(source);
    const client = cloud(source);
    const claim = { subject: "s", requestId: "claim", holder, ttlMs: 60_000 };
    expect((await client.lease(claim)).status).toBe(200);
    const release = {
      subject: "s",
      requestId: "release",
      holder,
      generation: 1,
    };
    expect((await client.lease(release, "release")).status).toBe(200);
    source.owner.checkpoint(1);
    const before = source.owner.events("forge/work");
    clock.mockReturnValue(start + day);
    expect((await client.lease(release, "release")).status).toBe(409);
    expect(source.owner.events("forge/work")).toEqual(before);
  } finally {
    clock.mockRestore();
    await source.close();
  }
});

test.each(["invalid", start])(
  "lease receipt import rejects retry deadline %s and leaves its target empty",
  async (retryUntil) => {
    const source = await fixture(),
      target = await fixture();
    const clock = spyOn(Date, "now").mockReturnValue(start);
    try {
      initialize(source);
      initialize(target);
      expect(
        (
          await cloud(source).lease({
            subject: "s",
            requestId: "r",
            holder,
            ttlMs: 0,
          })
        ).status,
      ).toBe(400);
      const valid = dumpOf(source.db),
        bad = structuredClone(valid);
      const row = bad.tables.domain_cloud_requests![0]!;
      row.fingerprint = JSON.stringify({
        ...(JSON.parse(String(row.fingerprint)) as Record<string, unknown>),
        retryUntil,
      });
      const destination = cloud(target);
      expect(() =>
        restoreDump(
          destination.db,
          destination.owner,
          bad,
          limitsFrom(undefined),
        ),
      ).toThrow(/domain_cloud_requests.*not valid/);
      expect(target.db.all("SELECT * FROM domain_cloud_requests")).toEqual([]);
      expect(
        restoreDump(
          destination.db,
          destination.owner,
          valid,
          limitsFrom(undefined),
        ),
      ).toMatchObject({ domain_cloud_requests: 1 });
    } finally {
      clock.mockRestore();
      await source.close();
      await target.close();
    }
  },
);
