import { version } from "../version.ts";
import { ForgeFailure } from "../contract/failure.ts";
import { runCommand } from "../surface/command.ts";
import { failure, respond } from "../surface/result.ts";
import { createLocalAssembly, localCall } from "./index.ts";
import { assemblyMcp } from "./mcp.ts";

/** Keep host bootstrap and its failures inside the CLI's response boundary. */
export async function runLocalCommand(
  argv: readonly string[],
): Promise<number> {
  try {
    // Only a served connection stays up across calls; every other command exits after one.
    const assembly = await createLocalAssembly({
      oneShot: argv[0] !== "--mcp",
    });
    try {
      return await runCommand(argv, {
        catalog: assembly.catalog,
        version,
        call: localCall(assembly),
        mcp: assemblyMcp(assembly),
      });
    } finally {
      await assembly.close();
    }
  } catch (error) {
    const response = respond(
      error instanceof ForgeFailure
        ? { ok: false, status: "FAIL", error: error.error, warnings: [] }
        : failure(
            "INTERNAL",
            error instanceof Error ? error.message : "Assembly failed",
          ),
    );
    process.stdout.write(response.stdout);
    return response.exitCode;
  }
}
