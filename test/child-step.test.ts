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

test("cleanup failure follows the original timeout diagnostic", async () => {
  await expect(
    childStep(
      "PowerShell examples",
      () => {
        throw new Error("original timeout");
      },
      () => {
        throw new Error("busy cleanup");
      },
    ),
  ).rejects.toThrow(
    /PowerShell examples after \d+ ms: original timeout\nCleanup failed: Error: busy cleanup/,
  );
}, 30_000);
