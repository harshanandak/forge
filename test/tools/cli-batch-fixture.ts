import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

// Reuse only the interpreter. Each request evaluates a fresh real CLI module;
// separate workers keep fault injection out of the competing command.
export function cliBatchFixture(options: {
  root: string;
  name: string;
  script: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  setup?: string;
}) {
  const helper = join(options.root, `${options.name}-batch.ts`);
  writeFileSync(
    helper,
    `${options.setup ?? ""}
import {createInterface} from 'node:readline';
const input=createInterface({input:process.stdin});let iteration=0;
for await(const _line of input){
 process.argv=[process.execPath,${JSON.stringify(options.script)},...${JSON.stringify(options.args)}];
 process.exitCode=0;
 await import(${JSON.stringify(pathToFileURL(options.script).href)}+'?batch='+iteration++);
 console.log(JSON.stringify({batchExit:process.exitCode}));
 process.exitCode=0;
}
`,
  );
  const child = spawn(process.execPath, [helper], {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    detached: true,
  });
  const output = createInterface({ input: child.stdout });
  const lines = output[Symbol.asyncIterator]();
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.stdin.on("error", () => {});
  const closed = new Promise<number | null>((done, fail) => {
    child.once("error", fail);
    child.once("close", done);
  });
  // The owner awaits close during cleanup, including an early spawn failure.
  void closed.catch(() => {});
  return {
    child,
    async next() {
      const records: Record<string, unknown>[] = [];
      const result = (async () => {
        child.stdin.write("next\n");
        for (;;) {
          const line = await lines.next();
          if (line.done)
            throw new Error(`CLI batch ended before its result: ${stderr}`);
          const value = JSON.parse(line.value) as Record<string, unknown>;
          if (typeof value.batchExit === "number")
            return { code: value.batchExit, lines: records };
          records.push(value);
        }
      })();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          result,
          new Promise<never>((_done, fail) => {
            timer = setTimeout(
              () => fail(new Error(`CLI batch request timed out: ${stderr}`)),
              20_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    async close() {
      if (!child.stdin.destroyed) child.stdin.end();
      const code = await closed;
      output.close();
      return code;
    },
  };
}
