import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function assertInstalledBuildIdentity(
  installedDir: string,
  build: unknown,
  runId: string | null,
): void {
  assert.deepEqual(
    JSON.parse(readFileSync(join(installedDir, "dist/build.json"), "utf8")),
    { ...(build as object), runId },
    "installed build identity record must match the reviewed CI run",
  );
}
