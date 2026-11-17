import { expect, setDefaultTimeout, test } from "bun:test";
import {
  StateOwner,
  verifyEventDerivedState,
} from "../../../src/core/state/index.ts";
import { readReplayStart } from "../../../src/core/state/checkpoint.ts";
import { withinRestoreBudget } from "../../../src/core/state/restore-json.ts";
import { actor, ns, fixture, high } from "./record-checkpoint.fixture.ts";

setDefaultTimeout(30_000);

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

test.each(["lease body", "generation", "receipt digest", "missing receipt"])(
  "initialize and restore refuse forged checkpoint %s without publication",
  async (kind) => {
    const s = await fixture(),
      target = await fixture();
    try {
      prefix(s);
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

test("lease witnesses beyond 5,000 JSON values decode row-wise", async () => {
  const s = await fixture();
  try {
    s.owner.initialize();
    s.db.transaction(() => {
      for (let n = 0; n < 200; n++)
        s.owner.acquire(ns, `subject:${n}`, holder, 60_000, `request:${n}`);
    });
    s.owner.checkpoint(16);
    const parse = JSON.parse;
    try {
      JSON.parse = (...args: Parameters<typeof JSON.parse>) => {
        if (!withinRestoreBudget(args[0]))
          throw new Error("synthetic 5,000-value parser cap");
        return parse(...args) as unknown;
      };
      const seed = readReplayStart(s.db, 16, true).checkpoint;
      expect(seed?.receipts).toHaveLength(200);
      s.owner.initialize();
      verifyEventDerivedState(s.db, high(s), 16);
    } finally {
      JSON.parse = parse;
    }
  } finally {
    await s.close();
  }
});
