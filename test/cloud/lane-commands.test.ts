import { expect, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Project } from "../../cloud/src/project.ts";
import { createWorker } from "../../cloud/src/worker.ts";
import { durableStore } from "../../cloud/src/store.ts";
import { StateOwner } from "../../src/core/state/index.ts";
import type { ResultEnvelope } from "../../src/generated/types.ts";
import { exitCode } from "../../src/surface/result.ts";
import {
  LANE_APPROVALS,
  laneApprovalStatus,
  type LaneApproval,
} from "../../cloud/src/lane-approval.ts";

if (!("timingSafeEqual" in crypto.subtle))
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    value: crypto.timingSafeEqual.bind(crypto),
  });
import { browserStorage } from "./browser-storage.fixture.ts";
import type { DeviceBrowserOptions } from "../../cloud/src/auth/device-browser.ts";
import type {
  IdentityClaims,
  IdentityResult,
} from "../../src/ports/identity.ts";
import { testIdentityVerifier } from "../contract/lib/identity-verifier.ts";
await mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
const { createConfiguredWorker } =
  await import("../../cloud/src/adapters/workers-oauth/compose.ts");
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
async function fixture(
  projectName = "p",
  session: string | null = "s1",
  browser: DeviceBrowserOptions = {},
) {
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const db = new Database(":memory:");
  let writes = 0;
  const { storage, values } = browserStorage(db, (sql) => {
    if (/^\s*(INSERT|UPDATE|DELETE|CREATE)\b/i.test(sql)) writes++;
  });
  const env = {
    FORGE_CLOUD_PROJECT: projectName,
    FORGE_CLOUD_ID_PREFIX: "forge",
    DEVICE_LOGIN_HMAC_KEY: Buffer.alloc(32, 7).toString("base64url"),
    CLERK_REDIRECT_URI: "https://w.example/callback",
    CLERK_ISSUER: "https://identity.example",
    CLERK_CLIENT_ID: "forge-cloud",
    FORGE_OWNER_SUBJECT: "user_Owner1",
    FORGE_API_RESOURCE: "https://w.example",
    OAUTH_TIMEOUT_MS: "5000",
  };
  const project = new Project({ storage }, env, browser);
  const reached: string[] = [];
  const bindings = {
    ...env,
    PROJECTS: {
      idFromName: (id: string) => id,
      get: (id: unknown) => {
        reached.push(String(id));
        return project;
      },
    },
  };
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
        LANE_APPROVALS,
      ].map((name) => db.query(`SELECT * FROM ${name}`).all()),
      [...values],
    ]);
  return {
    db,
    writes: () => writes,
    env,
    reached,
    browser: async (
      path: string,
      body?: string,
      headers: Record<string, string> = {},
      production = false,
    ) => {
      const response = await (
        production ? createConfiguredWorker() : createWorker()
      ).fetch(
        new Request(`https://w.example${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            ...headers,
          },
          ...(body === undefined ? {} : { body }),
        }),
        bindings,
      );
      return {
        status: response.status,
        headers: response.headers,
        text: await response.text(),
      };
    },
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
        status: response.status,
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
      expect(reply.status).toBe(409);
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
        for (let i = 0; i < 4; i++) {
          const ask = await f.send(call("lane.resume", scope, `ask-${i}`));
          expect(ask.verdict).toEqual(["FAIL", "APPROVAL_REQUIRED", 1]);
          expect(ask.status).toBe(409);
        }
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
      if (code === "APPROVAL_REQUIRED") expect(reply.status).toBe(409);
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
            ? LANE_APPROVALS
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
      expect(reply.status).toBe(409);
      const rows = () =>
        (
          JSON.parse(
            String(
              (
                f.db
                  .query(`SELECT state FROM ${LANE_APPROVALS} WHERE id=1`)
                  .get() as { state: string }
              ).state,
            ),
          ) as {
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
          const ask = await f.send(
            call("lane.resume", { all: true }, `ask-${i}`),
            "p",
            { authorization: `Bearer ${token}` },
          );
          expect(ask.verdict).toEqual(["FAIL", "APPROVAL_REQUIRED", 1]);
          expect(ask.status).toBe(409);
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
          const ask = await f.send(
            call("lane.resume", { all: true }, `ask-${i}`),
          );
          expect(ask.verdict).toEqual(["FAIL", "APPROVAL_REQUIRED", 1]);
          expect(ask.status).toBe(409);
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

const pageCookie = (page: { headers: Headers }) =>
  (page.headers.get("set-cookie") ?? "").split(";")[0]!;
const pageTicket = (page: { text: string }, action: string) =>
  new RegExp(
    `/${action}"><input type="hidden" name="ticket" value="([^"]+)"`,
  ).exec(page.text)?.[1] ?? "";
async function browserFixture(
  scope: "all" | "issue" = "all",
  issuer = "https://identity.example",
  verify?: NonNullable<DeviceBrowserOptions["upstream"]>["verify"],
) {
  const begun: { state: string; verifier: string }[] = [];
  const spent = new Set<string>();
  let duringBegin = () => {};
  let duringClaim = () => {};
  const f = await fixture("p", "s1", {
    upstream: {
      begin: (state, verifier) => {
        begun.push({ state, verifier });
        return Promise.resolve().then(() => {
          duringBegin();
          return `${new URL("/oauth/authorize", issuer).href}?state=${state}&redirect_uri=https%3A%2F%2Fw.example%2Fcallback`;
        });
      },
      verify:
        verify ??
        (() => {
          throw new Error("This slice must not verify an owner");
        }),
    },
    redemption: {
      claimOnce: (hash) => {
        const won = !spent.has(hash);
        spent.add(hash);
        return Promise.resolve().then(() => {
          duringClaim();
          return won;
        });
      },
    },
  });
  f.env.CLERK_ISSUER = issuer;
  f.put("lane-control:global", running);
  const input = scope === "all" ? { all: true } : { id: "work-7" };
  await f.send(call("lane.stop", input, "browser-stop"));
  const reply = await f.send(call("lane.resume", input, "browser-ask"));
  expect(reply.verdict).toEqual(["FAIL", "APPROVAL_REQUIRED", 1]);
  expect(reply.status).toBe(409);
  const pending = (
    reply.envelope as unknown as {
      result: { request: string; expiresAt: string };
    }
  ).result;
  const path = `/lane-approval/${pending.request}`;
  const shown = await f.browser(path);
  const cookie = pageCookie(shown);
  const submit = (
    action = "approve",
    ticket = pageTicket(shown, action),
    extra: Record<string, string> = {},
  ) =>
    f.browser(`${path}/${action}`, new URLSearchParams({ ticket }).toString(), {
      Origin: "https://w.example",
      Cookie: cookie,
      ...extra,
    });
  return {
    ...f,
    path,
    shown,
    pending,
    cookie,
    submit,
    begun,
    spent,
    duringBegin: (run: () => void) => {
      duringBegin = run;
    },
    duringClaim: (run: () => void) => {
      duringClaim = run;
    },
  };
}

test.each(["all", "issue"] as const)(
  "lane browser preview is read-only for %s",
  async (scope) => {
    const f = await browserFixture(scope);
    try {
      const before = f.snapshot(),
        writes = f.writes();
      const page = await f.browser(f.path, undefined, {
        Host: "evil.example",
        Origin: "https://evil.example",
        "X-Forwarded-Host": "evil.example",
      });
      expect(page.status).toBe(200);
      for (const text of [
        "p",
        scope === "all" ? "ALL LANES" : "work-7",
        "Affected scope",
        "Current stop",
        f.pending.expiresAt,
        "https://w.example/lane-approval/",
      ])
        expect(page.text).toContain(text);
      expect(page.text).not.toContain("evil.example");
      expect(page.headers.get("cache-control")).toBe("no-store");
      expect(page.headers.get("content-security-policy")).toContain(
        "frame-ancestors 'none'",
      );
      expect([f.snapshot(), f.writes(), f.begun.length, f.spent.size]).toEqual([
        before,
        writes,
        0,
        0,
      ]);
    } finally {
      f.close();
    }
  },
  10_000,
);

test.each([
  "unknown",
  "expired",
  "epoch",
  "incarnation",
  "spent",
  "policy",
  "revoked",
])(
  "lane preview refuses %s without writes or actions",
  async (mode) => {
    const f = await browserFixture();
    try {
      if (mode === "expired") f.clock.mockReturnValue(now + 600_000);
      if (mode === "epoch" || mode === "incarnation") {
        const old = f.owner.get("forge/work", "lane-control:global")!;
        f.owner.put(
          "forge/work",
          old.key,
          {
            ...(old.value as object),
            ...(mode === "epoch" ? { epoch: 99 } : { incarnation: "new" }),
          },
          actor,
          { expectRevision: old.revision },
        );
      }
      if (mode === "spent")
        f.db.run(
          `UPDATE ${LANE_APPROVALS} SET state=json_set(state, '$.requests[0].status', 'spent')`,
        );
      if (mode === "policy") f.env.FORGE_OWNER_SUBJECT = "user_Other2";
      if (mode === "revoked")
        f.db.run("UPDATE domain_cloud_tokens SET revoked_at=?", [now]);
      const before = f.snapshot(),
        writes = f.writes();
      const page = await f.browser(
        mode === "unknown" ? "/lane-approval/unknown" : f.path,
      );
      expect(page.status).toBe(400);
      expect(page.text).not.toContain("<form");
      expect(page.headers.get("set-cookie")).toBeNull();
      expect([f.snapshot(), f.writes()]).toEqual([before, writes]);
    } finally {
      f.close();
    }
  },
  10_000,
);

test.each(["approve", "deny"])(
  "lane %s starts Clerk once and leaves approval pending",
  async (action) => {
    const f = await browserFixture();
    try {
      const before = f.snapshot();
      const replies = await Promise.all([f.submit(action), f.submit(action)]);
      expect(replies.map((r) => r.status).sort()).toEqual([302, 400]);
      const reply = replies.find((r) => r.status === 302)!;
      expect(f.begun).toHaveLength(1);
      expect(f.begun[0]!.state).toMatch(/^forge-lane\./);
      expect(f.begun[0]!.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
      for (const part of [
        "__Host-forge_lane_",
        "Secure",
        "HttpOnly",
        "SameSite=Lax",
        "Path=/",
      ])
        expect(reply.headers.get("set-cookie")).toContain(part);
      expect(reply.headers.get("set-cookie")).not.toContain("Domain=");
      expect(
        new URL(reply.headers.get("location")!).searchParams.get(
          "redirect_uri",
        ),
      ).toBe("https://w.example/callback");
      expect(f.snapshot()).toBe(before);
      expect((await f.submit(action)).status).toBe(400);
    } finally {
      f.close();
    }
  },
  10_000,
);

test.each([
  "foreign origin",
  "missing origin",
  "missing ticket",
  "device ticket",
  "other action",
  "other browser",
  "device cookie",
  "duplicate",
  "unknown field",
  "expired",
  "changed during upstream",
])(
  "lane start refuses %s",
  async (mode) => {
    const f = await browserFixture();
    try {
      let fields = new URLSearchParams({
        ticket: pageTicket(
          f.shown,
          mode === "other action" ? "deny" : "approve",
        ),
      }).toString();
      const headers: Record<string, string> = {
        Origin: "https://w.example",
        Cookie: f.cookie,
      };
      if (mode === "foreign origin") headers.Origin = "https://evil.example";
      if (mode === "missing origin") delete headers.Origin;
      if (mode === "missing ticket") fields = "";
      if (mode === "device ticket") fields = `ticket=${"a".repeat(43)}`;
      if (mode === "other browser")
        headers.Cookie = `__Host-forge_lane_preview=${"x".repeat(43)}`;
      if (mode === "device cookie")
        headers.Cookie = `__Host-forge_device=${"x".repeat(43)}`;
      if (mode === "duplicate") fields += `&${fields}`;
      if (mode === "unknown field") fields += "&owner=yes";
      if (mode === "expired") f.clock.mockReturnValue(now + 600_000);
      if (mode === "changed during upstream")
        f.duringBegin(() => {
          f.env.FORGE_OWNER_SUBJECT = "user_Other2";
        });
      const before = f.snapshot();
      const reply = await f.browser(`${f.path}/approve`, fields, headers);
      expect(reply.status).toBe(400);
      expect(reply.headers.get("location")).toBeNull();
      expect(f.snapshot()).toBe(before);
      if (mode !== "changed during upstream")
        expect([f.begun.length, f.spent.size]).toEqual([0, 0]);
      if (
        [
          "foreign origin",
          "missing origin",
          "duplicate",
          "unknown field",
        ].includes(mode)
      )
        expect((await f.submit()).status).toBe(302);
    } finally {
      f.close();
    }
  },
  10_000,
);

test.each(["lane", "mixed lane and device", "device", "generic"])(
  "production callback routes %s in its own domain",
  async (mode) => {
    const f = await browserFixture();
    try {
      const states =
        mode === "lane"
          ? ["forge-lane.state"]
          : mode === "mixed lane and device"
            ? ["forge-device.state", "forge-lane.state"]
            : [mode === "device" ? "forge-device.state" : "generic-state"];
      const query = new URLSearchParams(
        states.map((state): [string, string] => ["state", state]),
      );
      const reached = f.reached.length,
        before = f.snapshot();
      const reply = await f.browser(
        `/callback?${query}`,
        undefined,
        {
          Cookie:
            "__Host-forge_device=foreign; __Host-forge_lane_wrong=foreign",
          "CF-Connecting-IP": "203.0.113.1",
        },
        true,
      );
      expect(reply.status).toBe(mode === "generic" ? 503 : 400);
      expect(f.reached.length - reached).toBe(mode === "generic" ? 0 : 1);
      if (mode.includes("lane"))
        expect(reply.text).toContain("This request cannot be used.");
      if (mode !== "device") expect(f.snapshot()).toBe(before);
      expect(f.begun).toEqual([]);
    } finally {
      f.close();
    }
  },
  10_000,
);

const approvalRows = (f: Fixture) =>
  (
    JSON.parse(
      String(
        (
          f.db
            .query(`SELECT state FROM ${LANE_APPROVALS} WHERE id=1`)
            .get() as { state: string }
        ).state,
      ),
    ) as { requests: LaneApproval[] }
  ).requests;
const ownerClaims: IdentityClaims = {
  issuer: "https://identity.example",
  subject: "user_Owner1",
  audience: "forge-cloud",
  authenticatedAt: now - 1_000,
  expiresAt: now + 3_600_000,
};
const ownerProof = (changes: Partial<IdentityClaims> = {}) => {
  const claims = { ...ownerClaims, ...changes };
  return testIdentityVerifier(new Map([["owner", claims]])).verify(
    "owner",
    claims.audience,
    now,
  );
};
type BrowserFixture = Awaited<ReturnType<typeof browserFixture>>;
async function laneReturn(
  f: BrowserFixture,
  action = "approve",
  code = "owner",
) {
  const start = await f.submit(action);
  expect(start.status).toBe(302);
  return {
    path: `/callback?state=${f.begun.at(-1)!.state}&code=${code}`,
    cookie: pageCookie(start),
  };
}

test.each([
  "approve all",
  "deny all",
  "approve issue",
  "deny issue",
  "hostile headers",
])(
  "lane callback records only the owner decision: %s",
  async (mode) => {
    const verified: string[] = [];
    const f = await browserFixture(
      mode.endsWith("issue") ? "issue" : "all",
      undefined,
      async (_request, _at, verifier) => {
        verified.push(verifier);
        return ownerProof();
      },
    );
    try {
      const action = mode.startsWith("deny") ? "deny" : "approve";
      const back = await laneReturn(f, action);
      const before = [
        f.owner.get("forge/work", "lane-control:global"),
        f.owner.get("forge/work", "lane-control:work-7"),
      ];
      const reply = await f.browser(
        back.path,
        undefined,
        {
          Cookie: back.cookie,
          Host: "evil.example",
          Origin: "https://evil.example",
          "X-Forwarded-Host": "evil.example",
        },
        true,
      );
      expect(reply.status).toBe(200);
      expect(reply.text).toContain(
        action === "approve" ? "approved" : "denied",
      );
      expect(reply.text).not.toContain("evil.example");
      expect(reply.headers.get("location")).toBeNull();
      expect(reply.headers.get("cache-control")).toBe("no-store");
      expect(approvalRows(f)[0]).toMatchObject({
        status: action === "approve" ? "approved" : "denied",
        expiresAt: f.pending.expiresAt,
        decision: {
          issuer: ownerClaims.issuer,
          subject: ownerClaims.subject,
          at: new Date(now).toISOString(),
        },
      });
      expect([
        f.owner.get("forge/work", "lane-control:global"),
        f.owner.get("forge/work", "lane-control:work-7"),
      ]).toEqual(before);
      expect(verified).toEqual([f.begun[0]!.verifier]);
      const decided = f.snapshot();
      expect(
        (await f.browser(back.path, undefined, { Cookie: back.cookie }, true))
          .status,
      ).toBe(400);
      expect(f.snapshot()).toBe(decided);
      expect(verified).toHaveLength(1);
    } finally {
      f.close();
    }
  },
  10_000,
);

test.each([
  "subject",
  "issuer",
  "audience",
  "expired identity",
  "future identity",
  "unbranded",
  "exchange failure",
  "invalid proof",
  "missing cookie",
  "foreign cookie",
  "device cookie",
  "duplicate cookie",
  "duplicate state",
  "device state",
  "expired state",
  "post",
])(
  "lane callback refuses %s without recording a decision",
  async (mode) => {
    let calls = 0;
    const f = await browserFixture("all", undefined, async () => {
      calls++;
      if (mode === "exchange failure")
        throw new Error("Injected exchange failure");
      if (mode === "invalid proof")
        return { ok: false, reason: "invalid_proof" };
      if (mode === "unbranded")
        return { ok: true, identity: ownerClaims } as IdentityResult;
      return ownerProof({
        ...(mode === "subject" ? { subject: "user_Other2" } : {}),
        ...(mode === "issuer" ? { issuer: "https://other.example" } : {}),
        ...(mode === "audience" ? { audience: "other" } : {}),
        ...(mode === "expired identity" ? { expiresAt: now } : {}),
        ...(mode === "future identity" ? { authenticatedAt: now + 1 } : {}),
      });
    });
    try {
      const back = await laneReturn(f);
      let cookie = back.cookie,
        path = back.path;
      if (mode === "missing cookie") cookie = "";
      if (mode === "foreign cookie")
        cookie = back.cookie.split("=")[0] + "=" + "x".repeat(43);
      if (mode === "device cookie")
        cookie = back.cookie.replace("forge_lane_", "forge_device_");
      if (mode === "duplicate cookie") cookie += `; ${cookie}`;
      if (mode === "duplicate state") path += `&state=${f.begun[0]!.state}`;
      if (mode === "device state")
        path = path.replace("forge-lane.", "forge-device.");
      if (mode === "expired state") f.clock.mockReturnValue(now + 600_000);
      const before = f.snapshot();
      const reply = await f.browser(
        path,
        mode === "post" ? "" : undefined,
        { Cookie: cookie, "CF-Connecting-IP": "203.0.113.1" },
        true,
      );
      expect(reply.status).toBe(400);
      expect(f.snapshot()).toBe(before);
      expect(approvalRows(f)[0]!.status).toBe("pending");
      if (
        mode.includes("cookie") ||
        ["duplicate state", "device state", "expired state", "post"].includes(
          mode,
        )
      )
        expect(calls).toBe(0);
    } finally {
      f.close();
    }
  },
  10_000,
);

test.each(
  ["claim", "exchange"].flatMap((phase) =>
    [
      "expiry",
      "epoch",
      "incarnation",
      "owner",
      "issuer",
      "audience",
      "revoke",
      "token expiry",
      "device",
      "session",
    ].map((change) => [phase, change] as const),
  ),
)(
  "lane callback rechecks after %s await: %s",
  async (phase, change) => {
    let mutate = () => {},
      calls = 0;
    const f = await browserFixture("all", undefined, async () => {
      calls++;
      const proof = await ownerProof();
      if (phase === "exchange") mutate();
      return proof;
    });
    try {
      const back = await laneReturn(f);
      let expected = "";
      mutate = () => {
        if (change === "expiry") f.clock.mockReturnValue(now + 600_000);
        if (change === "epoch" || change === "incarnation") {
          const old = f.owner.get("forge/work", "lane-control:global")!;
          f.owner.put(
            "forge/work",
            old.key,
            {
              ...(old.value as object),
              ...(change === "epoch"
                ? { epoch: 99 }
                : { incarnation: "replacement" }),
            },
            actor,
            { expectRevision: old.revision },
          );
        }
        if (change === "owner") f.env.FORGE_OWNER_SUBJECT = "user_Other2";
        if (change === "issuer") f.env.CLERK_ISSUER = "https://other.example";
        if (change === "audience") f.env.CLERK_CLIENT_ID = "other";
        if (change === "revoke")
          f.db.run("UPDATE domain_cloud_tokens SET revoked_at=?", [now]);
        if (change === "token expiry")
          f.db.run("UPDATE domain_cloud_tokens SET expires_at=?", [now]);
        if (change === "device")
          f.db.run("UPDATE domain_cloud_tokens SET device='other'");
        if (change === "session")
          f.db.run("UPDATE domain_cloud_tokens SET session='other'");
        expected = f.snapshot();
      };
      if (phase === "claim") f.duringClaim(mutate);
      expect(
        (await f.browser(back.path, undefined, { Cookie: back.cookie }, true))
          .status,
      ).toBe(400);
      expect(f.snapshot()).toBe(expected);
      expect(approvalRows(f)[0]!.status).toBe("pending");
      expect(calls).toBe(phase === "claim" ? 0 : 1);
    } finally {
      f.close();
    }
  },
  10_000,
);

test.each([
  "same state",
  "opposite actions",
  "same code after failure",
  "write failure",
])(
  "lane callback atomicity: %s",
  async (mode) => {
    let calls = 0;
    const f = await browserFixture("all", undefined, async () => {
      calls++;
      const proof = await ownerProof();
      return mode === "same code after failure"
        ? { ok: false, reason: "invalid_proof" }
        : proof;
    });
    try {
      const first = await laneReturn(f),
        before = f.snapshot();
      const second =
        mode === "same state" || mode === "write failure"
          ? first
          : await laneReturn(
              f,
              "deny",
              mode === "same code after failure" ? "owner" : "other-code",
            );
      if (mode === "write failure")
        f.db.run(
          `CREATE TRIGGER refuse_decision BEFORE UPDATE ON ${LANE_APPROVALS} BEGIN SELECT RAISE(ABORT, 'injected decision failure'); END`,
        );
      const returns = [first, second].map(
        (back) => () =>
          f.browser(back.path, undefined, { Cookie: back.cookie }, true),
      );
      const replies =
        mode === "same code after failure"
          ? [await returns[0]!(), await returns[1]!()]
          : await Promise.all(returns.map((run) => run()));
      if (mode === "write failure") {
        expect(replies.every((reply) => reply.status >= 400)).toBe(true);
        expect(f.snapshot()).toBe(before);
      } else if (mode === "same code after failure") {
        expect(replies.map((reply) => reply.status)).toEqual([400, 400]);
        expect(calls).toBe(1);
        expect(f.snapshot()).toBe(before);
      } else {
        expect(replies.map((reply) => reply.status).sort()).toEqual([200, 400]);
        expect(
          approvalRows(f).filter((row) =>
            ["approved", "denied"].includes(row.status),
          ),
        ).toHaveLength(1);
      }
    } finally {
      f.close();
    }
  },
  10_000,
);

test.each(["https://identity.example", "https://other-clerk.example:8443/"])(
  "lane preview CSP allows exactly the configured Clerk origin %s",
  async (issuer) => {
    const f = await browserFixture("all", issuer);
    try {
      const page = await f.browser(f.path, undefined, {
        Host: "evil.example",
        Origin: "https://evil.example",
        "X-Forwarded-Host": "evil.example",
      });
      expect(page.status).toBe(200);
      expect(page.headers.get("content-security-policy")).toBe(
        `default-src 'none'; form-action 'self' ${new URL(issuer).origin}; frame-ancestors 'none'`,
      );
    } finally {
      f.close();
    }
  },
  10_000,
);

test.each(["approve", "deny"])(
  "repeated %s starts on one request leave capacity for another",
  async (action) => {
    const f = await browserFixture();
    try {
      const other = await f.send(
        call("lane.resume", { all: true }, "other-browser-ask"),
      );
      expect(other.verdict).toEqual(["FAIL", "APPROVAL_REQUIRED", 1]);
      expect(other.status).toBe(409);
      const otherId = (
        other.envelope as unknown as { result: { request: string } }
      ).result.request;
      for (let n = 0; n < 257; n++) {
        const page = await f.browser(f.path);
        const reply = await f.browser(
          `${f.path}/${action}`,
          new URLSearchParams({ ticket: pageTicket(page, action) }).toString(),
          { Origin: "https://w.example", Cookie: pageCookie(page) },
        );
        expect(reply.status).toBe(302);
      }
      const path = `/lane-approval/${otherId}`;
      const page = await f.browser(path);
      const reply = await f.browser(
        `${path}/${action}`,
        new URLSearchParams({ ticket: pageTicket(page, action) }).toString(),
        { Origin: "https://w.example", Cookie: pageCookie(page) },
      );
      expect(reply.status).toBe(302);
      const stored = f.db
        .query("SELECT state FROM domain_cloud_lane_browser WHERE id=1")
        .get() as { state: string };
      const states = JSON.parse(stored.state) as {
        request: string;
        action: string;
      }[];
      expect(states.map((entry) => [entry.request, entry.action])).toEqual([
        [f.pending.request, action],
        [otherId, action],
      ]);
    } finally {
      f.close();
    }
  },
  10_000,
);

test.each(
  ["approve", "deny"].flatMap((action) =>
    ["cancelled", "failed upstream"].map((mode) => [action, mode] as const),
  ),
)(
  "reloading the same browser permits a new %s start after %s",
  async (action, mode) => {
    const f = await browserFixture();
    try {
      const oldTicket = pageTicket(f.shown, action);
      if (mode === "failed upstream")
        f.duringBegin(() => {
          throw new Error("Injected upstream start failure");
        });
      expect((await f.submit(action)).status).toBe(
        mode === "failed upstream" ? 503 : 302,
      );
      f.duringBegin(() => {});
      const before = f.snapshot(),
        writes = f.writes();
      const reloaded = await f.browser(f.path, undefined, { Cookie: f.cookie });
      expect(reloaded.status).toBe(200);
      expect(pageCookie(reloaded)).toBe(f.cookie);
      expect([f.snapshot(), f.writes()]).toEqual([before, writes]);
      const newTicket = pageTicket(reloaded, action);
      expect(newTicket).toMatch(/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
      expect(newTicket).not.toBe(oldTicket);
      expect((await f.submit(action, newTicket)).status).toBe(302);
      expect((await f.submit(action, oldTicket)).status).toBe(400);
      expect(f.begun).toHaveLength(2);
    } finally {
      f.close();
    }
  },
  10_000,
);
