import { expect, setDefaultTimeout, test } from "bun:test";
import * as receipts from "../../cloud/src/issue-receipts.ts";
import { domain, Project } from "../../cloud/src/project.ts";
import { fixture as projectFixture } from "./dump-capacity.fixture.ts";
import {
  actor,
  fixture,
  ns,
  usage,
} from "../core/l5-state/retention.fixture.ts";
import type { SqlDatabase } from "../../src/ports/store.ts";
import type { DurableStorage } from "../../cloud/src/store.ts";

setDefaultTimeout(30_000);

const maintain = (db: SqlDatabase, now: number, batch: number) =>
  (
    receipts as typeof receipts & {
      maintainReceipts?: (
        db: SqlDatabase,
        now: number,
        batch: number,
      ) => number;
    }
  ).maintainReceipts?.(db, now, batch);

test.each(["invalid", -1])(
  "an invalid idle deadline refuses without scheduling a spin: %s",
  async (deadline) => {
    const s = await fixture();
    try {
      s.owner.initialize([domain]);
      s.db.run(
        "INSERT INTO domain_cloud_requests(request_id,fingerprint,outcome,result,created_at) VALUES ('bad',?,'LEASE_HELD','{}',1)",
        [JSON.stringify({ retryUntil: deadline })],
      );
      expect(() => receipts.receiptMaintenanceDeadline(s.db)).toThrow(
        /repair/i,
      );
    } finally {
      await s.close();
    }
  },
);

test("idle expiry shares a bounded delete budget and retains live denial authority", async () => {
  const s = await fixture();
  try {
    s.owner.initialize([domain]);
    s.owner.put(ns, "kept", {}, actor, {
      expectRevision: 0,
      requestId: "core",
    });
    const now = 2 * receipts.RETENTION_MS;
    for (let i = 0; i < 6; i++) {
      s.db.run(
        "INSERT INTO domain_cloud_command_receipts(request_id,fingerprint,outcome,result,created_at,expires_at) VALUES (?,'{}',?,'{}',1,?)",
        [`c${i}`, i === 5 ? "refused" : "ok", now + 1000],
      );
      s.db.run(
        "INSERT INTO domain_cloud_requests(request_id,fingerprint,outcome,result,created_at) VALUES (?,?,?,'{}',1)",
        [
          `l${i}`,
          JSON.stringify({ retryUntil: i === 5 ? now + 1000 : now - 1 }),
          i === 5 ? "LEASE_HELD" : "ok",
        ],
      );
    }
    const state = s.owner.export();
    for (let i = 0; i < 5; i++) expect(maintain(s.db, now, 2)).toBe(2);
    expect(maintain(s.db, now, 2)).toBe(0);
    for (const table of [
      "domain_cloud_command_receipts",
      "domain_cloud_requests",
    ])
      expect(s.db.all(`SELECT request_id FROM ${table}`)).toHaveLength(1);
    expect(s.owner.export().records).toEqual(state.records);
    expect(s.owner.export().requests).toEqual(state.requests);
    expect(maintain(s.db, now + 1000, 2)).toBe(2);
    usage(s.db, "domain_cloud_requests", [
      "request_id",
      "fingerprint",
      "outcome",
      "result",
      "created_at",
    ]);
    usage(s.db, "domain_cloud_command_receipts", [
      "request_id",
      "fingerprint",
      "outcome",
      "result",
      "created_at",
      "expires_at",
    ]);
  } finally {
    await s.close();
  }
});

test.each([false, true])(
  "idle alarm preserves unprovisioned storage and expires published witnesses: %p",
  async (provisioned) => {
    const p = await projectFixture(undefined, provisioned);
    if (provisioned)
      p.db.run(
        "INSERT INTO domain_cloud_command_receipts(request_id,fingerprint,outcome,result,created_at,expires_at) VALUES ('expired','{}','ok','{}',1,2)",
      );
    const project = new Project({ storage: p.storage }) as Project & {
      alarm?: () => Promise<void>;
    };
    const before = p.snapshot();
    await project.alarm?.();
    if (provisioned)
      expect(
        p.db
          .query("SELECT request_id FROM domain_cloud_command_receipts")
          .all(),
      ).toEqual([]);
    else expect(p.snapshot()).toEqual(before);
  },
);

test("only writable commands arm maintenance and alarms continue expired batches", async () => {
  const p = await projectFixture();
  const issued = await p.send("devices", {
    device: "maintenance",
    ttlMs: 86400000,
  });
  const token = (issued.value as unknown as { token: string }).token;
  const storage: DurableStorage = p.storage;
  let next: number | null = null;
  const armed: number[] = [];
  storage.getAlarm = () => Promise.resolve(next);
  storage.setAlarm = (time) => {
    next = time;
    armed.push(time);
    return Promise.resolve();
  };
  const project = new Project(
    { storage },
    { FORGE_CLOUD_PROJECT: "a", FORGE_CLOUD_ID_PREFIX: "forge" },
  );
  const command = (op: string, input: unknown, requestId: string) =>
    project.fetch(
      new Request("https://fixture.example/p/a/command", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ op, input, requestId, context: { actor } }),
      }),
    );
  expect((await command("issue.list", {}, "read")).status).toBe(200);
  expect(armed).toEqual([]);
  expect(
    (await command("issue.create", { title: "kept" }, "write")).status,
  ).toBe(200);
  expect(armed).toHaveLength(1);
  for (let i = 0; i < 257; i++)
    p.db.run(
      "INSERT INTO domain_cloud_command_receipts(request_id,fingerprint,outcome,result,created_at,expires_at) VALUES (?,'{}','ok','{}',1,2)",
      [`expired-${i}`],
    );
  next = null;
  await project.alarm();
  expect(
    p.db
      .query(
        "SELECT request_id FROM domain_cloud_command_receipts WHERE expires_at=2",
      )
      .all(),
  ).toHaveLength(1);
  expect(armed).toHaveLength(2);
  next = null;
  await project.alarm();
  expect(
    p.db
      .query(
        "SELECT request_id FROM domain_cloud_command_receipts WHERE expires_at=2",
      )
      .all(),
  ).toEqual([]);
  expect(armed).toHaveLength(3);
});

test.each([
  [1000, 0],
  [1000, 257],
  [-1, 1],
])("idle maintenance refuses invalid budgets %j", async (now, batch) => {
  const s = await fixture();
  try {
    s.owner.initialize([domain]);
    const before = s.owner.export();
    expect(() => maintain(s.db, now, batch)).toThrow(/budget/i);
    expect(s.owner.export()).toEqual(before);
  } finally {
    await s.close();
  }
});
