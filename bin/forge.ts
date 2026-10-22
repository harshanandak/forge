#!/usr/bin/env node
import { runLocalCommand } from "../src/assembly/command.ts";
import { writeSync } from "node:fs";
import { failure, respond } from "../src/surface/result.ts";
import { commandOperation } from "../src/surface/command.ts";

const argv = process.argv.slice(2);
const op = commandOperation(argv);
const initialBytesWritten = process.stdout.bytesWritten;
let completed = false;
const interrupted = (): void => {
  if (completed) return;
  completed = true;
  process.exitCode = 1;
  // Cleanup may be abandoned after the operation has already returned its response.
  if (process.stdout.bytesWritten !== initialBytesWritten) return;
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
process.exitCode = await runLocalCommand(argv);
completed = true;
process.removeListener("beforeExit", interrupted);
process.removeListener("exit", interrupted);
