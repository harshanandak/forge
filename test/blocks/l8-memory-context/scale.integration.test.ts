import { afterEach, expect, test } from "bun:test";
import { done, openHarness, type Harness } from "./lib.ts";

// One coarse smoke on the real store and the real one-second block deadline, in the serial
// integration lane. The counts that prove scale are in scale.test.ts; this only shows the real
// path completes. It asserts no timings of its own: the runtime's deadline is the limit.

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

test("integration: a 1,200-note device restores page by page and is searched inside the real deadline", async () => {
  harness = await openHarness(["memory"]);
  const h = harness;
  const words = Array.from({ length: 60 }, (_, index) => `topic${index}`);
  for (let start = 0; start < 1200; start += 50) {
    const notes = Array.from({ length: 50 }, (_, offset) => {
      const number = start + offset + 1;
      return {
        id: `note-${number}`,
        tags: [],
        links: [],
        text: {
          kind: "untrusted",
          source: "seed",
          text: Array.from(
            { length: 30 },
            (_, at) => words[(number * 7 + at * 3) % 60],
          ).join(" "),
        },
      };
    });
    done(
      await h.call("memory.restore", {
        format: "forge.memory.export/1",
        notes,
      }),
    );
  }
  const agent = { caller: "agent" as const };
  const found = done(
    await h.call(
      "memory.search",
      { query: words.slice(0, 45).join(" "), limit: 5 },
      agent,
    ),
  ) as { hits: unknown[]; scanned: number; next?: string };
  expect(found.hits).toHaveLength(5);
  expect(found.scanned).toBe(1000);
  expect(found.next).toBeDefined();
  const older = done(
    await h.call(
      "memory.search",
      // The next older window starts below the oldest note of the first (note 201).
      { query: "topic3", limit: 5, cursor: "201:0" },
      agent,
    ),
  ) as { scanned: number };
  expect(older.scanned).toBe(200);
}, 180_000);
