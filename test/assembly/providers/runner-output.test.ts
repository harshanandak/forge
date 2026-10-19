import { expect, test } from "bun:test";
import {
  assemblyProvides,
  createAssemblyProviders,
} from "../../../src/assembly/providers.ts";
import type { ProcessPort } from "../../../src/ports/process.ts";

test("runner-output is a pure declared provider with invocation lifetime", () => {
  expect(assemblyProvides("forge.runner-output@1")).toBe(true);
  const port: ProcessPort = {
    capability: "forge.process/v1",
    resolve() {
      throw Error("pure parsing must not resolve a process");
    },
    run() {
      throw Error("pure parsing must not launch a process");
    },
  };
  const controller = new AbortController();
  let deadline = Date.now() + 5000;
  const output = createAssemblyProviders(
    "/unused",
    { env: {} },
    port,
  ).runnerOutput({
    op: "sample.parse",
    effects: [],
    signal: controller.signal,
    get deadline() {
      return deadline;
    },
    processContainment: "supervised",
  });
  expect(
    output.parse('{"numTotalTests":7,"numFailedTests":2}', "", "json"),
  ).toMatchObject({
    kind: "recognized",
    testCount: 7,
    failed: 2,
  });
  expect(output.parse("", "", "exit-code")).toMatchObject({
    kind: "unknown",
    testCount: null,
  });
  deadline = 0;
  expect(() => output.parse("", "", "auto")).toThrow(
    "Invocation deadline exceeded",
  );
  deadline = Date.now() + 5000;
  controller.abort();
  expect(() => output.parse("", "", "auto")).toThrow(
    "Invocation was cancelled",
  );
}, 5000);
