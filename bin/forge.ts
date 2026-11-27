#!/usr/bin/env node
import { buildIdentity, version } from "../src/version.ts";

const directRequests = new WeakSet<object>();
export function consumeDirectRequest(request: object): boolean {
  return import.meta.main && directRequests.delete(request);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (
    (argv[0] === "--version" || argv[0] === "-v") &&
    (argv.length === 1 || (argv.length === 2 && argv[1] === "--json"))
  ) {
    if (argv[1] === "--json")
      process.stdout.write(`${JSON.stringify(buildIdentity)}\n`);
    else process.stdout.write(`${version}\n`);
    process.exitCode = 0;
    return;
  }
  // A command is a short, allocation-heavy start-up. Letting V8 grow its young generation to 16 MB
  // costs about 6 MB of resident memory for no speed a one-shot process can use; growth stays at
  // the initial size. The flag is read when the heap would grow, so setting it here takes effect.
  (await import("node:v8")).setFlagsFromString("--semi-space-growth-factor=1");
  const { runLocalCommand, dispatchLocalCommand, localCommandResult } =
    await import("../src/assembly/command.ts");
  if (argv[0] === "--mcp") {
    let outputFailureCode: number | undefined;
    const exitCode = await runLocalCommand(argv, (code) => {
      outputFailureCode = code;
      process.exitCode = code;
    });
    process.exitCode = outputFailureCode ?? exitCode;
    return;
  }
  const { withLocalCommandAssembly } = await import("../src/assembly/index.ts");
  process.exitCode = await localCommandResult(argv, () =>
    withLocalCommandAssembly(true, (assembly) =>
      dispatchLocalCommand(argv, assembly, {
        ...assembly.catalog,
        invoke(request, signal) {
          directRequests.add(request);
          return assembly.catalog.invoke(request, signal);
        },
      }),
    ),
  );
}

if (import.meta.main) void main();
