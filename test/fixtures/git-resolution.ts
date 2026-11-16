import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProcessPort } from "../../src/adapters/process/index.ts";
import { realFileProbe } from "../../src/adapters/process/resolve.ts";

/** Real PATH/realpath inputs for a fake process port; this file is never launched. */
export function gitResolutionFixture() {
  const directory = mkdtempSync(
    join(process.env.RUNNER_TEMP ?? tmpdir(), "..", "forge-git-resolution-"),
  );
  writeFileSync(
    join(directory, process.platform === "win32" ? "git.exe" : "git"),
    "fixture executable; run is mocked",
    { mode: 0o755 },
  );
  const port = createProcessPort({ probe: { ...realFileProbe } });
  return {
    env: { PATH: directory, PATHEXT: ".EXE" },
    resolve: (name: string, env: Readonly<Record<string, string>>) =>
      port.resolve(name, env),
    [Symbol.dispose]() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
