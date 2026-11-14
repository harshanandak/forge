import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { LaneControlStore } from "../../cloud/src/lane-control-store.ts";
import {
  durableStore,
  PRAGMA_TABLE,
  type DurableStorage,
} from "../../cloud/src/store.ts";
import { StateOwner } from "../../src/core/state/index.ts";
import { exitCode } from "../../src/surface/result.ts";

const NS = "forge/work",
  GLOBAL = "lane-control:global";
const now = "2026-11-14T10:00:00.000Z";
const actor = { kind: "agent", id: "fixture" } as const;
const running = {
  version: 1,
  incarnation: "history",
  epoch: 4,
  resumeAllEpoch: 0,
  stopAll: null,
};
const stopped = (id = "work-7", epoch = 4) => ({
  version: 1,
  incarnation: "history",
  id,
  epoch,
  stoppedAt: now,
});

function fixture() {
  const db = new Database(":memory:");
  const reads: string[] = [];
  let failAudit = false;
  const storage: DurableStorage = {
    sql: {
      exec: (sql, ...bindings) => {
        if (sql.startsWith("SELECT body FROM state_records")) {
          const key = bindings[1];
          if (typeof key !== "string") throw new Error("Expected a record key");
          reads.push(key);
        }
        if (
          failAudit &&
          sql.startsWith("INSERT INTO state_records") &&
          bindings.some(
            (v) => typeof v === "string" && v.startsWith("lane-control:audit:"),
          )
        )
          throw new Error("injected audit failure");
        const rows = db
          .query(sql)
          .all(
            ...bindings.map((v) =>
              v instanceof ArrayBuffer ? new Uint8Array(v) : v,
            ),
          ) as Record<string, unknown>[];
        return { toArray: () => rows };
      },
    },
    transactionSync: (body) => db.transaction(body)(),
    get: () => Promise.resolve(undefined),
    put: () => Promise.resolve(),
    delete: () => Promise.resolve(false),
  };
  const owner = new StateOwner(durableStore(storage), {
    now: () => Date.parse(now),
  });
  owner.initialize([
    {
      namespace: "forge/cloud",
      reviewedDigest: `sha256:${"0".repeat(64)}`,
      migrations: [],
      tables: [PRAGMA_TABLE],
    },
  ]);
  const store = new LaneControlStore(owner, "project");
  const put = (key: string, value: unknown) =>
    owner.put(NS, key, value, actor, {
      expectRevision: owner.get(NS, key)?.revision ?? 0,
    });
  const snapshot = () =>
    JSON.stringify([
      db.query("SELECT * FROM state_records ORDER BY key").all(),
      db.query("SELECT * FROM state_events ORDER BY sequence").all(),
    ]);
  return {
    db,
    owner,
    store,
    reads,
    put,
    snapshot,
    fail: () => {
      failAudit = true;
    },
  };
}
type Fixture = ReturnType<typeof fixture>;
type Reply = ReturnType<LaneControlStore["read"]>;
function result(reply: Reply, code = "OK", exit = 0) {
  expect([
    reply.status,
    reply.ok ? "OK" : reply.error.code,
    exitCode(reply),
  ]).toEqual([code === "OK" ? "OK" : "FAIL", code, exit]);
  if (!reply.ok) return undefined;
  return reply.result;
}

const cases: [string, (f: Fixture) => void][] = [
  ...[undefined, "work-7"].map((id): [string, (f: Fixture) => void] => [
    `missing global read ${id ?? "all"}`,
    (f) => {
      const before = f.snapshot();
      result(f.store.read(id), "UNAVAILABLE", 1);
      expect(f.snapshot()).toBe(before);
    },
  ]),
  ...[{ version: 2 }, { epoch: Number.MAX_SAFE_INTEGER + 1 }].map(
    (bad): [string, (f: Fixture) => void] => [
      `malformed global ${JSON.stringify(bad)}`,
      (f) => {
        f.put(GLOBAL, { ...running, ...bad });
        const before = f.snapshot();
        result(f.store.read("work-7"), "UNAVAILABLE", 1);
        result(
          f.store.stop({ all: true }, "device", "session", now),
          "UNAVAILABLE",
          1,
        );
        expect(f.snapshot()).toBe(before);
      },
    ],
  ),
  [
    "running read",
    (f) => {
      f.put(GLOBAL, running);
      const before = f.snapshot();
      expect(result(f.store.read("work-7"))).toEqual({
        incarnation: "history",
        epoch: 4,
        stopped: false,
      });
      expect(f.snapshot()).toBe(before);
    },
  ],
  ...[0, 4].map((watermark): [string, (f: Fixture) => void] => [
    `issue read with resume watermark ${watermark}`,
    (f) => {
      f.put(GLOBAL, { ...running, resumeAllEpoch: watermark });
      for (let i = 1; i <= 50; i++)
        f.put(`lane-control:work-${i}`, stopped(`work-${i}`));
      const before = f.snapshot();
      f.reads.length = 0;
      const view = result(f.store.read("work-7"));
      expect(view).toEqual({
        incarnation: "history",
        epoch: 4,
        stopped: watermark === 0,
        ...(watermark === 0 ? { scope: "issue", since: now } : {}),
      });
      expect(f.reads).toEqual([GLOBAL, "lane-control:work-7"]);
      expect(f.snapshot()).toBe(before);
    },
  ]),
  [
    "stop-all bootstrap",
    (f) => {
      f.put("lane-control:work-8", stopped("work-8"));
      const other = f.owner.get(NS, "lane-control:work-8");
      const view = result(
        f.store.stop({ all: true }, "device", "session", now),
      );
      expect(view).toMatchObject({
        epoch: 1,
        stopped: true,
        scope: "all",
        since: now,
      });
      expect(view?.incarnation).toMatch(/^[0-9a-f-]{36}$/);
      expect(f.owner.get(NS, GLOBAL)?.value).toMatchObject({
        epoch: 1,
        stopAll: now,
        resumeAllEpoch: 0,
      });
      expect(f.owner.get(NS, "lane-control:work-8")).toEqual(other);
      const audits = f.owner.list(NS, "lane-control:audit:");
      expect(audits).toHaveLength(1);
      expect(audits[0]?.value).toMatchObject({
        device: "device",
        session: "session",
        epoch: 1,
        scope: { all: true },
      });
    },
  ],
  [
    "single stop requires global",
    (f) => {
      const before = f.snapshot();
      result(
        f.store.stop({ id: "work-7" }, "device", "session", now),
        "UNAVAILABLE",
        1,
      );
      expect(f.snapshot()).toBe(before);
    },
  ],
  ...[false, true].map((reassert): [string, (f: Fixture) => void] => [
    `single stop reassert=${reassert}`,
    (f) => {
      f.put(GLOBAL, running);
      if (reassert) f.put("lane-control:work-7", stopped());
      f.put("lane-control:work-8", stopped("work-8"));
      const other = f.owner.get(NS, "lane-control:work-8");
      expect(
        result(f.store.stop({ id: "work-7" }, "device", "session", now)),
      ).toEqual({
        incarnation: "history",
        epoch: 5,
        stopped: true,
        scope: "issue",
        since: now,
      });
      expect(f.owner.get(NS, GLOBAL)?.value).toEqual({ ...running, epoch: 5 });
      expect(f.owner.get(NS, "lane-control:work-7")?.value).toEqual(
        stopped("work-7", 5),
      );
      expect(f.owner.get(NS, "lane-control:work-8")).toEqual(other);
      const audits = f.owner.list(NS, "lane-control:audit:");
      expect(audits).toHaveLength(1);
      expect(audits[0]?.value).toMatchObject({
        device: "device",
        session: "session",
        epoch: 5,
        scope: { id: "work-7" },
      });
    },
  ]),
  ...["WORK-7", "work-07", "7", "forge-7", "../work-7"].map(
    (id): [string, (f: Fixture) => void] => [
      `non-canonical scope ${id}`,
      (f) => {
        f.put(GLOBAL, running);
        const before = f.snapshot();
        result(
          f.store.stop({ id }, "device", "session", now),
          "INPUT_INVALID",
          6,
        );
        result(f.store.read(id), "INPUT_INVALID", 6);
        expect(f.snapshot()).toBe(before);
      },
    ],
  ),
  [
    "epoch overflow",
    (f) => {
      f.put(GLOBAL, { ...running, epoch: Number.MAX_SAFE_INTEGER });
      const before = f.snapshot();
      result(
        f.store.stop({ all: true }, "device", "session", now),
        "UNAVAILABLE",
        1,
      );
      expect(f.snapshot()).toBe(before);
    },
  ],
  [
    "audit failure rolls back every candidate row",
    (f) => {
      f.put(GLOBAL, running);
      const before = f.snapshot();
      f.fail();
      result(
        f.store.stop({ id: "work-7" }, "device", "session", now),
        "UNAVAILABLE",
        1,
      );
      expect(f.snapshot()).toBe(before);
    },
  ],
  ...["different issues", "same epoch new incarnation", "bootstrap"].map(
    (race): [string, (f: Fixture) => void] => [
      `stale commit: ${race}`,
      (f) => {
        if (race !== "bootstrap") f.put(GLOBAL, running);
        const second = new LaneControlStore(f.owner, "project");
        let afterWinner = "";
        const original = f.owner.putMany.bind(f.owner);
        const hook = spyOn(f.owner, "putMany").mockImplementation((...args) => {
          hook.mockRestore();
          if (race === "same epoch new incarnation")
            f.put(GLOBAL, { ...running, incarnation: "restored" });
          else
            result(
              second.stop(
                race === "bootstrap" ? { all: true } : { id: "work-8" },
                "B",
                "b",
                now,
              ),
            );
          afterWinner = f.snapshot();
          return original(...args);
        });
        try {
          result(
            f.store.stop(
              race === "bootstrap" ? { all: true } : { id: "work-7" },
              "A",
              "a",
              now,
            ),
            "INPUT_CONFLICT",
            4,
          );
        } finally {
          hook.mockRestore();
        }
        expect(f.snapshot()).toBe(afterWinner);
        result(f.store.stop({ id: "work-7" }, "A", "a", now));
        expect(result(f.store.read("work-7"))?.stopped).toBe(true);
        if (race === "different issues") {
          expect(result(f.store.read("work-8"))?.stopped).toBe(true);
          expect(f.owner.list(NS, "lane-control:audit:")).toHaveLength(2);
        }
      },
    ],
  ),
];

for (const [name, run] of cases)
  test(
    name,
    () => {
      const f = fixture();
      try {
        run(f);
      } finally {
        f.db.close();
      }
    },
    5000,
  );
