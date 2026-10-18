import { Readable, Writable } from "node:stream";
import type { McpExposure } from "../generated/types.ts";
import type { McpTransportPort } from "../ports/mcp-transport.ts";
import type { SurfaceCatalog } from "./catalog.ts";
import { runCli } from "./cli.ts";
import type { CallOptions } from "./dispatch.ts";
import { runHook } from "./hook.ts";
import { createMcpHandlers } from "./mcp.ts";
import { failure, respond } from "./result.ts";

export interface CommandOptions {
  readonly catalog: SurfaceCatalog;
  readonly version: string;
  readonly call?: CallOptions;
  readonly mcp?: McpTransportPort;
  readonly exposure?: McpExposure;
  readonly input?: Readable;
  readonly output?: Writable;
}

/** Assembly injects the catalog and transport; no block or adapter is selected here. */
export async function runCommand(
  argv: readonly string[],
  options: CommandOptions,
): Promise<number> {
  const output = options.output ?? process.stdout;
  const input = options.input ?? process.stdin;
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
    output.write(`${options.version}\n`);
    return 0;
  }
  if (argv[0] === "--mcp") {
    if (argv.length !== 1 || options.mcp === undefined) {
      const response = respond(
        failure(
          "UNAVAILABLE",
          "MCP requires an assembled transport and no additional arguments.",
        ),
      );
      output.write(response.stdout);
      return response.exitCode;
    }
    const opened = await options.mcp.open({
      handlers: createMcpHandlers(
        options.catalog,
        options.exposure,
        options.call,
      ),
      serverName: "forge",
      serverVersion: options.version,
      input: Readable.toWeb(input),
      output: Writable.toWeb(output),
    });
    if (!opened.ok) {
      const response = respond(
        failure("UNAVAILABLE", opened.unavailable.reason),
      );
      output.write(response.stdout);
      return response.exitCode;
    }
    await new Promise<void>((resolve) => {
      if (input.readableEnded || input.destroyed) resolve();
      else input.once("close", resolve).once("end", resolve);
    });
    await opened.handle.close();
    return 0;
  }
  const response =
    argv[0] === "--hook"
      ? argv.length === 2 && argv[1] !== undefined
        ? await runHook(options.catalog, argv[1], input, options.call)
        : respond(failure("INPUT_INVALID", "Expected --hook <noun.verb>."))
      : await runCli(options.catalog, argv, options.call);
  output.write(response.stdout);
  return response.exitCode;
}
