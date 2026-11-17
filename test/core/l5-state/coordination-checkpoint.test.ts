import { expect, setDefaultTimeout, test } from "bun:test";
import {
  StateOwner,
  verifyEventDerivedState,
} from "../../../src/core/state/index.ts";
import {
  readReplayStart,
  recordDigest,
} from "../../../src/core/state/checkpoint.ts";
import { withinRestoreBudget } from "../../../src/core/state/restore-json.ts";
import { canonicalJson } from "../../../src/core/config/pointer.ts";
import type { SqlDatabase } from "../../../src/ports/store.ts";
import { actor, ns, fixture, high } from "./record-checkpoint.fixture.ts";

setDefaultTimeout(30_000);

test("the covered boundary cannot hide an event at sequence zero", async () => {
  const s = await fixture();
  try {
    s.owner.initialize();
    s.db.run("INSERT INTO state_events VALUES (0,?,?,?)", [
      ns,
      "missing",
      canonicalJson({
        type: `${ns}:record.deleted@1`,
        namespace: ns,
        key: "missing",
        revision: 1,
        at: new Date(1000).toISOString(),
        actor,
      }),
    ]);
    expect(() => verifyEventDerivedState(s.db, 0, 1)).toThrow(/state_events/);
  } finally {
    await s.close();
  }
});

const holder = {
  actor,
  session: { id: "synthetic-session", device: "synthetic-device" },
};
const other = {
  actor,
  session: { id: "other-session", device: "other-device" },
};
type Fixture = Awaited<ReturnType<typeof fixture>>;
function prefix(s: Fixture) {
  s.owner.initialize();
  const first = s.owner.acquire(ns, "subject", holder, 60_000, "acquire-1");
  s.owner.release(ns, first);
  const second = s.owner.acquire(ns, "subject", other, 60_000, "acquire-2");
  s.owner.renew(ns, second, 120_000);
  s.owner.put(ns, "answer", { original: true }, actor, {
    expectRevision: 0,
    requestId: "answer-1",
  });
}
function tail(s: Fixture) {
  const current = s.owner.lease(ns, "subject")!;
  s.owner.release(ns, current);
  s.owner.acquire(ns, "subject", holder, 60_000, "acquire-3");
  s.owner.put(ns, "answer", { original: false }, actor, {
    expectRevision: 1,
    requestId: "answer-2",
  });
}

test.each([1, 2, 256])(
  "coordination checkpoint plus tail equals full replay with batch %s",
  async (batch) => {
    const full = await fixture(),
      saved = await fixture(),
      target = await fixture();
    try {
      prefix(full);
      prefix(saved);
      const count = high(saved);
      expect(saved.owner.checkpoint(batch)).toBe(count);
      expect(saved.db.all("SELECT sequence FROM state_events")).toHaveLength(
        count,
      );
      expect(
        saved.db.all("SELECT * FROM state_checkpoint_leases"),
      ).toHaveLength(1);
      expect(
        saved.db.all("SELECT * FROM state_checkpoint_receipts"),
      ).toHaveLength(3);
      tail(full);
      tail(saved);
      verifyEventDerivedState(full.db, high(full), 1);
      verifyEventDerivedState(saved.db, high(saved), 1);
      expect(saved.owner.export().leases).toEqual(full.owner.export().leases);
      expect(saved.owner.export().requests).toEqual(
        full.owner.export().requests,
      );
      expect(saved.owner.export().records).toEqual(full.owner.export().records);
      saved.owner.initialize();
      target.owner.initialize();
      target.owner.restore(saved.owner.export(), undefined, 1);
      expect(target.owner.lease(ns, "subject")?.generation).toBe(3);
      expect(target.owner.lease(ns, "subject")?.releasedAt).toBeDefined();
      expect(target.owner.export().requests).toEqual(
        full.owner.export().requests,
      );
      verifyEventDerivedState(target.db, high(target), 1);
    } finally {
      await full.close();
      await saved.close();
      await target.close();
    }
  },
);

test.each(["released", "expired"])(
  "checkpoint initialize never reissues a %s generation or accepts its fence",
  async (kind) => {
    const s = await fixture();
    try {
      prefix(s);
      const stale = s.owner.lease(ns, "subject")!;
      if (kind === "released") s.owner.release(ns, stale);
      s.owner.checkpoint(1);
      const owner = new StateOwner(s.db, { now: () => 200_000 });
      owner.initialize();
      const fresh = owner.acquire(ns, "subject", holder, 60_000, "fresh");
      expect(fresh.generation).toBe(3);
      expect(() =>
        owner.put(ns, "stale", {}, actor, {
          expectRevision: 0,
          fence: stale,
        }),
      ).toThrow(/generation/);
      expect(owner.get(ns, "stale")).toBeUndefined();
      verifyEventDerivedState(s.db, high(s), 1);
    } finally {
      await s.close();
    }
  },
);

test("checkpointed request returns its original answer after initialize and restore", async () => {
  const s = await fixture(),
    target = await fixture();
  try {
    prefix(s);
    const original = s.owner.get(ns, "answer")!;
    s.owner.checkpoint(1);
    tail(s);
    s.owner.initialize();
    target.owner.initialize();
    target.owner.restore(s.owner.export(), undefined, 1);
    for (const owner of [s.owner, target.owner]) {
      const before = owner.export().eventHighWaterMark;
      expect(
        owner.put(ns, "answer", { original: true }, actor, {
          expectRevision: 0,
          requestId: "answer-1",
        }),
      ).toEqual(original);
      expect(() =>
        owner.put(ns, "answer", "changed-input", actor, {
          expectRevision: 0,
          requestId: "answer-1",
        }),
      ).toThrow(/different input/);
      expect(owner.export().eventHighWaterMark).toBe(before);
    }
  } finally {
    await s.close();
    await target.close();
  }
});

test.each([
  "lease body",
  "generation",
  "receipt digest",
  "missing receipt",
  "missing lease watermark",
  "lower lease watermark",
])(
  "initialize and restore refuse forged checkpoint %s without publication",
  async (kind) => {
    const s = await fixture(),
      target = await fixture();
    try {
      prefix(s);
      if (kind.includes("watermark"))
        s.owner.acquire(
          "forge/leases",
          "subject",
          holder,
          60_000,
          "lease-only",
        );
      s.owner.checkpoint(1);
      target.owner.initialize();
      if (kind === "lease body")
        s.db.run("UPDATE state_checkpoint_leases SET body='{}'");
      else if (kind === "generation")
        s.db.run("UPDATE state_checkpoint_leases SET generation=generation+1");
      else if (kind === "receipt digest")
        s.db.run("UPDATE state_checkpoint_receipts SET result_digest=?", [
          `sha256:${"0".repeat(64)}`,
        ]);
      else if (kind === "missing lease watermark")
        s.db.run("DELETE FROM state_namespace_watermarks WHERE namespace=?", [
          "forge/leases",
        ]);
      else if (kind === "lower lease watermark")
        s.db.run(
          "UPDATE state_namespace_watermarks SET sequence=0 WHERE namespace=?",
          ["forge/leases"],
        );
      else s.db.run("DELETE FROM state_requests WHERE request_id='answer-1'");
      expect(() => s.owner.initialize()).toThrow();
      expect(() => target.owner.restore(s.owner.export())).toThrow();
      expect(target.owner.export().records).toEqual([]);
      expect(target.owner.export().leases).toEqual([]);
      expect(target.owner.export().requests).toEqual([]);
    } finally {
      await s.close();
      await target.close();
    }
  },
);

for (const mode of ["initialize", "restore"])
  test.each(["updated", "deleted", "absent", "entries", "forged"])(
    `${mode} validates covered acquisition read sets at their historical revisions: %s`,
    async (change) => {
      const source = await fixture(),
        target = await fixture();
      try {
        source.owner.initialize();
        if (change !== "absent")
          source.owner.put(ns, "dependency", 1, actor, { expectRevision: 0 });
        source.owner.acquire(ns, "s", holder, 60_000, "historical", {
          readSet: [
            { key: "dependency", expectRevision: change === "absent" ? 0 : 1 },
          ],
          ...(change === "entries"
            ? { entries: [{ key: "dependency", value: 2, expectRevision: 1 }] }
            : {}),
        });
        if (change === "deleted")
          source.owner.delete(ns, "dependency", actor, { expectRevision: 1 });
        else if (change !== "entries")
          source.owner.put(ns, "dependency", 2, actor, {
            expectRevision: change === "absent" ? 0 : 1,
          });
        verifyEventDerivedState(source.db, high(source), 1);
        source.owner.checkpoint(1);
        if (change === "forged") {
          const row = source.db.get(
            "SELECT sequence,body FROM state_events WHERE json_extract(body,'$.requestId')='historical'",
          )!;
          const event = JSON.parse(String(row.body)) as {
            data: { options: { readSet: { expectRevision: number }[] } };
          };
          event.data.options.readSet[0]!.expectRevision = 2;
          source.db.run("UPDATE state_events SET body=? WHERE sequence=?", [
            canonicalJson(event),
            Number(row.sequence),
          ]);
        }
        target.owner.initialize();
        const before = target.owner.export();
        const load = () =>
          mode === "initialize"
            ? source.owner.initialize()
            : target.owner.restore(source.owner.export(), undefined, 1);
        if (change === "forged") {
          expect(load).toThrow(/state_requests/);
          expect(target.owner.export()).toEqual(before);
        } else {
          expect(load).not.toThrow();
          const owner = mode === "initialize" ? source.owner : target.owner;
          expect(owner.get(ns, "dependency")?.value).toBe(
            change === "deleted" ? undefined : 2,
          );
        }
      } finally {
        await source.close();
        await target.close();
      }
    },
  );

test.each([
  ["initialize", "missing"],
  ["restore", "missing"],
  ["initialize", "forged"],
  ["restore", "forged"],
])(
  "%s refuses %s covered record request witnesses contradicted by its event",
  async (mode, changed) => {
    const source = await fixture(),
      target = await fixture();
    try {
      source.owner.initialize();
      source.owner.put(ns, "answer", { original: true }, actor, {
        expectRevision: 0,
        requestId: "covered-put",
      });
      source.owner.put(ns, "anchor", {}, actor, { expectRevision: 0 });
      source.owner.checkpoint(1);
      const events = source.owner.events(ns);
      if (changed === "missing") {
        source.db.run(
          "DELETE FROM state_requests WHERE request_id='covered-put'",
        );
        source.db.run(
          "DELETE FROM state_checkpoint_receipts WHERE request_id='covered-put'",
        );
      } else {
        const row = source.db.get(
          "SELECT result FROM state_requests WHERE request_id='covered-put'",
        )!;
        const result = JSON.parse(String(row.result)) as {
          value: { original: boolean };
        };
        result.value.original = false;
        source.db.run(
          "UPDATE state_requests SET result=? WHERE request_id='covered-put'",
          [canonicalJson(result)],
        );
        source.db.run(
          "UPDATE state_checkpoint_receipts SET result_digest=? WHERE request_id='covered-put'",
          [recordDigest(result)],
        );
      }
      expect(source.owner.events(ns)).toEqual(events);
      target.owner.initialize();
      const before = target.owner.export();
      expect(() =>
        mode === "initialize"
          ? source.owner.initialize()
          : target.owner.restore(source.owner.export(), undefined, 1),
      ).toThrow(/state_requests/);
      expect(target.owner.export()).toEqual(before);
    } finally {
      await source.close();
      await target.close();
    }
  },
);

test("lease witnesses beyond 5,000 JSON values decode row-wise", async () => {
  const s = await fixture();
  try {
    s.owner.initialize();
    for (let n = 0; n < 1000; n++)
      s.owner.acquire(ns, `subject:${n}`, holder, 60_000, `request:${n}`);
    s.owner.checkpoint(16);
    expect(
      withinRestoreBudget(
        JSON.stringify(readReplayStart(s.db, 16, true).checkpoint?.receipts),
      ),
    ).toBe(false);
    const parse = JSON.parse;
    try {
      JSON.parse = (...args: Parameters<typeof JSON.parse>) => {
        if (!withinRestoreBudget(args[0]))
          throw new Error("synthetic 5,000-value parser cap");
        return parse(...args) as unknown;
      };
      const seed = readReplayStart(s.db, 16, true).checkpoint;
      expect(seed?.receipts).toHaveLength(1000);
      s.owner.initialize();
      verifyEventDerivedState(s.db, high(s), 16);
    } finally {
      JSON.parse = parse;
    }
  } finally {
    await s.close();
  }
});

test.each([1, 2, 256])(
  "coordination prefix resumes atomically after a receipt interruption: batch %s",
  async (batch) => {
    const s = await fixture();
    try {
      prefix(s);
      const before = s.owner.export();
      let armed = true;
      const proxy: SqlDatabase = {
        exec: (sql) => s.db.exec(sql),
        get: (sql, args) => s.db.get(sql, args),
        all: (sql, args) => s.db.all(sql, args),
        transaction: (work) => s.db.transaction(work),
        run(sql, args) {
          if (
            armed &&
            sql.startsWith("INSERT INTO state_checkpoint_receipts") &&
            args?.[1] === "answer-1"
          )
            throw new Error("synthetic receipt interruption");
          return s.db.run(sql, args);
        },
      };
      const owner = new StateOwner(proxy, { now: () => 1000 });
      expect(() => owner.checkpoint(batch)).toThrow(
        "synthetic receipt interruption",
      );
      const covered = Number(
        s.db.get("SELECT covered_sequence FROM state_checkpoint_header")
          ?.covered_sequence ?? 0,
      );
      expect(covered).toBeLessThan(high(s));
      for (const table of ["leases", "receipts", "live"])
        expect(
          s.db.get(`SELECT 1 FROM state_checkpoint_${table} WHERE sequence>?`, [
            covered,
          ]),
        ).toBeUndefined();
      armed = false;
      expect(owner.checkpoint(batch)).toBe(high(s));
      s.owner.initialize();
      expect(s.owner.export().records).toEqual(before.records);
      expect(s.owner.export().leases).toEqual(before.leases);
      expect(s.owner.export().requests).toEqual(before.requests);
      expect(s.owner.export().events).toEqual(before.events);
    } finally {
      await s.close();
    }
  },
);

test("checkpoint restore still admits every live record against the target families", async () => {
  const s = await fixture(),
    target = await fixture();
  try {
    prefix(s);
    s.owner.checkpoint(1);
    const owner = new StateOwner(target.db, { now: () => 1000 }, [
      {
        namespace: ns,
        families: {
          allowed: { key: /^allowed$/, admit: () => undefined },
        },
      },
    ]);
    owner.initialize();
    const before = owner.export();
    expect(() => owner.restore(s.owner.export(), undefined, 1)).toThrow(
      /STATE_FAMILY_UNDECLARED/,
    );
    expect(owner.export()).toEqual(before);
  } finally {
    await s.close();
    await target.close();
  }
});

test("checkpoint load cannot replay an old acquisition into current authority", async () => {
  const s = await fixture();
  try {
    prefix(s);
    s.owner.checkpoint(1);
    s.owner.initialize();
    const before = s.owner.export();
    expect(() =>
      s.owner.acquire(ns, "subject", holder, 60_000, "acquire-1"),
    ).toThrow();
    expect(s.owner.export()).toEqual(before);
  } finally {
    await s.close();
  }
});

test.each([
  ["initialize", false],
  ["restore", false],
  ["initialize", true],
  ["restore", true],
] as const)(
  "%s refuses an omitted lease seed; covered events removed=%s",
  async (mode, removed) => {
    const source = await fixture(),
      target = await fixture();
    try {
      source.owner.initialize();
      const first = source.owner.acquire(ns, "s", holder, 60_000, "first");
      source.owner.release(ns, first);
      source.owner.acquire(ns, "s", holder, 60_000, "second");
      source.owner.put(ns, "anchor", {}, actor, { expectRevision: 0 });
      source.owner.checkpoint(1);
      const events = source.owner.events(ns);
      const requests = source.owner.export().requests;
      source.db.run("DELETE FROM state_checkpoint_leases WHERE subject='s'");
      source.db.run("DELETE FROM state_leases WHERE subject='s'");
      expect(source.owner.events(ns)).toEqual(events);
      expect(source.owner.export().requests).toEqual(requests);
      if (removed) source.db.run("DELETE FROM state_events");
      target.owner.initialize();
      expect(() =>
        mode === "initialize"
          ? source.owner.initialize()
          : target.owner.restore(source.owner.export()),
      ).toThrow();
      expect(target.owner.export().leases).toEqual([]);
    } finally {
      await source.close();
      await target.close();
    }
  },
);

test.each([
  ["initialize", "holder"],
  ["restore", "holder"],
  ["initialize", "sequence"],
  ["restore", "sequence"],
])(
  "%s refuses a %s-swapped seed despite matching generation and canonical live body",
  async (mode, changed) => {
    const source = await fixture(),
      target = await fixture();
    try {
      source.owner.initialize();
      const a = { ...holder, session: { ...holder.session, id: "holder-a" } };
      const first = source.owner.acquire(ns, "s", a, 60_000, "first");
      source.owner.release(ns, first);
      source.owner.acquire(ns, "s", a, 60_000, "second");
      source.owner.put(ns, "anchor", {}, actor, { expectRevision: 0 });
      source.owner.checkpoint(1);
      const events = source.owner.events(ns);
      const requests = source.owner.export().requests;
      for (const table of changed === "holder"
        ? ["state_checkpoint_leases", "state_leases"]
        : []) {
        const row = source.db.get(
          `SELECT body FROM ${table} WHERE subject='s'`,
        )!;
        const body = JSON.parse(String(row.body)) as {
          holder: { session: { id: string } };
        };
        body.holder.session.id = "holder-b";
        source.db.run(`UPDATE ${table} SET body=? WHERE subject='s'`, [
          canonicalJson(body),
        ]);
      }
      if (changed === "sequence")
        source.db.run(
          "UPDATE state_checkpoint_leases SET sequence=2 WHERE subject='s'",
        );
      expect(source.owner.events(ns)).toEqual(events);
      expect(source.owner.export().requests).toEqual(requests);
      target.owner.initialize();
      const before = target.owner.export();
      expect(() =>
        mode === "initialize"
          ? source.owner.initialize()
          : target.owner.restore(source.owner.export()),
      ).toThrow();
      expect(target.owner.export()).toEqual(before);
    } finally {
      await source.close();
      await target.close();
    }
  },
);
