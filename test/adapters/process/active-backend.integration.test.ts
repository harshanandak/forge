// [integration] Exercise the backend selected by this runtime, including Bun's native POSIX path.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { createProcessPort } from "../../../src/adapters/process/index.ts";
import type { ProcessPort, ProcessResult } from "../../../src/ports/process.ts";
import { waitUntilGone } from "../../node-fixtures/process/liveness.ts";

const supervision = {
  cleanupTimeoutMs: 5000,
  pollIntervalMs: 25,
  drainTimeoutMs: 250,
  maxConcurrent: 1,
};
const executable = { kind: "resolved", path: process.execPath } as const;
const options = {
  cwd: import.meta.dirname,
  env: {},
  timeoutMs: 5000,
  maxOutputBytes: 1000,
};

function createTestSession() {
  const port = createProcessPort({ supervision });
  const controller = new AbortController();
  const pending = new Set<Promise<void>>();
  const run: ProcessPort["run"] = (file, args, spawnOptions) => {
    const result = port.run(file, args, {
      ...spawnOptions,
      signal: spawnOptions.signal
        ? AbortSignal.any([controller.signal, spawnOptions.signal])
        : controller.signal,
    });
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    pending.add(settled);
    void settled.then(() => pending.delete(settled));
    return result;
  };
  return {
    run,
    async close() {
      controller.abort();
      await Promise.all(pending);
    },
  };
}

let session: ReturnType<typeof createTestSession>;
beforeEach(() => {
  session = createTestSession();
});
// A runner timeout abandons the callback; its finally block alone cannot release the slot.
afterEach(async () => {
  await session.close();
}, 15_000);

test("sequential short children retain their output without a timeout", async () => {
  const { run } = session;
  const started = performance.now();
  let count = 200,
    completed = 0;
  let backend: NonNullable<ProcessResult["supervision"]>["backend"] | undefined;
  for (let iteration = 0; iteration < count; iteration++) {
    const result = await run(
      executable,
      ["-e", "process.stdout.write('ready');process.stderr.write('err')"],
      { ...options, timeoutMs: 1000 },
    );
    expect(result, `short child ${iteration}`).toMatchObject({
      exitCode: 0,
      signal: null,
      timedOut: false,
      truncated: false,
      stdout: "ready",
      stderr: "err",
    });
    if (iteration === 0) {
      backend = result.supervision?.backend;
      expect(["process-group", "windows-job"]).toContain(backend ?? "missing");
      // The 200-child Bun POSIX race proof stays intact; Windows runs fewer children to bound CI time.
      count = backend === "windows-job" ? 20 : 200;
    }
    expect(result.supervision?.backend).toBe(backend);
    completed++;
  }
  expect(completed).toBe(count);
  const elapsed = performance.now() - started;
  console.info(
    `sequential children: platform=${process.platform} backend=${backend} completed=${completed} totalMs=${elapsed.toFixed(1)} perChildMs=${(elapsed / completed).toFixed(1)}`,
  );
}, 30_000);

test("caller timeout teardown releases the supervisor slot before the next test", async () => {
  const ready = Promise.withResolvers<void>();
  const running = session.run(
    executable,
    ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"],
    {
      ...options,
      observer: {
        push(stream) {
          if (stream === "stdout") ready.resolve();
        },
      },
    },
  );
  // Inject the runner abandoning its await while the real child still owns the slot.
  await expect(
    Promise.race([
      running,
      ready.promise.then(() => {
        throw new Error("injected caller timeout");
      }),
    ]),
  ).rejects.toThrow("injected caller timeout");
  const next = createTestSession();
  try {
    await expect(
      next.run(executable, ["-e", ""], options),
    ).rejects.toMatchObject({
      code: "PROCESS_LIMIT_EXCEEDED",
    });
    await session.close();
    expect(await running).toMatchObject({ signal: "SIGKILL", timedOut: false });
    expect(
      await next.run(
        executable,
        ["-e", "process.stdout.write('next')"],
        options,
      ),
    ).toMatchObject({ exitCode: 0, timedOut: false, stdout: "next" });
  } finally {
    await next.close();
  }
}, 30_000);

for (const mode of ["deadline", "cancel"] as const) {
  test(`the active backend stops a child and its running grandchild on ${mode}`, async () => {
    const { run } = session;
    const connections = new Set<Socket>();
    let closing = false;
    const server = createServer((socket) => {
      connections.add(socket);
      socket.once("close", () => connections.delete(socket));
      socket.on("error", () => undefined);
      if (closing) socket.destroy();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing cleanup port");
      // Keep live cleanup connections, rather than signalling saved PIDs that could be reused.
      const control = `const socket=require('node:net').connect(${address.port},'127.0.0.1');socket.on('close',()=>process.exit(0));socket.on('error',()=>process.exit(1));`;
      const grandchild = `${control}process.stdout.write('grandchild:'+process.pid+'\\n');setInterval(()=>{},1000);`;
      // Write the child line before spawning: the grandchild line then always follows it in the shared pipe, so a cancel on the grandchild line cannot kill the child before its own line is written.
      const parent = `${control}process.stdout.write('child:'+process.pid+'\\n');require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:['ignore','inherit','inherit'],detached:process.platform==='win32'});setInterval(()=>{},1000);`;
      const controller = new AbortController();
      let observed = "";
      const result = await run(executable, ["-e", parent], {
        ...options,
        signal: controller.signal,
        observer: {
          push(stream, chunk) {
            if (stream !== "stdout") return;
            observed += Buffer.from(chunk).toString();
            if (mode === "cancel" && /grandchild:\d+\n/.test(observed))
              controller.abort();
          },
        },
      });
      const pids = [
        ...result.stdout.matchAll(/(?:^|\n)(?:child|grandchild):(\d+)(?=\n)/g),
      ].map((match) => Number(match[1]));
      expect(result).toMatchObject({
        exitCode: null,
        signal: "SIGKILL",
        timedOut: mode === "deadline",
        truncated: false,
      });
      expect(result.stdout).toMatch(/(^|\n)child:\d+\n/);
      expect(result.stdout).toMatch(/(^|\n)grandchild:\d+\n/);
      expect(pids).toHaveLength(2);
      expect(await waitUntilGone(pids)).toBe(true);
    } finally {
      closing = true;
      const closed = new Promise<void>((resolve) =>
        server.close(() => resolve()),
      );
      for (const socket of connections) socket.destroy();
      await closed;
    }
  }, 30_000);
}
