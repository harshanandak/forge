#!/usr/bin/env node
import { version } from "../src/version.ts";
import { emptyCatalog } from "../src/surface/catalog.ts";
import { runCommand } from "../src/surface/command.ts";

process.exitCode = await runCommand(process.argv.slice(2), {
  catalog: emptyCatalog,
  version,
});
