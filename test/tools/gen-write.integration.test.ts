// [integration] Real concurrent Bun processes publish one generated output.
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const WRITERS = 5;
// The failing main run completed this test in 143 ms; 10 s covers loaded runners while
// leaving time for a named child failure before Bun's 15 s test deadline.
const CHILD_DEADLINE_MS = 10_000;

test("concurrent writers publish identical complete content", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-gen-race-"));
  const file = join(root, "out", "output.txt");
  const source = join(root, "source.txt");
  const content = "generated content\n".repeat(10_000);
  const script = new URL("../../tools/gen/write.ts", import.meta.url).href;
  const command = `import { readFileSync } from "node:fs"; import { writeGenerated } from ${JSON.stringify(script)}; writeGenerated(process.argv[1], readFileSync(process.argv[2], "utf8"));`;
  let incomplete: string | undefined;
  let observer: ReturnType<typeof setInterval> | undefined;
  try {
    writeFileSync(source, content);
    observer = setInterval(() => {
      if (incomplete !== undefined || !existsSync(file)) return;
      if (readFileSync(file, "utf8") !== content)
        incomplete = "a reader observed incomplete generated content";
    }, 1);
    const outcomes = await Promise.allSettled(
      Array.from(
        { length: WRITERS },
        (_, index) =>
          new Promise<void>((resolve, reject) => {
            const child = spawn(
              process.execPath,
              ["-e", command, file, source],
              { stdio: ["ignore", "ignore", "pipe"] },
            );
            let stderr = "";
            let timedOut = false;
            const message = (reason: string) =>
              new Error(
                `writer ${index + 1}/${WRITERS} ${reason}${stderr ? `: ${stderr}` : ""}`,
              );
            const deadline = setTimeout(() => {
              timedOut = true;
              child.kill();
            }, CHILD_DEADLINE_MS);
            const closeDeadline = setTimeout(() => {
              reject(message("did not close after its deadline and kill"));
            }, CHILD_DEADLINE_MS + 2_000);
            const clearDeadlines = () => {
              clearTimeout(deadline);
              clearTimeout(closeDeadline);
            };
            child.stderr.setEncoding("utf8");
            child.stderr.on("data", (chunk: string) => {
              stderr += chunk;
            });
            child.on("error", (error) => {
              clearDeadlines();
              reject(message(`could not start: ${error.message}`));
            });
            child.on("close", (code, signal) => {
              clearDeadlines();
              if (timedOut)
                reject(
                  message(
                    `exceeded ${CHILD_DEADLINE_MS} ms (signal ${signal})`,
                  ),
                );
              else if (code !== 0)
                reject(message(`exited ${code} (signal ${signal})`));
              else resolve();
            });
          }),
      ),
    );
    const failure = outcomes.find((outcome) => outcome.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    expect(incomplete).toBeUndefined();
    expect(readFileSync(file, "utf8")).toBe(content);
    expect(readdirSync(join(root, "out"))).toEqual(["output.txt"]);
  } finally {
    if (observer !== undefined) clearInterval(observer);
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
