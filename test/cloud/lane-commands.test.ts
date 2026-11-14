import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Project } from "../../cloud/src/project.ts";
import { createWorker } from "../../cloud/src/worker.ts";
import { durableStore, type DurableStorage } from "../../cloud/src/store.ts";
import { StateOwner } from "../../src/core/state/index.ts";
import type { ResultEnvelope } from "../../src/generated/types.ts";
import { exitCode } from "../../src/surface/result.ts";
import {
  laneApprovalStatus,
  type LaneApproval,
} from "../../cloud/src/lane-approval.ts";

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
async function fixture(projectName = "p", session: string | null = "s1") {
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
    {
      FORGE_CLOUD_PROJECT: projectName,
      FORGE_CLOUD_ID_PREFIX: "forge",
      CLERK_REDIRECT_URI: "https://w.example/callback",
      CLERK_ISSUER: "https://identity.example",
      CLERK_CLIENT_ID: "forge-cloud",
      FORGE_OWNER_SUBJECT: "owner",
    },
  );
  const admit = async (device: string) => {
    const admitted = await project.fetch(
      new Request(`https://w.example/p/${projectName}/devices`, {
        method: "POST",
        body: JSON.stringify({
          device,
          ...(session === null ? {} : { session }),
          ttlMs: 86_400_000,
        }),
      }),
    );
    return ((await admitted.json()) as { value: { token: string } }).value
      .token;
  };
  const token = await admit("laptop");
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
    clock,
    admit,
    snapshot,
    close: () => {
      db.close();
      clock.mockRestore();
    },
    send: async (body: unknown, route = projectName, headers = {}) => {
      const response = await createWorker().fetch(
        new Request(`https://w.example/p/${route}/command`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, ...headers },
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

test.each([
  "one",
  "all",
  "dry one",
  "dry all",
  "foreign route",
  "device token",
])(
  "lane.stop %s through the authenticated command route",
  async (mode) => {
    const f = await fixture("p", mode === "device token" ? null : "s1");
    const other = mode === "foreign route" ? await fixture("other") : undefined;
    try {
      const all = mode.endsWith("all");
      const dryRun = mode.startsWith("dry");
      if (!all) f.put("lane-control:global", running);
      const before = f.snapshot();
      const otherBefore = other?.snapshot() ?? "";
      const unchanged = f.owner.get("forge/work", "issue:work-8");
      const otherControl = f.owner.get("forge/work", "lane-control:work-8");
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
      expect(f.owner.get("forge/work", "lane-control:work-8")).toEqual(
        otherControl,
      );
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
      const auditSession =
        mode === "device token"
          ? (
              f.db.query("SELECT id FROM domain_cloud_tokens").get() as {
                id: string;
              }
            ).id
          : "s1";
      for (const audit of audits)
        expect(JSON.parse(audit.body)).toMatchObject({
          value: { device: "laptop", session: auditSession },
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

test.each([
  { op: "lane.control", dryRun: false },
  { op: "lane.stop", dryRun: false },
  { op: "lane.stop", dryRun: true },
  { op: "lane.resume", dryRun: false },
])(
  "a device-only token cannot claim a session for %j",
  async ({ op, dryRun }) => {
    const f = await fixture("p", null);
    try {
      f.put("lane-control:global", running);
      const before = f.snapshot();
      const reply = await f.send(
        call(op, { id: "work-7" }, "claimed-session", {
          dryRun,
          context: { actor, session: { id: "untrusted-session" } },
        }),
      );
      expect(reply.verdict).toEqual(["FAIL", "AUTH_DEVICE_MISMATCH", 1]);
      expect(f.snapshot()).toBe(before);
    } finally {
      f.close();
    }
  },
  10_000,
);

test.each([
  "issue",
  "all",
  "all issue stops",
  "device token",
  "hostile headers",
])(
  "lane.resume creates one exact pending request for %s without changing control",
  async (mode) => {
    const f = await fixture("p", mode === "device token" ? null : "s1");
    try {
      const scope = mode.startsWith("all") ? { all: true } : { id: "work-7" };
      await f.send(call("lane.stop", { all: true }, "initialize"));
      // An issue resume cannot clear a project-wide stop.
      if (mode !== "all") {
        f.owner.put("forge/work", "lane-control:global", running, actor, {
          expectRevision: 1,
        });
        await f.send(call("lane.stop", { id: "work-7" }, "stop-issue"));
      }
      const before = [
        f.owner.get("forge/work", "lane-control:global"),
        f.owner.get("forge/work", "lane-control:work-7"),
      ];
      const request = call("lane.resume", scope, "ask");
      const headers =
        mode === "hostile headers"
          ? {
              Host: "evil.example",
              Origin: "https://evil.example",
              "X-Forwarded-Host": "evil.example",
            }
          : {};
      const reply = await f.send(request, "p", headers);
      expect(reply.verdict).toEqual(["FAIL", "APPROVAL_REQUIRED", 1]);
      expect(reply.envelope).toMatchObject({
        ok: false,
        status: "FAIL",
        result: {
          scope,
          expiresAt: new Date(now + 600_000).toISOString(),
        },
      });
      const pending = (
        reply.envelope as unknown as {
          result: { request: string; url: string };
        }
      ).result;
      expect(pending.request).toMatch(/^[a-f0-9-]+$/);
      expect(pending.url).toBe(
        `https://w.example/lane-approval/${pending.request}`,
      );
      const after = f.snapshot();
      expect((await f.send(request)).envelope).toEqual(reply.envelope);
      expect(f.snapshot()).toBe(after);
      expect(
        (
          await f.send({
            ...request,
            input: mode.startsWith("all") ? { id: "work-7" } : { all: true },
          })
        ).verdict,
      ).toEqual(["FAIL", "INPUT_CONFLICT", 4]);
      expect(f.snapshot()).toBe(after);
      expect([
        f.owner.get("forge/work", "lane-control:global"),
        f.owner.get("forge/work", "lane-control:work-7"),
      ]).toEqual(before);
    } finally {
      f.close();
    }
  },
  10_000,
);

test.each(["running", "global stop", "foreign route", "device cap", "expired"])(
  "lane.resume refuses or expires safely for %s",
  async (mode) => {
    const f = await fixture();
    try {
      f.put("lane-control:global", running);
      if (mode !== "running")
        await f.send(call("lane.stop", { all: true }, "stop"));
      const scope = mode === "global stop" ? { id: "work-7" } : { all: true };
      if (mode === "device cap" || mode === "expired")
        for (let i = 0; i < 4; i++)
          expect(
            (await f.send(call("lane.resume", scope, `ask-${i}`))).verdict,
          ).toEqual(["FAIL", "APPROVAL_REQUIRED", 1]);
      if (mode === "expired") f.clock.mockReturnValue(now + 600_000);
      const before = f.snapshot();
      const reply = await f.send(
        call("lane.resume", scope, "ask-final"),
        mode === "foreign route" ? "other" : "p",
      );
      const code =
        mode === "device cap"
          ? "UNAVAILABLE"
          : mode === "foreign route"
            ? "AUTH_FORBIDDEN"
            : mode === "expired"
              ? "APPROVAL_REQUIRED"
              : "INPUT_CONFLICT";
      expect(reply.verdict).toEqual([
        "FAIL",
        code,
        code === "INPUT_CONFLICT" ? 4 : 1,
      ]);
      if (mode !== "expired") expect(f.snapshot()).toBe(before);
      if (mode === "expired")
        expect(reply.envelope).toMatchObject({
          result: { expiresAt: new Date(now + 1_200_000).toISOString() },
        });
    } finally {
      f.close();
    }
  },
  10_000,
);

test.each(["audit", "receipt", "approval", "approval receipt"])(
  "a failed %s rolls back control, events and receipt together",
  async (where) => {
    const f = await fixture();
    try {
      f.put("lane-control:global", running);
      if (where.startsWith("approval"))
        await f.send(call("lane.stop", { all: true }, "stop"));
      const before = f.snapshot();
      const target =
        where === "audit"
          ? "state_records WHEN NEW.key LIKE 'lane-control:audit:%'"
          : where === "approval"
            ? "state_records WHEN NEW.key = 'lane-approval:requests'"
            : "domain_cloud_command_receipts";
      f.db.run(
        `CREATE TRIGGER refuse_write BEFORE INSERT ON ${target} BEGIN SELECT RAISE(ABORT, 'injected write failure'); END`,
      );
      const reply = await f.send(
        where.startsWith("approval")
          ? call("lane.resume", { all: true })
          : call("lane.stop", { id: "work-7" }),
      );
      expect(reply.envelope.ok).toBe(false);
      expect(f.snapshot()).toBe(before);
    } finally {
      f.close();
    }
  },
  10_000,
);

test.each(["project cap", "expired", "epoch", "incarnation", "retention"])(
  "pending approval lifecycle: %s",
  async (mode) => {
    const f = await fixture();
    try {
      await f.send(call("lane.stop", { all: true }, "stop"));
      const reply = await f.send(call("lane.resume", { all: true }, "ask"));
      expect(reply.verdict).toEqual(["FAIL", "APPROVAL_REQUIRED", 1]);
      const rows = () =>
        (
          f.owner.get("forge/work", "lane-approval:requests")!.value as {
            requests: LaneApproval[];
          }
        ).requests;
      const row = rows()[0]!;
      expect(row).toMatchObject({
        project: "p",
        scope: { all: true },
        device: "laptop",
        session: "s1",
        epoch: 1,
      });
      expect(typeof row.policyIdentity).toBe("string");
      expect(typeof row.token).toBe("string");
      if (mode === "project cap") {
        for (let i = 1; i < 64; i++) {
          const token = await f.admit(`device-${Math.floor(i / 4)}`);
          expect(
            (
              await f.send(
                call("lane.resume", { all: true }, `ask-${i}`),
                "p",
                { authorization: `Bearer ${token}` },
              )
            ).verdict,
          ).toEqual(["FAIL", "APPROVAL_REQUIRED", 1]);
        }
        const token = await f.admit("overflow");
        const admitted = f.snapshot();
        expect(
          (
            await f.send(call("lane.resume", { all: true }, "overflow"), "p", {
              authorization: `Bearer ${token}`,
            })
          ).verdict,
        ).toEqual(["FAIL", "UNAVAILABLE", 1]);
        expect(f.snapshot()).toBe(admitted);
        expect(rows()).toHaveLength(64);
      } else if (mode === "retention") {
        for (let i = 1; i <= 66; i++) {
          f.clock.mockReturnValue(now + i * 600_000);
          expect(
            (await f.send(call("lane.resume", { all: true }, `ask-${i}`)))
              .verdict,
          ).toEqual(["FAIL", "APPROVAL_REQUIRED", 1]);
        }
        expect(
          rows().filter((entry) => entry.status === "expired"),
        ).toHaveLength(64);
        expect(
          rows().filter((entry) => entry.status === "pending"),
        ).toHaveLength(1);
        // Trimming current state must also bound request data retained in event snapshots.
        const history = f.db
          .query(
            "SELECT body FROM state_events WHERE namespace='forge/work' AND key='lane-approval:requests'",
          )
          .all() as { body: string }[];
        const persisted = history.flatMap(
          ({ body }) =>
            (JSON.parse(body) as { data?: { requests?: LaneApproval[] } }).data
              ?.requests ?? [],
        );
        expect(
          new Set([...rows(), ...persisted].map((entry) => entry.request)).size,
        ).toBeLessThanOrEqual(65);
      } else {
        if (mode === "epoch")
          await f.send(call("lane.stop", { all: true }, "new-stop"));
        const current = (await control(f)).result as {
          incarnation: string;
          epoch: number;
          stopped: boolean;
        };
        const before = f.snapshot();
        const observed =
          mode === "incarnation"
            ? { ...current, incarnation: "replacement" }
            : current;
        expect(
          laneApprovalStatus(
            row,
            observed,
            mode === "expired" ? now + 600_000 : now,
          ),
        ).toBe(mode === "expired" ? "expired" : "stale");
        expect(f.snapshot()).toBe(before);
      }
    } finally {
      f.close();
    }
  },
  10_000,
);
