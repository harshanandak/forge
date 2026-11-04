#!/usr/bin/env node
import { version } from "../src/version.ts";

const argv = process.argv.slice(2);
if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
  process.stdout.write(`${version}\n`);
  process.exitCode = 0;
} else {
  const { runLocalCommand } = await import("../src/assembly/command.ts");
  process.exitCode = await runLocalCommand(argv);
}
