import { expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { scratchStorage } from "../../cloud/conformance/storage.ts";
import { pagesOf, tinySource } from "../../cloud/conformance/max-source.ts";
import { Project, domain } from "../../cloud/src/project.ts";
import { durableStore, type DurableStorage } from "../../cloud/src/store.ts";
import { StateOwner } from "../../src/core/state/index.ts";
import { LaneControlStore } from "../../cloud/src/lane-control-store.ts";
import { createDeviceLogin } from "../../cloud/src/auth/device-login.ts";
import {
  importLoginKey,
  loginStore,
} from "../../cloud/src/auth/project-login.ts";
import { issueToken } from "../../cloud/src/tokens.ts";
import { testIdentityVerifier } from "../contract/lib/identity-verifier.ts";

setDefaultTimeout(30_000);
const limits = [
  [
    "Exceeded allowed rows written in Durable Objects free tier.",
    "QUOTA_EXHAUSTED",
  ],
  ["database or disk is full: SQLITE_FULL", "STORAGE_LIMIT_EXCEEDED"],
] as const;
const env = {
  FORGE_CLOUD_PROJECT: "quota",
  DEVICE_LOGIN_HMAC_KEY: "A".repeat(43),
  CLERK_ISSUER: "https://clerk.test",
  FORGE_OWNER_SUBJECT: "synthetic-owner",
  CLERK_CLIENT_ID: "synthetic-client",
};
function fixture() {
  const raw = scratchStorage(Database);
  let fault = (_sql: string, _bindings: readonly unknown[]) => {};
  const storage: DurableStorage = {
    ...raw.storage,
    sql: {
      exec: (sql, ...bindings) => {
        fault(sql, bindings);
        return raw.storage.sql.exec(sql, ...bindings);
      },
    },
  };
  return {
    ...raw,
    storage,
    fail: (next: typeof fault) => {
      fault = next;
    },
    open: () => {
      const db = durableStore(storage);
      const owner = new StateOwner(db, { now: () => 1_000 });
      owner.initialize([domain]);
      return { db, owner };
    },
  };
}
const send = (project: Project, route: string, body: unknown) =>
  project.fetch(
    new Request(`https://forge.test/p/quota/${route}`, {
      method: "POST",
      headers: { "CF-Connecting-IP": "192.0.2.1" },
      body: JSON.stringify(body),
    }),
  );

for (const [message, code] of limits) {
  for (const cold of [false, true]) {
    test(`checkpoint put ${code} cannot provision partial restore ${cold ? "cold" : "warm"}`, async () => {
      const f = fixture();
      try {
        const source = await tinySource("checkpoint boundary synthetic");
        const page = pagesOf(source.tables, 1)[0]!;
        expect(page.last).toBe(false);
        let failed = 0;
        const storage: DurableStorage = {
          ...f.storage,
          put: (key, value) => {
            if (key === "restore:next") {
              failed++;
              return Promise.reject(new Error(message));
            }
            return f.storage.put(key, value);
          },
        };
        let project = new Project({ storage }, env);
        const refused = await send(project, "restore", page);
        expect(refused.status).toBe(503);
        expect(failed).toBe(1);
        expect(await refused.json()).toMatchObject({ error: { code } });
        if (cold) project = new Project({ storage }, env);
        const issued = await send(project, "devices", {
          device: "synthetic",
          ttlMs: 60_000,
        });
        if (issued.status === 200) {
          const partial = page.tables.state_records![0]!;
          expect(
            f.db
              .query(
                "SELECT key FROM state_records WHERE namespace=? AND key=?",
              )
              .all(partial.namespace!, partial.key!),
          ).toEqual([]);
        } else expect(f.values.get("provisioned")).not.toBe(true);
      } finally {
        f.db.close();
      }
    });
  }
  for (const operation of [
    "read",
    "stop-read",
    "stop-write",
    "restore-stop",
  ] as const) {
    test(`lane control ${operation} preserves ${code}`, async () => {
      const f = fixture();
      try {
        const { owner } = f.open();
        f.fail((sql, bindings) => {
          if (
            bindings[0] !== "forge/work" ||
            typeof bindings[1] !== "string" ||
            !bindings[1].startsWith("lane-control:")
          )
            return;
          if (
            operation === "stop-write"
              ? sql.startsWith("INSERT INTO state_records")
              : sql.startsWith("SELECT body FROM state_records")
          )
            throw new Error(message);
        });
        if (operation === "restore-stop") {
          const source = await tinySource("restore stop quota synthetic");
          const response = await send(
            new Project({ storage: f.storage }, env),
            "restore",
            source.doc,
          );
          expect(response.status).toBe(503);
          expect(await response.json()).toMatchObject({ error: { code } });
        } else {
          const store = new LaneControlStore(owner, "quota");
          expect(() =>
            operation === "read"
              ? store.read()
              : store.stop(
                  { all: true },
                  "device",
                  "session",
                  new Date(1_000).toISOString(),
                ),
          ).toThrow(code);
        }
      } finally {
        f.db.close();
      }
    });
  }
  for (const operation of [
    "start",
    "approve",
    "deny",
    "poll",
    "issuance",
    "route-poll",
    "route-start",
  ] as const) {
    test(`login engine ${operation} preserves ${code}`, async () => {
      const f = fixture();
      try {
        const { db } = f.open();
        let now = 1_000;
        const verified = await testIdentityVerifier(
          new Map([
            [
              "synthetic-proof",
              {
                issuer: env.CLERK_ISSUER,
                subject: env.FORGE_OWNER_SUBJECT,
                audience: env.CLERK_CLIENT_ID,
                expiresAt: 1_000_000,
                authenticatedAt: 500,
              },
            ],
          ]),
        ).verify("synthetic-proof", env.CLERK_CLIENT_ID, now);
        if (!verified.ok) throw new Error("Synthetic identity refused");
        const login = createDeviceLogin({
          store: loginStore(db),
          userCodeKey: await importLoginKey(env.DEVICE_LOGIN_HMAC_KEY),
          now: () => now,
          random: (length) => crypto.getRandomValues(new Uint8Array(length)),
          issue: async (_identity, device) =>
            JSON.stringify(
              await issueToken(
                db,
                {
                  device: device.label,
                  session: null,
                  agent: null,
                  harness: null,
                  ttlMs: 60_000,
                },
                now,
              ),
            ),
        });
        const challenge = await login.start({ label: "synthetic" });
        if (operation === "issuance")
          expect(
            await login.approve(challenge.user_code, verified.identity),
          ).toEqual({ ok: true });
        now += 6_000;
        let hits = 0,
          reads = 0;
        f.fail((sql) => {
          if (
            operation === "issuance"
              ? sql.startsWith("INSERT INTO domain_cloud_tokens")
              : sql.startsWith("SELECT state FROM domain_cloud_login") &&
                ++reads >= (operation === "route-start" ? 2 : 1)
          ) {
            hits++;
            throw new Error(message);
          }
        });
        if (operation === "route-poll" || operation === "route-start") {
          f.values.set("provisioned", true);
          const response = await send(
            new Project({ storage: f.storage }, env),
            operation === "route-start" ? "loginstart" : "loginpoll",
            operation === "route-start"
              ? { device: "synthetic" }
              : { device_code: challenge.device_code },
          );
          expect(response.status).toBe(503);
          expect(await response.json()).toMatchObject({ error: { code } });
        } else {
          const result =
            operation === "start"
              ? login.start({ label: "synthetic" })
              : operation === "approve" || operation === "deny"
                ? login[operation](challenge.user_code, verified.identity)
                : login.poll(challenge.device_code);
          await expect(result).rejects.toMatchObject({ error: { code } });
        }
        expect(hits).toBeGreaterThan(0);
      } finally {
        f.db.close();
      }
    });
  }
}

for (const [message, code] of limits) {
  for (const mode of ["whole", "paged"] as const) {
    for (const key of ["state:epoch", "provisioned"] as const) {
      for (const cold of [false, true]) {
        test(`restore activation ${mode} ${key} ${code} retries ${cold ? "cold" : "warm"}`, async () => {
          const f = fixture();
          try {
            const source = await tinySource("activation quota synthetic");
            let unavailable = true,
              failed = 0;
            const storage: DurableStorage = {
              ...f.storage,
              put: (name, value) => {
                if (unavailable && name === key) {
                  failed++;
                  return Promise.reject(new Error(message));
                }
                return f.storage.put(name, value);
              },
            };
            f.fail((sql) => {
              if (
                unavailable &&
                failed &&
                /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)
              )
                throw new Error(message);
            });
            let project = new Project({ storage }, env);
            const pages =
              mode === "whole" ? [source.doc] : pagesOf(source.tables, 2);
            for (const [index, page] of pages.entries()) {
              const response = await send(project, "restore", page);
              expect(response.status).toBe(
                index === pages.length - 1 ? 503 : 200,
              );
              if (index === pages.length - 1)
                expect(await response.json()).toMatchObject({
                  error: { code },
                });
            }
            expect(failed).toBe(1);
            expect(f.values.get("provisioned")).not.toBe(true);
            expect(f.values.has("restore:next")).toBe(true);
            unavailable = false;
            if (cold) project = new Project({ storage }, env);
            for (const page of pages) {
              const response = await send(project, "restore", page);
              expect(response.status).toBe(200);
            }
            expect(f.values.get("provisioned")).toBe(true);
            expect(f.values.has("restore:next")).toBe(false);
            for (const row of source.tables.state_records!)
              expect(
                f.db
                  .query(
                    "SELECT body FROM state_records WHERE namespace=? AND key=?",
                  )
                  .get(row.namespace!, row.key!),
              ).toEqual({ body: row.body });
          } finally {
            f.db.close();
          }
        });
      }
    }
  }
  for (const cold of [false, true]) {
    test(`durable paged activation survives marker cleanup ${code} ${cold ? "cold" : "warm"}`, async () => {
      const f = fixture();
      try {
        const source = await tinySource("activation cleanup synthetic");
        let unavailable = true,
          failed = 0;
        const storage: DurableStorage = {
          ...f.storage,
          delete: (key) => {
            if (unavailable && key === "restore:next") {
              failed++;
              return Promise.reject(new Error(message));
            }
            return f.storage.delete(key);
          },
        };
        f.fail((sql) => {
          if (
            unavailable &&
            failed &&
            /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)
          )
            throw new Error(message);
        });
        let project = new Project({ storage }, env);
        const pages = pagesOf(source.tables, 2);
        for (const [index, page] of pages.entries())
          expect((await send(project, "restore", page)).status).toBe(
            index === pages.length - 1 ? 503 : 200,
          );
        expect(failed).toBe(1);
        expect(f.values.get("provisioned")).toBe(true);
        unavailable = false;
        if (cold) project = new Project({ storage }, env);
        expect(
          (
            await send(project, "devices", {
              device: "synthetic",
              ttlMs: 60_000,
            })
          ).status,
        ).toBe(200);
        for (const row of source.tables.state_records!)
          expect(
            f.db
              .query(
                "SELECT body FROM state_records WHERE namespace=? AND key=?",
              )
              .get(row.namespace!, row.key!),
          ).toEqual({ body: row.body });
        expect(f.values.has("restore:next")).toBe(false);
      } finally {
        f.db.close();
      }
    });
  }
}

for (const mode of ["whole", "paged"] as const) {
  test(`typed restored receipt named SQLITE_FULL stays invalid ${mode}`, async () => {
    const f = fixture();
    try {
      const source = await tinySource("typed receipt validation synthetic");
      source.tables.domain_cloud_requests = [
        {
          request_id: "SQLITE_FULL",
          fingerprint: "{}",
          outcome: "INPUT_INVALID",
          result: "{}",
          created_at: 0,
        },
      ];
      const input =
        mode === "whole" ? source.doc : pagesOf(source.tables, 100)[0]!;
      const response = await send(
        new Project({ storage: f.storage }, env),
        "restore",
        input,
      );
      const body = (await response.json()) as {
        error: { code: string; retry: string };
      };
      expect([response.status, body.error.code, body.error.retry]).toEqual([
        400,
        "RESTORE_INVALID_ROW",
        "never",
      ]);
      expect(f.values.get("provisioned")).not.toBe(true);
      expect(
        f.db.query("SELECT request_id FROM domain_cloud_requests").all(),
      ).toEqual([]);
    } finally {
      f.db.close();
    }
  });
}
