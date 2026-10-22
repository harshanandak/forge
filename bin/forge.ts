#!/usr/bin/env node
import { runLocalCommand } from "../src/assembly/command.ts";
import { writeSync } from "node:fs";
import { failure, respond } from "../src/surface/result.ts";

const argv = process.argv.slice(2);
const op = argv.slice(0, 2).every((part) => /^[a-z][a-z0-9-]*$/.test(part))
  ? argv.slice(0, 2).join(".") || "catalog.list"
  : undefined;
let completed = false;
const interrupted = (): void => {
  if (completed) return;
  completed = true;
  process.exitCode = 1;
  writeSync(
    1,
    respond({
      ...failure(
        "CLI_INTERRUPTED",
        `CLI terminated before ${op ?? "CLI invocation"} returned a result`,
      ),
      ...(op === undefined ? {} : { op }),
    }).stdout,
  );
};
process.once("beforeExit", interrupted);
process.once("exit", interrupted);
try {
  process.exitCode = await runLocalCommand(argv);
  completed = true;
} finally {
  process.removeListener("beforeExit", interrupted);
  process.removeListener("exit", interrupted);
}
