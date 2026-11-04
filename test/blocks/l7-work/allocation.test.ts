import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import { createStateClient } from "../../../src/assembly/state-client.ts";
import { StateOwner } from "../../../src/core/state/index.ts";
import type { SqlDatabase, SqlRow } from "../../../src/ports/store.ts";

setDefaultTimeout(30_000);

type Handler = (call: {
  input: Record<string, unknown>;
  config?: unknown;
  services: unknown;
}) => { id?: string; key?: string; commentId?: string };
type Aggregates = {
  count(prefix: string): number;
  maxNumber(prefix: string): number;
};
const namespace = "forge/work";
const actor = { kind: "agent" as const, id: "allocation" };
const globals = globalThis as Record<string, unknown>;
const hadFail = "fail" in globals;
const previousFail = globals.fail;
let operations: Record<string, Handler>;
beforeAll(() => {
  globals.fail = (code: string, message: string) => {
    throw new Error(`${code}: ${message}`);
  };
  operations = require(
    resolve(import.meta.dirname, "../../../src/blocks/work/entry.cts"),
  ) as typeof operations;
});
afterAll(() => {
  if (hadFail) globals.fail = previousFail;
  else delete globals.fail;
});

async function fixture() {
  const opened = await createSqliteStore(tmpdir()).open({
    path: ":memory:",
    readOnly: false,
  });
  if (!opened.ok) throw new Error(opened.unavailable.reason);
  const real = opened.handle.value;
  const decoded = { allocation: 0, point: 0 };
  // As in list-prefix.test.ts, count accesses to SQL row.body where JSON decoding happens.
  function counted(row: SqlRow, kind: keyof typeof decoded): SqlRow {
    if (!("body" in row)) return row;
    return {
      ...row,
      get body() {
        decoded[kind]++;
        return row.body!;
      },
    };
  }
  const db: SqlDatabase = {
    exec: (sql) => real.exec(sql),
    run: (sql, params) => real.run(sql, params),
    transaction: (body) => real.transaction(body),
    all: (sql, params) =>
      real.all(sql, params).map((row) => counted(row, "allocation")),
    get(sql, params) {
      const row = real.get(sql, params);
      return row === undefined ? undefined : counted(row, "point");
    },
  };
  const owner = new StateOwner(db, { now: () => 1000 });
  owner.initialize();
  const state = createStateClient({
    owner,
    namespace,
    context: { variant: "project", actor, project: { id: "allocation" } },
    write: true,
    requestId: "allocation",
  });
  return {
    owner,
    state,
    decoded,
    reset: () => {
      decoded.allocation = 0;
      decoded.point = 0;
    },
    seed: (
      entries: readonly { key: string; value: unknown }[],
      ns = namespace,
    ) =>
      owner.putMany(
        ns,
        entries.map((entry) => ({ ...entry, expectRevision: 0 })),
        actor,
      ),
    call: (op: string, input: Record<string, unknown>, view = state) =>
      operations[`issue.${op}`]!({ input, services: { state: view } }),
    close: () => opened.handle.close(),
  };
}

function issue(n: number, prefix = "work") {
  return {
    key: `issue:work-${n}`,
    value: {
      id: `work-${n}`,
      prefix,
      title: `Record ${n}`,
      status: "open",
      labels: [],
      dependsOn: [],
      createdAt: new Date(1000).toISOString(),
    },
  };
}

test("issue.create allocates 1001 with zero allocation decodes among 1000 issues", async () => {
  const f = await fixture();
  try {
    f.seed(Array.from({ length: 1000 }, (_, n) => issue(n + 1)));
    f.reset();
    expect(f.call("create", { title: "Next" }).id).toBe("work-1001");
    expect(f.decoded.allocation).toBe(0);
    expect(f.decoded.point).toBeLessThanOrEqual(3);
  } finally {
    await f.close();
  }
});

for (const op of ["comment", "checkpoint", "link"] as const) {
  test(`issue.${op} allocates 501 with zero allocation decodes among 500 rows`, async () => {
    const f = await fixture();
    try {
      const prefix = `${op === "link" ? "link" : "comment"}:work-1:`;
      f.seed([issue(1)]);
      f.seed(
        Array.from({ length: 500 }, (_, n) => ({
          key: `${prefix}${n + 1}`,
          value: { id: "work-1", body: `Row ${n}` },
        })),
      );
      f.reset();
      const result = f.call(op, {
        id: "work-1",
        body: "Next",
        step: "build",
        branch: "topic",
        worktree: "fixture",
        next: "Check",
        relation: "delivers",
        url: "https://example.com/501",
      });
      expect(op === "link" ? result.key : result.commentId).toBe(
        `${prefix}501`,
      );
      expect(f.decoded.allocation).toBe(0);
      expect(f.decoded.point).toBeLessThanOrEqual(3);
    } finally {
      await f.close();
    }
  });
}

test("empty allocation prefixes still start at 1 for all four operations", async () => {
  const f = await fixture();
  try {
    expect(f.call("create", { title: "First" }).id).toBe("work-1");
    expect(f.call("comment", { id: "work-1", body: "First" }).commentId).toBe(
      "comment:work-1:1",
    );
    f.owner.delete(namespace, "comment:work-1:1", actor, { expectRevision: 1 });
    expect(
      f.call("checkpoint", {
        id: "work-1",
        step: "build",
        branch: "topic",
        worktree: "fixture",
        next: "Check",
      }).commentId,
    ).toBe("comment:work-1:1");
    expect(
      f.call("link", {
        id: "work-1",
        relation: "delivers",
        url: "https://example.com/1",
      }).key,
    ).toBe("link:work-1:1");
  } finally {
    await f.close();
  }
});

test("key aggregates match old JS allocation with gaps, aliases, literal prefixes and numeric ordering", async () => {
  const f = await fixture();
  try {
    f.seed([
      issue(2),
      issue(9),
      issue(10, "alpha"),
      {
        key: "issue:alpha-12",
        value: { ...issue(12).value, id: "alpha-12" },
      },
      ...[
        "comment:work-2:",
        "link:work-2:",
        "literal%_:",
        "literalXX:",
        "\u{10FFFF}",
      ].flatMap((prefix) =>
        [2, 9, 10].map((n) => ({
          key: `${prefix}${n}`,
          value: { body: `${n}` },
        })),
      ),
      { key: "literal%_:none", value: {} },
      { key: "literal%_:\u{10FFFF}child", value: {} },
      { key: "literal%_:\u{10FFFF}", value: {} },
    ]);
    f.seed([{ key: "issue:work-999", value: issue(999).value }], "forge/other");
    const records = f.owner.list(namespace);
    const oldMax = records
      .filter((row) => row.key.startsWith("issue:"))
      .reduce((max, record) => {
        const { id } = record.value as { id: string };
        return id.startsWith("work-")
          ? Math.max(max, Number(id.slice(5)) || 0)
          : max;
      }, 0);
    expect(oldMax).toBe(10);
    // These casts let the tests-only commit type-check while the new methods are absent on main.
    const owner = f.owner as StateOwner & {
      count(namespace: string, prefix: string): number;
      maxNumber(namespace: string, prefix: string): number;
    };
    const clients = [
      f.owner.client(namespace, actor),
      f.state,
    ] as unknown as Aggregates[];
    for (const prefix of [
      "",
      "issue:",
      "issue:work-",
      "comment:work-2:",
      "link:work-2:",
      "literal%_:",
      "\u{10FFFF}",
      "missing:",
    ]) {
      const rows = records.filter((row) => row.key.startsWith(prefix));
      const expectedMax = rows.reduce(
        (max, row) => Math.max(max, Number(/\d+$/.exec(row.key)?.[0] ?? 0)),
        0,
      );
      f.reset();
      expect(owner.count(namespace, prefix)).toBe(rows.length);
      expect(owner.maxNumber(namespace, prefix)).toBe(expectedMax);
      for (const client of clients) {
        expect(client.count(prefix)).toBe(rows.length);
        expect(client.maxNumber(prefix)).toBe(expectedMax);
      }
      expect(f.decoded).toEqual({ allocation: 0, point: 0 });
    }
    expect(owner.maxNumber(namespace, "issue:work-")).toBe(oldMax);
    for (const prefix of ["\ud800", "literal%_:\ud801"]) {
      expect(() => owner.count(namespace, prefix)).toThrow(
        "Aggregate prefix must be well-formed UTF-16 text",
      );
      expect(() => owner.maxNumber(namespace, prefix)).toThrow(
        "Aggregate prefix must be well-formed UTF-16 text",
      );
    }
    expect(f.call("create", { title: "Parity" }).id).toBe(`work-${oldMax + 1}`);
    for (const op of ["comment", "checkpoint", "link"]) {
      const result = f.call(op, {
        id: "work-2",
        body: "Gap",
        step: "build",
        branch: "topic",
        worktree: "fixture",
        next: "Check",
        relation: "delivers",
        url: "https://example.com/gap",
      });
      expect(op === "link" ? result.key : result.commentId).toBe(
        `${op === "link" ? "link" : "comment"}:work-2:${op === "checkpoint" ? 5 : 4}`,
      );
    }
    const absent = createStateClient({
      owner: undefined,
      namespace,
      context: { variant: "stateless" },
      write: false,
      requestId: "absent",
    }) as unknown as Aggregates;
    expect(absent.count("")).toBe(0);
    expect(absent.maxNumber("")).toBe(0);
  } finally {
    await f.close();
  }
});

for (const op of ["create", "comment", "checkpoint", "link"]) {
  test(`a competing ${op} allocation still loses the create-if-absent revision guard`, async () => {
    const f = await fixture();
    try {
      f.seed([issue(1)]);
      const stale = {
        ...f.state,
        put: (
          key: string,
          value: unknown,
          options: { expectRevision: number },
        ) => {
          // Another caller commits after selection but before this caller's transaction.
          f.owner.put(namespace, key, value, actor, { expectRevision: 0 });
          return f.state.put(key, value, options);
        },
      };
      expect(() =>
        f.call(
          op,
          {
            title: "Race",
            id: "work-1",
            body: "Race",
            step: "build",
            branch: "topic",
            worktree: "fixture",
            next: "Check",
            relation: "delivers",
            url: "https://example.com/race",
          },
          stale,
        ),
      ).toThrow("Expected revision 0; current revision is 1");
      const key =
        op === "create"
          ? "issue:work-2"
          : `${op === "link" ? "link" : "comment"}:work-1:1`;
      expect(f.owner.get(namespace, key)?.revision).toBe(1);
    } finally {
      await f.close();
    }
  });
}
