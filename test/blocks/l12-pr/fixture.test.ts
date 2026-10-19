import { expect, test } from "bun:test";
import { checkNodeId } from "../../node-fixtures/l12-pr/check-id.ts";

test("fake GitHub keeps separate checks with the same context on current and stale heads", () => {
  for (const appId of [null, 7]) {
    const current = { name: "tests", headSha: "a".repeat(40), appId };
    const stale = { ...current, headSha: "c".repeat(40) };
    const observations = [
      checkNodeId(current, 0),
      checkNodeId(stale, 1),
      checkNodeId(current, 2),
    ];
    expect(new Set(observations).size).toBe(3);
    expect(checkNodeId(current, 0)).toBe(checkNodeId(current, 0));
    expect(checkNodeId(current, 0)).not.toBe(checkNodeId(stale, 0));
  }
}, 5000);
