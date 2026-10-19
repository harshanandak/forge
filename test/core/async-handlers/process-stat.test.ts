import { expect, test } from "bun:test";
import { parseProcessStat } from "../../../src/adapters/process/linux-process-table.ts";

test("Linux stat parsing finds state and group after the full comm field", () => {
  expect(
    parseProcessStat("124 (a ) tricky\nname)) Z 1 123 123 0", 124),
  ).toEqual({
    pid: 124,
    groupId: 123,
    state: "Z",
  });
  for (const state of ["R", "S", "D", "T", "t", "I"])
    expect(parseProcessStat(`124 (command) ${state} 1 123`, 124).state).toBe(
      state,
    );
}, 5000);

test("malformed process identity and membership never look like an empty group", () => {
  for (const text of [
    "125 (command) Z 1 123",
    "124 command Z 1 123",
    "124 (command) ZZ 1 123",
    "124 (command) Z 1 nope",
    "124 (command) Z 1 9007199254740992",
    "124 (command)",
  ])
    expect(() => parseProcessStat(text, 124)).toThrow();
}, 5000);
