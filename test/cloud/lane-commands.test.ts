import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Project } from "../../cloud/src/project.ts";
import { createWorker } from "../../cloud/src/worker.ts";
import { durableStore, type DurableStorage } from "../../cloud/src/store.ts";
import { StateOwner } from "../../src/core/state/index.ts";
import type { ResultEnvelope } from "../../src/generated/types.ts";
import { exitCode } from "../../src/surface/result.ts";

if (!("timingSafeEqual" in crypto.subtle))
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    value: crypto.timingSafeEqual.bind(crypto),
  });
const now = 1_800_000_000_000;
const actor = { kind: "agent", id: "fixture" } as const;
const running = {
  version: 1,
  incarnation: "history",
  epoch: 4,
  resumeAllEpoch: 0,
  stopAll: null,
};
const call = (
  op: string,
  input: object,
  requestId = "lane-1",
  more: object = {},
) => ({ requestId, op, input, context: { actor }, ...more });

// All tables use this fixture: real token admission, Worker routing and project storage.
async function fixture(projectName = "p") {
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const db = new Database(":memory:");
  const values = new Map<string, unknown>();
  const storage: DurableStorage = {
    sql: {
      exec: (sql, ...bindings) => {
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
    get: (key) => Promise.resolve(values.get(key)),
    put: (key, value) => {
      values.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => Promise.resolve(values.delete(key)),
  };
  const project = new Project(
    { storage },
    { FORGE_CLOUD_PROJECT: projectName, FORGE_CLOUD_ID_PREFIX: "forge" },
  );
  const admitted = await project.fetch(
    new Request(`https://w.example/p/${projectName}/devices`, {
      method: "POST",
      body: JSON.stringify({
        device: "laptop",
        session: "s1",
        ttlMs: 86_400_000,
      }),
    }),
  );
  const token = ((await admitted.json()) as { value: { token: string } }).value
    .token;
  const owner = new StateOwner(durableStore(storage), { now: () => now });
  const put = (key: string, value: unknown) =>
    owner.put("forge/work", key, value, actor, { expectRevision: 0 });
  for (const id of ["work-7", "work-8"])
    put(`issue:${id}`, {
      id,
      title: id,
      status: "open",
      labels: [],
      dependsOn: [],
      createdAt: new Date(now).toISOString(),
    });
  const snapshot = () =>
    JSON.stringify([
      ...[
        "state_records",
        "state_events",
        "state_leases",
        "state_requests",
        "domain_cloud_command_receipts",
      ].map((name) => db.query(`SELECT * FROM ${name}`).all()),
      [...values],
    ]);
  return {
    db,
    owner,
    put,
    snapshot,
    close: () => {
      db.close();
      clock.mockRestore();
    },
    send: async (body: unknown, route = projectName) => {
      const response = await createWorker().fetch(
        new Request(`https://w.example/p/${route}/command`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        }),
        {
          FORGE_CLOUD_PROJECT: projectName,
          PROJECTS: { idFromName: (id) => id, get: () => project },
        },
      );
      const envelope = (await response.json()) as ResultEnvelope;
      return {
        envelope,
        result: envelope.ok ? envelope.result : undefined,
        verdict: [
          envelope.status ?? "FAIL",
          envelope.ok ? "OK" : envelope.error.code,
          exitCode(envelope),
        ],
      };
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const control = (f: Fixture, id?: string) =>
  f.send(call("lane.control", id === undefined ? {} : { id }));
const stopped = (epoch: number, scope: string) => ({
  incarnation: "history",
  epoch,
  stopped: true,
  scope,
  since: new Date(now).toISOString(),
});

test.each([undefined, "work-7"])(
  "lane.control reads running or unavailable without writing, scope %s",
  async (id) => {
    const f = await fixture();
    try {
      for (const initialized of [false, true]) {
        if (initialized) f.put("lane-control:global", running);
        const before = f.snapshot();
        const reply = await control(f, id);
        expect(reply.verdict).toEqual(
          initialized ? ["OK", "OK", 0] : ["FAIL", "UNAVAILABLE", 1],
        );
        if (initialized)
          expect(reply.result).toEqual({
            incarnation: "history",
            epoch: 4,
            stopped: false,
          });
        expect(f.snapshot()).toBe(before);
      }
    } finally {
      f.close();
    }
  },
  10_000,
);

const refusals: [string, string, object, object, string, number][] = [
  ["unknown issue", "lane.stop", { id: "work-99" }, {}, "NOT_FOUND", 3],
  ...["WORK-7", "7", "forge-7", "work-07"].map(
    (id): [string, string, object, object, string, number] => [
      `noncanonical ${id}`,
      "lane.stop",
      { id },
      {},
      "INPUT_INVALID",
      6,
    ],
  ),
  [
    "extra key",
    "lane.stop",
    { all: true, key: "other" },
    {},
    "INPUT_INVALID",
    6,
  ],
  [
    "both scopes",
    "lane.stop",
    { all: true, id: "work-7" },
    {},
    "INPUT_INVALID",
    6,
  ],
  ["missing scope", "lane.stop", {}, {}, "INPUT_INVALID", 6],
  ["read extra key", "lane.control", { key: "other" }, {}, "INPUT_INVALID", 6],
  ["read alias", "lane.control", { id: "forge-7" }, {}, "INPUT_INVALID", 6],
  [
    "project context",
    "lane.stop",
    { all: true },
    { project: { id: "other" } },
    "INPUT_INVALID",
    6,
  ],
  [
    "device",
    "lane.stop",
    { all: true },
    { device: { id: "other" } },
    "AUTH_DEVICE_MISMATCH",
    1,
  ],
  [
    "session device",
    "lane.stop",
    { all: true },
    { session: { id: "s1", device: "other" } },
    "AUTH_DEVICE_MISMATCH",
    1,
  ],
  [
    "session",
    "lane.stop",
    { all: true },
    { session: { id: "other" } },
    "AUTH_DEVICE_MISMATCH",
    1,
  ],
  ["resume", "lane.resume", { all: true }, {}, "UNKNOWN_COMMAND", 3],
];
test.each(refusals)(
  "%s refuses without a record, event or receipt",
  async (_name, op, input, context, code, exit) => {
    const f = await fixture();
    try {
      f.put("lane-control:global", running);
      const before = f.snapshot();
      const reply = await f.send(
        call(op, input, "refused", { context: { actor, ...context } }),
      );
      expect(reply.verdict).toEqual(["FAIL", code, exit]);
      expect(f.snapshot()).toBe(before);
    } finally {
      f.close();
    }
  },
  10_000,
);

test.each(["one", "all", "dry one", "dry all", "foreign route"])(
  "lane.stop %s through the authenticated command route",
  async (mode) => {
    const f = await fixture();
    const other = mode === "foreign route" ? await fixture("other") : undefined;
    try {
      const all = mode.endsWith("all");
      const dryRun = mode.startsWith("dry");
      if (!all) f.put("lane-control:global", running);
      const before = f.snapshot();
      const otherBefore = other?.snapshot() ?? "";
      const unchanged = f.owner.get("forge/work", "issue:work-8");
      const request = call(
        "lane.stop",
        all ? { all: true } : { id: "work-7" },
        "stop",
        { dryRun },
      );
      const reply = await f.send(request, other === undefined ? "p" : "other");
      if (other !== undefined) {
        expect(reply.verdict).toEqual(["FAIL", "AUTH_FORBIDDEN", 1]);
        expect(f.snapshot()).toBe(before);
        expect(other.snapshot()).toBe(otherBefore);
        return;
      }
      expect(reply.verdict).toEqual(["OK", "OK", 0]);
      expect(reply.result).toMatchObject({
        epoch: all ? 1 : 5,
        stopped: true,
        scope: all ? "all" : "issue",
      });
      expect(f.owner.get("forge/work", "issue:work-8")).toEqual(unchanged);
      if (dryRun) {
        expect(f.snapshot()).toBe(before);
        return;
      }
      const after = f.snapshot();
      expect((await f.send(request)).envelope).toEqual(reply.envelope);
      expect(f.snapshot()).toBe(after);
      expect(
        (
          await f.send({
            ...request,
            input: all ? { id: "work-7" } : { all: true },
          })
        ).verdict,
      ).toEqual(["FAIL", "INPUT_CONFLICT", 4]);
      expect(f.snapshot()).toBe(after);
      expect(
        (await f.send({ ...request, requestId: "new-stop" })).result,
      ).toMatchObject({ epoch: all ? 2 : 6 });
      const audits = f.db
        .query(
          "SELECT body FROM state_records WHERE key LIKE 'lane-control:audit:%'",
        )
        .all() as { body: string }[];
      expect(audits).toHaveLength(2);
      for (const audit of audits)
        expect(JSON.parse(audit.body)).toMatchObject({
          value: { device: "laptop", session: "s1" },
        });
      expect((await control(f)).result).toMatchObject({ stopped: all });
      expect((await control(f, "work-7")).result).toMatchObject({
        stopped: true,
      });
      if (!all)
        expect((await control(f, "work-8")).result).toMatchObject({
          stopped: false,
        });
      if (!all) expect(reply.result).toEqual(stopped(5, "issue"));
    } finally {
      other?.close();
      f.close();
    }
  },
  10_000,
);
