#!/usr/bin/env node
import { buildIdentity, versionLabel } from "../src/version.ts";

const argv = process.argv.slice(2);
if (
  (argv[0] === "--version" || argv[0] === "-v") &&
  (argv.length === 1 || (argv.length === 2 && argv[1] === "--json"))
) {
  process.stdout.write(
    `${argv[1] === "--json" ? JSON.stringify(buildIdentity) : versionLabel}\n`,
  );
  process.exitCode = 0;
} else {
  const { runLocalCommand } = await import("../src/assembly/command.ts");
  process.exitCode = await runLocalCommand(argv);
}
