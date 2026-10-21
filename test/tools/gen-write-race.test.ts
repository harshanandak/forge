// Concurrent writers on real threads publish one generated output. Threads, not processes:
// the old process race failed on macOS when a child's exit never reached the parent (work-276).
import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

const WRITERS = 5;
// A busy-file crash or an in-place writer fails by round 6; 30 rounds keep that margin inside the budget under load.
const ROUNDS = 30;
const fixture = new URL(
  "../node-fixtures/tools/gen-write-race.ts",
  import.meta.url,
);

type Message = { round: number; incomplete: boolean };

/** Yields a worker's messages in order; an error, or an exit before the last round, fails every wait. */
function inbox(thread: Worker, label: string) {
  const queue: Message[] = [];
  const waiting: Array<(result: Message | Error) => void> = [];
  let failure: Error | undefined;
  thread.on("message", (message: Message) => {
    const next = waiting.shift();
    if (next) next(message);
    else queue.push(message);
  });
  thread.on("error", (error: unknown) => {
    failure ??= new Error(
      `${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
    for (const next of waiting.splice(0)) next(failure);
  });
  thread.on("exit", (code) => {
    failure ??= new Error(`${label} exited ${code} before the last round`);
    for (const next of waiting.splice(0)) next(failure);
  });
  return {
    failure: () => failure,
    next: () =>
      new Promise<Message>((resolve, reject) => {
        const queued = queue.shift();
        if (queued) return resolve(queued);
        if (failure) return reject(failure);
        waiting.push((result) =>
          result instanceof Error ? reject(result) : resolve(result),
        );
      }),
  };
}

test("concurrent writers publish identical complete content", async () => {
  const directory = mkdtempSync(join(tmpdir(), "forge-gen-race-"));
  // Large enough that one write spans many pages, so a non-atomic publish is visible mid-write.
  const content = "generated content\n".repeat(200_000);
  // Each round replaces stale output, so every writer reads the target while others rename over it.
  const stale = "previous contents\n".repeat(200_000);
  const state = new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT);
  const flags = new Int32Array(state);
  const start = (role: "writer" | "reader") =>
    new Worker(fixture, {
      workerData: { role, directory, content, stale, rounds: ROUNDS, state },
    });
  const readerThread = start("reader");
  const writerThreads = Array.from({ length: WRITERS }, () => start("writer"));
  const threads = [readerThread, ...writerThreads];
  const reader = inbox(readerThread, "reader");
  const writers = writerThreads.map((thread, index) =>
    inbox(thread, `writer ${index + 1}/${WRITERS}`),
  );
  const inboxes = [reader, ...writers];
  try {
    for (let round = 1; round <= ROUNDS; round += 1) {
      const published = join(directory, `round-${round}`);
      mkdirSync(published);
      writeFileSync(join(published, "output.txt"), stale);
      // Release every writer at once so their publishes overlap instead of trailing thread start-up.
      while (Atomics.load(flags, 0) < round * threads.length) {
        const failure = inboxes.map((box) => box.failure()).find(Boolean);
        if (failure) throw failure;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      Atomics.store(flags, 1, round);
      Atomics.notify(flags, 1);
      await Promise.all(writers.map((box) => box.next()));
      Atomics.store(flags, 2, round);
      expect(await reader.next()).toEqual({ round, incomplete: false });
      expect(readFileSync(join(published, "output.txt"), "utf8")).toBe(content);
      expect(readdirSync(published)).toEqual(["output.txt"]);
    }
  } finally {
    await Promise.all(threads.map((thread) => thread.terminate()));
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);
