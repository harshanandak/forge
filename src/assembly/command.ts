import { version } from "../version.ts";
import { ForgeFailure } from "../contract/failure.ts";
import { escapeDisplayText } from "../contract/display-text.ts";
import { runCommand } from "../surface/command.ts";
import { failure, respond } from "../surface/result.ts";
import { localCall, withLocalCommandAssembly } from "./index.ts";
import { assemblyMcp } from "./mcp.ts";

/** Keep host bootstrap and its failures inside the CLI's response boundary. */
export async function runLocalCommand(
  argv: readonly string[],
): Promise<number> {
  try {
    // Only a served connection stays up across calls; every other command exits after one.
    return await withLocalCommandAssembly(argv[0] !== "--mcp", (assembly) =>
      runCommand(argv, {
        catalog: assembly.catalog,
        version,
        call: localCall(assembly),
        mcp: assemblyMcp(assembly),
      }),
    );
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
