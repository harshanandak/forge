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

test("assembly preserves structured failure evidence across report layouts and streams", () => {
  const process: ProcessPort = {
    capability: "forge.process/v1",
    resolve() {
      throw Error("pure parsing must not resolve a process");
    },
    run() {
      throw Error("pure parsing must not launch a process");
    },
  };
  const output = createAssemblyProviders(
    "/unused",
    { env: {} },
    process,
  ).runnerOutput({
    op: "sample.parse",
    effects: [],
    signal: new AbortController().signal,
    deadline: Date.now() + 5000,
    processContainment: "supervised",
  });
  const value = { numTotalTests: 1, numFailedTests: 1, success: false };
  const empty = JSON.stringify({ padding: "", ...value });
  for (const json of [
    JSON.stringify(value, null, 2),
    "runner: " + JSON.stringify(value),
    JSON.stringify({
      padding: "x".repeat(65_537 - Buffer.byteLength(empty)),
      ...value,
    }),
  ])
    for (const stream of ["stdout", "stderr"] as const) {
      const stdout =
        "runner setup\nTests: 1 passed, 1 total" +
        (stream === "stdout" ? "\n" + json : "");
      const stderr = stream === "stderr" ? json : "";
      const recognizer = output.recognize("auto");
      for (const [channel, text] of [
        ["stdout", stdout],
        ["stderr", stderr],
      ] as const)
        for (const byte of Buffer.from(text))
          recognizer.push(channel, Uint8Array.of(byte));
      for (const report of [
        output.parse(stdout, stderr, "auto"),
        recognizer.report(),
      ])
        expect(
          report.kind === "malformed" ||
            (report.kind === "recognized" && (report.failed ?? 0) > 0),
        ).toBe(true);
    }
}, 1000);
