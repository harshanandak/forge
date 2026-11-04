// [integration] Real children reach the deadline through the POSIX tree or Windows supervisor.
import { expect, test } from "bun:test";
import { createProcessPort } from "../../../src/adapters/process/index.ts";

// Match the real-process fixture and assembly provider's cleanup configuration.
const supervision = {
  cleanupTimeoutMs: 5000,
  pollIntervalMs: 25,
  drainTimeoutMs: 250,
  maxConcurrent: 1,
};

test("a timeout preserves the live child's state before cleanup", async () => {
  const port = createProcessPort({ supervision });
  const result = await port.run(
    { kind: "resolved", path: process.execPath },
    ["-e", "setInterval(() => {}, 1000)"],
    {
      cwd: import.meta.dirname,
      env: {},
      timeoutMs: 1000,
      maxOutputBytes: 100,
    },
  );
  expect(result).toMatchObject({
    timedOut: true,
    exitCode: null,
    signal: "SIGKILL",
  });
  expect(result.supervision?.commandPid).toBeGreaterThan(0);
  if (process.platform === "win32") {
    // Windows runs through the supervisor, which does not record this snapshot.
    expect(result.supervision?.backend).toBe("windows-job");
    expect(result).not.toHaveProperty("diagnostics");
  } else {
    // Only the POSIX runProcessTree path records pre-cleanup diagnostics.
    expect(result.supervision?.backend).toBe("process-group");
    expect(result.diagnostics).toMatchObject({
      exitCode: null,
      signalCode: null,
      killed: false,
      stdoutReadableEnded: false,
      stderrReadableEnded: false,
      stdoutBytes: 0,
      stderrBytes: 0,
    });
    const timeline = result.diagnostics?.timeline as Record<string, unknown>;
    expect(typeof timeline.spawn).toBe("number");
    expect(timeline.spawn).toBeGreaterThanOrEqual(0);
    expect(timeline).not.toHaveProperty("exit");
    expect(timeline).not.toHaveProperty("close");
  }
}, 10_000);

test("normal completion omits timeout diagnostics", async () => {
  const port = createProcessPort({ supervision });
  const result = await port.run(
    { kind: "resolved", path: process.execPath },
    ["-e", "process.stdout.write('ready')"],
    { cwd: import.meta.dirname, env: {}, timeoutMs: 5000, maxOutputBytes: 100 },
  );
  expect(result).toMatchObject({
    timedOut: false,
    exitCode: 0,
    stdout: "ready",
  });
  expect(result).not.toHaveProperty("diagnostics");
}, 10_000);
