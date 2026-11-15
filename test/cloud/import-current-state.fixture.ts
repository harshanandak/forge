import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach } from "bun:test";
import { StateOwner } from "../../src/core/state/index.ts";
import type { SqlDatabase, SqlRow } from "../../src/ports/store.ts";
import { success } from "../../src/surface/dispatch.ts";
import { failure, respond } from "../../src/surface/result.ts";
import * as projection from "../../tools/import-current-state.ts";
import { durableStore } from "../../cloud/src/store.ts";
import { browserStorage } from "./browser-storage.fixture.ts";
import type { Project } from "../../cloud/src/project.ts";

export function controlDelta(state: StateOwner, title: string): void {
  state.put(
    "forge/work",
    "lane-control:global",
    {
      version: 1,
      incarnation: "expected-fixture",
      epoch: 0,
      resumeAllEpoch: 0,
      stopAll: null,
    },
    actor,
    { expectRevision: 0 },
  );
  state.put("forge/work", "issue:work-1", { title }, actor, {
    expectRevision: 1,
  });
}
/** Real Project routes, with the target's final response followed by an injected fixture delta. */
export function expectedTransport(
  source: Pick<Project, "fetch">,
  target: Pick<Project, "fetch">,
  delta: () => void,
): typeof fetch {
  return Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      assert.ok(typeof input === "string");
      const request = new Request(input, init),
        url = new URL(request.url);
      const name = url.pathname.split("/")[2];
      assert.ok(name === "source" || name === "target");
      const response = await (name === "source" ? source : target).fetch(
        request,
      );
      if (name === "target" && request.method === "POST" && response.ok) {
        const reply = (await response.clone().json()) as {
          value: { done?: boolean };
        };
        if (reply.value.done !== false) delta();
      }
      return response;
    },
    { preconnect: () => {} },
  );
}
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
