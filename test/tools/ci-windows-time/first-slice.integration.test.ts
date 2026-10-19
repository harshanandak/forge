import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFixtures } from "../../integration/fixtures/run.ts";

test("positive fixtures reach a shared barrier and preserve each captured result", async () => {
  const work = mkdtempSync(join(tmpdir(), "forge-positive-barrier-"));
  const waiting = new Map<string, Socket>();
  const sockets = new Set<Socket>();
  let barrierError: Error | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    let input = "";
    socket.on("data", (chunk: string) => {
      input += chunk;
      if (!input.endsWith("\n")) return;
      if (barrierError) {
        socket.end("abort\n");
        return;
      }
      waiting.set(input.trim(), socket);
      if (waiting.size === 3) {
        clearTimeout(watchdog);
        // No fixture can finish until all three have reached the barrier.
        for (const peer of waiting.values()) peer.end("release\n");
      }
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("fixture barrier did not bind a TCP port");
    const script = join(work, "barrier.mjs");
    writeFileSync(
      script,
      `
import { createConnection } from "node:net";
const [port, index] = process.argv.slice(2);
const release = await new Promise((resolve, reject) => {
  const socket = createConnection({ host: "127.0.0.1", port: Number(port) });
  let response = "";
  socket.setEncoding("utf8");
  socket.on("connect", () => socket.write(index + "\\n"));
  socket.on("data", chunk => { response += chunk; });
  socket.on("error", reject);
  socket.on("end", () => resolve(response));
});
if (release !== "release\\n") throw new Error("fixture barrier aborted before all fixtures arrived");
console.log(index);
`,
    );
    // A deadlock guard only: success depends on arrivals, never elapsed time.
    watchdog = setTimeout(() => {
      barrierError = new Error(
        `fixture barrier deadlocked: ${waiting.size}/3 fixtures arrived; the runner must start all fixtures before waiting for one to finish`,
      );
      for (const peer of waiting.values()) peer.end("abort\n");
    }, 5000);
    let results: string[];
    try {
      results = await runFixtures(
        [0, 1, 2].map((index) => ({
          label: `barrier ${index}`,
          command: process.execPath,
          args: [script, String(address.port), String(index)],
          cwd: work,
          env: process.env,
        })),
      );
    } catch (error) {
      throw barrierError ?? error;
    }
    expect([...waiting.keys()].sort()).toEqual(["0", "1", "2"]);
    expect(results).toEqual(["0\n", "1\n", "2\n"]);
  } finally {
    clearTimeout(watchdog);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(work, { recursive: true, force: true });
  }
}, 10000);

for (const failure of ["exit", "spawn"] as const)
  test(`positive fixture ${failure} failure drains its successful sibling`, async () => {
    const work = mkdtempSync(join(tmpdir(), "forge-positive-failure-"));
    try {
      const finished = join(work, "finished");
      const slow = join(work, "slow.mjs");
      writeFileSync(
        slow,
        `import { writeFileSync } from "node:fs"; await new Promise(resolve => setTimeout(resolve, 100)); writeFileSync(process.argv[2], "finished");`,
      );
      let failed = false;
      try {
        await runFixtures([
          {
            label: "fails",
            command:
              failure === "exit"
                ? process.execPath
                : join(work, "missing-runtime"),
            args: ["-e", "process.exit(7)"],
            cwd: work,
            env: process.env,
          },
          {
            label: "finishes",
            command: process.execPath,
            args: [slow, finished],
            cwd: work,
            env: process.env,
          },
        ]);
      } catch (error) {
        failed = true;
        expect(error).toBeInstanceOf(AggregateError);
      }
      expect(failed).toBe(true);
      expect(existsSync(finished)).toBe(true);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 10000);
