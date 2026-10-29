import { expect, test } from "bun:test";
import { childStep } from "./child-step.ts";

test("child failures name the step and its measured duration", async () => {
  for (const run of [
    () => {
      throw new Error("exit null; empty stderr");
    },
    () => Promise.reject(new Error("exit null; empty stderr")),
  ]) {
    await expect(childStep("git init", run)).rejects.toThrow(
      /git init after \d+ ms: exit null; empty stderr/,
    );
  }
}, 30_000);

test("a successful child preserves its output", async () => {
  const output = { status: 0, stdout: "example result" };
  expect(await childStep("PowerShell examples", () => output)).toBe(output);
}, 30_000);
