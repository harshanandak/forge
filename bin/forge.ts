#!/usr/bin/env node
import { version } from "../src/version.ts";
import { runCommand } from "../src/surface/command.ts";
import { createLocalAssembly, localCall } from "../src/assembly/index.ts";
import { assemblyMcp } from "../src/assembly/mcp.ts";

const assembly = await createLocalAssembly();
try {
  process.exitCode = await runCommand(process.argv.slice(2), {
    catalog: assembly.catalog,
    version,
    call: localCall(assembly),
    mcp: assemblyMcp(assembly),
  });
} finally {
  await assembly.close();
}
