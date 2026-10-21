import { expect, test } from "bun:test";
import { createAssemblyProviders } from "../../../src/assembly/providers.ts";
import type { ProcessPort } from "../../../src/ports/process.ts";

test("an operation without file effects starts no Git discovery and cannot use the slot", async () => {
  let starts = 0;
  const process: ProcessPort = {
    capability: "forge.process/v1",
    resolve: () => ({ kind: "resolved", path: "git" }),
    run: () => {
      starts++;
      throw new Error("Unexpected Git discovery");
    },
  };
  const lease = await createAssemblyProviders(
    "/project",
    { env: {} },
    process,
  ).openFiles({
    op: "sample.list",
    effects: [],
    signal: new AbortController().signal,
    deadline: Date.now() + 30000,
    processContainment: "supervised",
  });
  expect(starts).toBe(0);
  expect(() => lease.value.read("file", 100)).toThrow(
    "files:read or files:write",
  );
  expect(() => lease.value.roots).toThrow("files:read or files:write");
  await lease.close();
}, 5000);
