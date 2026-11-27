import { version } from "../version.ts";
import { ForgeFailure } from "../contract/failure.ts";
import { escapeDisplayText } from "../contract/display-text.ts";
import { runCommand } from "../surface/command.ts";
import { failure, respond } from "../surface/result.ts";
import { localCall, withLocalCommandAssembly } from "./index.ts";
import type { Assembly } from "./index.ts";
import type { SurfaceCatalog } from "../surface/catalog.ts";
import { assemblyMcp } from "./mcp.ts";

/** Keep host bootstrap and its failures inside the CLI's response boundary. */
export async function runLocalCommand(
  argv: readonly string[],
): Promise<number> {
  return await localCommandResult(argv, () =>
    withLocalCommandAssembly(argv[0] !== "--mcp", (assembly) =>
      dispatchLocalCommand(argv, assembly),
    ),
  );
}

export function dispatchLocalCommand(
  argv: readonly string[],
  assembly: Assembly,
  catalog: SurfaceCatalog = assembly.catalog,
): Promise<number> {
  return runCommand(argv, {
    catalog,
    version,
    call: localCall(assembly),
    mcp: assemblyMcp(assembly),
  });
}

export async function localCommandResult(
  argv: readonly string[],
  execute: () => Promise<number>,
): Promise<number> {
  try {
    return await execute();
  } catch (error) {
    const response = respond(
      error instanceof ForgeFailure
        ? { ok: false, status: "FAIL", error: error.error, warnings: [] }
        : failure(
            "INTERNAL",
            error instanceof Error ? error.message : "Assembly failed",
          ),
    );
    if (argv[0] === "--mcp") {
      process.stderr.write(escapeDisplayText(response.stdout));
    } else {
      process.stdout.write(response.stdout);
    }
    return response.exitCode;
  }
}
