import { test, expect } from "bun:test";
import { createProcessService } from "../../../src/assembly/providers.ts";
import type { ProcessPort } from "../../../src/ports/process.ts";

test("process launches require the operation effect, with host cancellation and deadline", async () => {
  const controller = new AbortController();
  let calls = 0;
  const port: ProcessPort = {
    capability: "forge.process/v1",
    resolve: () => ({ kind: "resolved", path: "fake" }),
    run(_program, _args, options) {
      calls++;
      expect(options.signal).toBe(controller.signal);
      expect(options.timeoutMs).toBeLessThanOrEqual(1000);
      expect(options.containment).toBe("supervised");
      return Promise.resolve({
        exitCode: 0,
        signal: null,
        stdout: "ok",
        stderr: "",
        timedOut: false,
        truncated: false,
        durationMs: 0,
      });
    },
  };
  const scope = {
    op: "sample.run",
    effects: [],
    signal: controller.signal,
    deadline: Date.now() + 1000,
    processContainment: "supervised" as const,
  };
  const readonly = createProcessService(port, scope, "/project");
  const denied = await readonly
    .run({ kind: "resolved", path: "fake" }, [], {
      cwd: "/project",
      env: {},
      timeoutMs: 10000,
      maxOutputBytes: 100,
    })
    .catch((error: unknown) => error);
  expect(denied).toMatchObject({ error: { code: "EFFECT_UNDECLARED" } });
  expect(calls).toBe(0);
  const writable = createProcessService(
    port,
    { ...scope, effects: ["external:process"] },
    "/project",
  );
  expect(
    (
      await writable.run({ kind: "resolved", path: "fake" }, [], {
        cwd: "/project",
        env: {},
        timeoutMs: 10000,
        maxOutputBytes: 100,
      })
    ).stdout,
  ).toBe("ok");
  controller.abort();
  const expired = await writable
    .run({ kind: "resolved", path: "fake" }, [], {
      cwd: "/project",
      env: {},
      timeoutMs: 10000,
      maxOutputBytes: 100,
    })
    .catch((error: unknown) => error);
  expect(expired).toMatchObject({ error: { code: "SERVICE_EXPIRED" } });
  expect(calls).toBe(1);
}, 5000);
