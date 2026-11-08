#!/usr/bin/env node
import { buildIdentity, version } from "../src/version.ts";

const argv = process.argv.slice(2);
if (
  (argv[0] === "--version" || argv[0] === "-v") &&
  (argv.length === 1 || (argv.length === 2 && argv[1] === "--json"))
) {
  if (argv[1] === "--json")
    process.stdout.write(`${JSON.stringify(buildIdentity)}\n`);
  else process.stdout.write(`${version}\n`);
  process.exitCode = 0;
} else {
  // A command is a short, allocation-heavy start-up. Letting V8 grow its young generation to 16 MB
  // costs about 6 MB of resident memory for no speed a one-shot process can use; growth stays at
  // the initial size. The flag is read when the heap would grow, so setting it here takes effect.
  (await import("node:v8")).setFlagsFromString("--semi-space-growth-factor=1");
  const { runLocalCommand } = await import("../src/assembly/command.ts");
  process.exitCode = await runLocalCommand(argv);
}
