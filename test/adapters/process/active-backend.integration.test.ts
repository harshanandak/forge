// [integration] Exercise the backend selected by this runtime, including Bun's native POSIX path.
import { expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { createProcessPort } from "../../../src/adapters/process/index.ts";
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

test("200 sequential short children retain their output without a timeout", async () => {
  const port = createProcessPort({ supervision });
  for (let iteration = 0; iteration < 200; iteration++) {
    const result = await port.run(
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
  }
}, 30_000);

for (const mode of ["deadline", "cancel"] as const) {
  test(`the active backend stops a child and its running grandchild on ${mode}`, async () => {
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
      const parent = `${control}require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:['ignore','inherit','inherit'],detached:process.platform==='win32'});process.stdout.write('child:'+process.pid+'\\n');setInterval(()=>{},1000);`;
      const controller = new AbortController();
      let observed = "";
      const port = createProcessPort({ supervision });
      const result = await port.run(executable, ["-e", parent], {
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
      expect(result.stdout).toMatch(/child:\d+\n/);
      expect(result.stdout).toMatch(/grandchild:\d+\n/);
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
