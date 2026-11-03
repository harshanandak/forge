import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import { StateOwner } from "../../../src/core/state/index.ts";

test.each(["get", "putMany"])(
  "%s probes only at transaction boundaries",
  async (method) => {
    const work = realpathSync(
      mkdtempSync(join(tmpdir(), "forge-store-probes-")),
    );
    let probes = 0;
    let locks = 0;
    try {
      const opened = await createSqliteStore(work, {
        step(name) {
          if (name === "store-probe") probes++;
          if (name === "write-lock-attempt") locks++;
        },
      }).open({ path: "state.db", readOnly: false });
      if (!opened.ok) throw new Error(opened.unavailable.reason);
      try {
        const owner = new StateOwner(opened.handle.value, { now: () => 1 });
        owner.initialize();
        probes = 0;
        locks = 0;
        if (method === "get") {
          expect(owner.get("test/probes", "missing")).toBeUndefined();
        } else {
          expect(
            owner.putMany(
              "test/probes",
              ["first", "second", "third"].map((key) => ({
                key,
                value: key,
                expectRevision: 0,
              })),
              { kind: "human", id: "test" },
            ),
          ).toHaveLength(3);
        }
        expect(locks).toBe(1);
        expect(probes).toBe(2);
      } finally {
        await opened.handle.close();
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
  30000,
);
