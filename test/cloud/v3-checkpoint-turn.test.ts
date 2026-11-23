import { expect, test } from "bun:test";
import { checkpointPrefixLength } from "../../cloud/src/v3-checkpoint.ts";

const timeout = 30_000;
const eleven = Array.from({ length: 11 }, () => 43_690);

for (const [name, lengths, count] of [
  ["accepts an empty tail", [], 0],
  ["stops at twelve rows", Array.from({ length: 13 }, () => 1_000), 12],
  ["accepts an exact byte fit", [...eleven, 43_698], 12],
  ["stops before a row one byte over budget", [...eleven, 43_699], 11],
  ["stops after two frames at the cap", [262_144, 262_144, 1], 2],
  ["stops at a legacy oversized first row", [524_289], 0],
  ["accepts an exact fit after a small row", [1, 524_287, 1], 2],
] as const) {
  test(
    `v3 checkpoint turn ${name}`,
    () => expect(checkpointPrefixLength(lengths)).toBe(count),
    timeout,
  );
}
