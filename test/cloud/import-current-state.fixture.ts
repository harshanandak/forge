import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach } from "bun:test";
import { domain } from "../../cloud/src/project.ts";
import { dumpOf, type Dump } from "../../cloud/src/dump.ts";
import { LANE_APPROVALS } from "../../cloud/src/lane-approval.ts";
import { LANE_BROWSER } from "../../cloud/src/auth/lane-browser.ts";
import { issueToken, sha256 } from "../../cloud/src/tokens.ts";
import { ForgeFailure } from "../../src/contract/failure.ts";
import { digestValue } from "../../src/core/config/pointer.ts";
import { imageDigests } from "../../tools/import-current.ts";
import { testIdentityVerifier } from "../contract/lib/identity-verifier.ts";
import { StateOwner } from "../../src/core/state/index.ts";
import type { SqlDatabase, SqlRow } from "../../src/ports/store.ts";
import { success } from "../../src/surface/dispatch.ts";
import { failure, respond } from "../../src/surface/result.ts";
import * as projection from "../../tools/import-current-state.ts";
import { durableStore } from "../../cloud/src/store.ts";
import { browserStorage } from "./browser-storage.fixture.ts";
export const ns = "forge/work",
  at = 1_800_000_000_000;
export const actor = { kind: "agent", id: "synthetic-import" } as const;
export const holder = {
  actor,
  session: { id: "one", device: "fixture" },
};
const resources: (() => void)[] = [];
afterEach(() =>
  resources
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
export function database(path = ":memory:", readOnly = false): SqlDatabase {
  const db = new Database(path, { readonly: readOnly, safeIntegers: true });
  resources.push(() => db.close());
  return {
    exec: (sql) => {
      db.exec(sql);
    },
    run: (sql, p = []) => db.query(sql).run(...p),
    all: (sql, p = []) => db.query(sql).all(...p) as SqlRow[],
    get: (sql, p = []) =>
      (db.query(sql).get(...p) ?? undefined) as SqlRow | undefined,
    transaction: (body) => db.transaction(body)(),
  };
}
export function owner(db: SqlDatabase) {
  return new StateOwner(db, { now: () => at });
}
export function cloudDatabase(): SqlDatabase {
  const db = new Database(":memory:");
  resources.push(() => db.close());
  return durableStore(browserStorage(db).storage);
}
export function snapshot(db: SqlDatabase) {
  return db
    .all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .map(({ name }) => [
      name,
      db.all(
        `SELECT * FROM "${String(name).replaceAll('"', '""')}" ORDER BY rowid`,
      ),
    ]);
}
export function source(
  count = 3,
  history = false,
  authority = false,
  edit?: (db: SqlDatabase, state: StateOwner) => void,
) {
  const directory = mkdtempSync(join(tmpdir(), "forge-synthetic-import-"));
  resources.push(() => rmSync(directory, { recursive: true }));
  const path = join(directory, "standalone.sqlite");
  const db = database(path),
    state = owner(db);
  state.initialize();
  db.transaction(() => {
    for (let n = 1; n <= count - 3; n++)
      state.put(
        ns,
        `issue:work-${n}`,
        {
          id: `work-${n}`,
          title: `Synthetic ${n}`,
          text: 'exact\nλ\\"',
          parent: "work-1",
          dependencies: ["work-2"],
        },
        actor,
        { expectRevision: 0 },
      );
    if (history) {
      for (const key of [
        "issue:work-9000",
        "comment:work-1:9000",
        "link:work-1:9000",
        "allocation:issue:work-",
      ]) {
        const value = key.startsWith("allocation:")
          ? { prefix: "issue:work-", number: 12000 }
          : { deleted: true };
        state.put(ns, key, value, actor, { expectRevision: 0 });
        state.delete(ns, key, actor, { expectRevision: 1 });
      }
    } else {
      for (const [prefix, number] of [
        ["issue:work-", count],
        ["comment:work-1:", 0],
        ["link:work-1:", 0],
      ] as const)
        state.put(ns, `allocation:${prefix}`, { prefix, number }, actor, {
          expectRevision: 0,
        });
    }
    if (authority) {
      state.put(ns, "issue:work-1", { id: "work-1", title: "receipt" }, actor, {
        expectRevision: 1,
        requestId: "old-put",
      });
      state.acquire(ns, "issue:work-1", holder, 60_000, "old-claim");
    }
    edit?.(db, state);
  });
  db.exec("PRAGMA journal_mode=DELETE");
  const read = database(path, true);
  const manifest = {
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    eventHighWaterMark: Number(
      read.get("SELECT COALESCE(MAX(sequence),0) AS n FROM state_events")!.n,
    ),
    records: Number(read.get("SELECT COUNT(*) AS n FROM state_records")!.n),
    at: new Date(at).toISOString(),
  };
  const bytes = () =>
    createHash("sha256").update(readFileSync(path)).digest("hex");
  return { db: read, manifest, bytes };
}
export function result(body: () => unknown) {
  try {
    return respond(success("import-current", body()));
  } catch (error) {
    const refusal = (error as { error?: { code: string; message: string } })
      .error;
    if (!refusal) throw error;
    return respond(failure(refusal.code, refusal.message));
  }
}
type Change = readonly [string, string];
const changes: Record<string, Change> = {
  historical: ["Math.max(summary.highest, summary.earlier)", "0"],
  consistency: [
    "verifyEventDerivedState(\n      source,\n      manifest.eventHighWaterMark,\n      undefined,\n      numbered,\n    )",
    "({ highest: 0, earlier: 0, floorRevision: 0 })",
  ],
  scope: ["ns === namespace &&", "true || ns === namespace &&"],
  migration: [
    "canonicalJson(source.all(sql)) !== canonicalJson(schema.all(sql))",
    "false",
  ],
  count: ["records !== manifest.records", "false"],
  empty: ["if (nonempty)", "if (false)"],
  authority: [
    "verifyEventDerivedState(scratch, events);",
    `for (const table of ["state_leases", "state_requests"]) {
    for (const row of source.all("SELECT * FROM " + table)) scratch.run("INSERT INTO " + table + " VALUES (" + Object.keys(row).map(() => "?").join(",") + ")", Object.values(row));
  }
  verifyEventDerivedState(scratch, events);`,
  ],
  revision: ["event.revision !== (recordRevisions.get(id) ?? 0) + 1", "false"],
  fence: [
    'if (options.fence) this.#held(namespace, options.fence, now);\n      return this.#request(\n        namespace,\n        options.requestId,\n        {\n          kind: "put",',
    'return this.#request(\n        namespace,\n        options.requestId,\n        {\n          kind: "put",',
  ],
};
export async function moduleUrl(
  path: string,
  change?: Change,
  dependency?: readonly [string, string],
) {
  const url = new URL(path, import.meta.url);
  let text = (await Bun.file(url).text()).replaceAll("\r\n", "\n");
  if (change) {
    assert.equal(text.split(change[0]).length, 2);
    text = text.replace(...change);
  }
  text = text.replace(
    /(from |import\()"(\.\.?\/[^"]+)"/g,
    (_all, prefix: string, spec: string) =>
      `${prefix}"${dependency?.[0] === spec ? dependency[1] : new URL(spec, url).href}"`,
  );
  return `data:text/javascript;base64,${Buffer.from(new Bun.Transpiler({ loader: "ts" }).transformSync(text)).toString("base64")}`;
}
export async function implementation(
  mutation?: string,
): Promise<typeof projection> {
  return mutation
    ? (import(
        await moduleUrl(
          "../../tools/import-current-state.ts",
          changes[mutation],
        )
      ) as Promise<typeof projection>)
    : projection;
}
export async function replay(mutation: boolean) {
  const core = mutation
    ? await moduleUrl("../../src/core/state/index.ts", changes.revision)
    : undefined;
  return import(
    await moduleUrl(
      "../../cloud/src/dump.ts",
      undefined,
      core ? ["../../src/core/state/index.ts", core] : undefined,
    )
  ) as Promise<typeof import("../../cloud/src/dump.ts")>;
}
export async function fencedOwner(db: SqlDatabase, mutation: boolean) {
  const Impl = mutation
    ? (
        (await import(
          await moduleUrl("../../src/core/state/index.ts", changes.fence)
        )) as { StateOwner: typeof StateOwner }
      ).StateOwner
    : StateOwner;
  return new Impl(db, { now: () => at });
}

export function activationImage(mode = "running", lease = false) {
  const db = cloudDatabase(),
    state = owner(db),
    iso = new Date(at).toISOString();
  state.initialize([domain]);
  state.put(
    ns,
    "issue:work-1",
    {
      id: "work-1",
      prefix: "forge",
      title: "source",
      status: "open",
      labels: [],
      dependsOn: [],
      createdAt: iso,
    },
    actor,
    { expectRevision: 0, requestId: "original" },
  );
  const put = (key: string, value: unknown) =>
    state.put(ns, key, value, actor, { expectRevision: 0 });
  put("allocation:issue:work-", { prefix: "issue:work-", number: 1 });
  if (mode !== "absent")
    put("lane-control:global", {
      version: 1,
      incarnation: "history",
      epoch: mode === "exhausted" ? Number.MAX_SAFE_INTEGER : 4,
      resumeAllEpoch: 0,
      stopAll: mode === "stopped" ? iso : null,
    });
  if (lease) state.acquire(ns, "issue:work-1", holder, 60_000, "old-claim");
  return db;
}
export async function stoppedImage(source: SqlDatabase, target: SqlDatabase) {
  const expected = cloudDatabase();
  const helper =
    (await import("../../cloud/conformance/restored.ts")) as unknown as {
      restoreStopped: (
        db: SqlDatabase,
        image: Iterable<Dump>,
        actual: SqlDatabase,
      ) => void;
    };
  helper.restoreStopped(expected, [dumpOf(source)], target);
  assert.deepEqual(imageDigests(target), imageDigests(expected));
}
export async function activation(
  mutation?: string,
  extra: Record<string, string> = {},
  retained = false,
) {
  const projectPath = "../../cloud/src/project.ts",
    original = (
      await Bun.file(new URL(projectPath, import.meta.url)).text()
    ).replaceAll("\r\n", "\n");
  const stop = original.match(
    /new LaneControlStore\([\s\S]*?\.stop\([\s\S]*?\);/,
  )?.[0];
  const changes: Record<string, Change> = {
    stop: [
      stop ?? "missing Project stop",
      '({ ok: true, result: { stopped: true, scope: "all" } });',
    ],
    approval: ["db.run(`DELETE FROM ${LANE_APPROVALS}`);", ""],
    browser: ["db.run(`DELETE FROM ${LANE_BROWSER}`);", ""],
    target: ["if (await this.#isProvisioned())", "if (false)"],
  };
  const dumpChange: Change | undefined =
    mutation === "release"
      ? ["owner.releaseRestoredLeases();", ""]
      : mutation === "cap"
        ? [
            '  finalize?.();\n  assertLimits(db, limits, "RESTORE_TOO_LARGE", "The restored project");',
            "  finalize?.();",
          ]
        : undefined;
  const dump = dumpChange
    ? await moduleUrl("../../cloud/src/dump.ts", dumpChange)
    : undefined;
  const { Project } = (await import(
    await moduleUrl(
      projectPath,
      changes[mutation ?? ""],
      dump ? ["./dump.ts", dump] : undefined,
    )
  )) as typeof import("../../cloud/src/project.ts");
  const raw = new Database(":memory:");
  resources.push(() => raw.close());
  let fault = "",
    transactions = 0;
  const { storage, values } = browserStorage(raw, (sql) => {
    if (fault && sql === `DELETE FROM ${fault}`)
      throw new ForgeFailure({
        code: "UNAVAILABLE",
        message: "synthetic deletion fault",
        retry: "never",
      });
  });
  const db = durableStore(storage);
  owner(db).initialize([domain]);
  if (mutation === "atomic")
    storage.transactionSync = (body) => {
      transactions++;
      return body();
    };
  const env = {
    FORGE_CLOUD_PROJECT: "a",
    FORGE_CLOUD_ID_PREFIX: "forge",
    DUMP_PAGE_BYTES: "4096",
    CLERK_ISSUER: "https://identity.example",
    CLERK_CLIENT_ID: "synthetic",
    FORGE_OWNER_SUBJECT: "owner",
    CLERK_REDIRECT_URI: "https://synthetic.example/callback",
    DEVICE_LOGIN_HMAC_KEY: Buffer.alloc(32, 7).toString("base64url"),
    ...extra,
  };
  let exchanges = 0;
  const claims = {
    issuer: env.CLERK_ISSUER,
    subject: "owner",
    audience: "synthetic",
    authenticatedAt: at - 1000,
    expiresAt: at + 600_000,
  };
  const verifier = testIdentityVerifier(new Map([["owner", claims]]));
  const p = new Project({ storage }, env, {
    upstream: {
      begin: () => Promise.reject(new Error("Callback-only fixture")),
      verify: () => {
        exchanges++;
        return verifier.verify("owner", "synthetic", at);
      },
    },
    redemption: { claimOnce: () => Promise.resolve(true) },
  });
  const deviceInput = {
    device: "fixture",
    session: "one",
    agent: null,
    harness: null,
    ttlMs: 600_000,
  };
  let credential: Record<string, unknown> | undefined,
    n = 0;
  const send = async (
    route: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const response = await p.fetch(
      new Request(`https://synthetic.example/p/a/${route}`, {
        method: body === undefined ? "GET" : "POST",
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    const r = (await response.json()) as {
      ok: boolean;
      result: unknown;
      value: Record<string, unknown>;
      error: { code: string; message: string };
    };
    return {
      r,
      projected: respond(
        r.ok
          ? success(route, r.value ?? r.result)
          : failure(r.error.code, r.error.message),
      ),
    };
  };
  const command = async (
    op: string,
    input: object = {},
    generation?: number,
  ) => {
    credential ??= (await send("devices", deviceInput)).r.value;
    return send(
      "command",
      {
        requestId: `fresh-${++n}`,
        op,
        input,
        context: {
          actor,
          session: holder.session,
          ...(generation === undefined ? {} : { leaseGeneration: generation }),
        },
      },
      { authorization: `Bearer ${String(credential.token)}` },
    );
  };
  const challenge = async (request: string, state: string, bind: string) => {
    const stateHash = await sha256(state);
    const entry = {
      request,
      action: "approve",
      stateHash,
      bindHash: await sha256(bind),
      verifier: "synthetic",
      expiresAt: at + 600_000,
    };
    db.run(`INSERT OR REPLACE INTO ${LANE_BROWSER} VALUES (1, ?)`, [
      JSON.stringify([entry]),
    ]);
    return `__Host-forge_lane_${stateHash.slice(0, 24)}=${bind}`;
  };
  const oldState = "forge-lane." + "s".repeat(43),
    bind = "b".repeat(43);
  let oldCookie = "";
  if (retained) {
    credential = await issueToken(db, deviceInput, at);
    const row = {
      request: "old-approved",
      scope: { all: true },
      project: "a",
      incarnation: "history",
      epoch: 5,
      policyIdentity: digestValue([
        env.CLERK_ISSUER,
        env.FORGE_OWNER_SUBJECT,
        env.CLERK_CLIENT_ID,
      ]),
      device: "fixture",
      session: "one",
      token: credential.id,
      status: "approved",
      expiresAt: new Date(at + 600_000).toISOString(),
      url: "https://synthetic.example/lane-approval/old-approved",
    };
    db.run(`INSERT INTO ${LANE_APPROVALS} VALUES (1, ?)`, [
      JSON.stringify({
        requests: [row, { ...row, request: "old-browser", status: "pending" }],
      }),
    ]);
    oldCookie = await challenge("old-browser", oldState, bind);
  }

  const browser = (path: string, cookie: string) =>
    p.fetch(
      new Request(`https://synthetic.example${path}`, {
        headers: { Cookie: cookie },
      }),
    );
  return {
    db,
    values,
    send,
    command,
    exchanges: () => exchanges,
    transactions: () => transactions,
    fault: (value: string) => {
      fault = value;
    },
    oldCallback: () =>
      browser(`/callback?state=${oldState}&code=old`, oldCookie),
    approve: async (request: string) => {
      const state = "forge-lane." + "f".repeat(43);
      const cookie = await challenge(request, state, "c".repeat(43));
      const approved = await browser(
        `/callback?state=${state}&code=owner`,
        cookie,
      );
      assert.equal(approved.status, 200);
    },
  };
}
