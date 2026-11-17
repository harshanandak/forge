import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { StateOwner } from "../core/state/index.ts";
import { refuse } from "../core/trust/index.ts";
import type { ServiceScope } from "../core/runtime/index.ts";
import { windowsPrivateFiles } from "../adapters/process/windows-acl.ts";
import {
  isEmptyFolder,
  writePrivateFolder,
} from "../adapters/store-sqlite/file-ops.ts";
import { privateFileGuard } from "../adapters/store-sqlite/private-files.ts";
import type { StoreExport } from "../ports/store-export.ts";
import { version } from "../version.ts";

function destination(input: unknown): string {
  const out =
    typeof input === "object" && input !== null && "out" in input
      ? input.out
      : undefined;
  if (typeof out !== "string" || out === "")
    refuse("INPUT_INVALID", "Store export needs an out folder");
  return resolve(out);
}

export function createStoreExport(
  scope: ServiceScope,
  owner: StateOwner | undefined,
): StoreExport {
  return {
    export(input) {
      if (scope.signal.aborted)
        refuse("SERVICE_EXPIRED", "Invocation was cancelled");
      if (!scope.effects.includes("files:write"))
        refuse("EFFECT_UNDECLARED", "Store export requires files:write");
      if (owner === undefined)
        refuse("UNAVAILABLE", "There is no Forge store to export");
      const out = destination(input);
      if (!isEmptyFolder(out))
        refuse("INPUT_CONFLICT", "Store export needs an empty folder");
      const started = performance.now();
      const backup = owner.backup();
      const sha256 = createHash("sha256").update(backup.image).digest("hex");
      const records = backup.tables.state_records ?? 0;
      const source = {
        sha256,
        eventHighWaterMark: backup.eventHighWaterMark,
        records,
        at: new Date().toISOString(),
        schemaVersion: backup.schemaVersion,
        tables: backup.tables,
        elapsedMs: Math.round(performance.now() - started),
        forgeVersion: version,
      };
      writePrivateFolder(
        out,
        {
          "backup.sqlite": backup.image,
          "source.json": Buffer.from(JSON.stringify(source)),
        },
        process.platform === "win32"
          ? privateFileGuard(windowsPrivateFiles())
          : undefined,
      );
      return {
        out,
        sha256,
        eventHighWaterMark: source.eventHighWaterMark,
        records,
      };
    },
  };
}
