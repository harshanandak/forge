import { expect, test } from "bun:test";
import { supervisedSpawnFailure } from "../../../src/adapters/process/run.ts";

for (const code of ["ENOENT", "EACCES", "EPERM"]) {
  test(`supervised spawn failure preserves ${code} as an errno cause`, () => {
    const error = supervisedSpawnFailure(code);
    expect(error.code).toBe("SPAWN_FAILED");
    expect(error.message).toBe("Could not start supervised command");
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.cause).toMatchObject({ code });
  }, 5000);
}

for (const [index, value] of [
  undefined,
  null,
  2,
  {},
  ["ENOENT"],
  "",
  "enoent",
  "EBOGUS",
  "ENOENT\n",
  "E".repeat(100_000),
].entries()) {
  test(`invalid supervisor errno case ${index} keeps a generic failure`, () => {
    const error = supervisedSpawnFailure(value);
    expect(error.code).toBe("SPAWN_FAILED");
    expect(error.message).toBe("Could not start supervised command");
    expect(error.cause).toBeUndefined();
  }, 5000);
}
