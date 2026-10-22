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
    if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
      process.stdout.write(`${version}\n`);
      return 0;
    }
    const assembly = await createLocalAssembly();
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
