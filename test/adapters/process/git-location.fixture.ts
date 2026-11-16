import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createProcessPort } from "../../../src/adapters/process/index.ts";

const [cwd, marker, path] = process.argv.slice(2) as [string, string, string];
const env = { PATH: path, PATHEXT: ".CMD;.BAT;.EXE;.COM" };
const port = createProcessPort({
  supervision: {
    cleanupTimeoutMs: 1000,
    pollIntervalMs: 25,
    drainTimeoutMs: 100,
    maxConcurrent: 1,
  },
});
const found = port.resolve("git", env);
let version = "";
if (found.kind === "resolved") {
  const options = { cwd, env, timeoutMs: 10_000, maxOutputBytes: 4096 };
  await port.run(
    found,
    ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`],
    options,
  );
  version = (await port.run(found, ["--version"], options)).stdout;
}
const cached = createProcessPort().resolve("git", { PATH: cwd });
// A second adapter must reuse the first decision, even if PATH changes.
writeFileSync(
  join(cwd, "result.json"),
  JSON.stringify({ found, cached, version, marker: existsSync(marker) }),
);
