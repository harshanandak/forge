#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { enableMeasurement, measurement } from "../src/core/state/measure.ts";
import { runLocalCommand } from "../src/assembly/command.ts";

const timingFile = process.env.FORGE_MOVE_TIMING_FILE;
if (timingFile) enableMeasurement();
try {
  process.exitCode = await runLocalCommand(process.argv.slice(2));
} finally {
  if (timingFile)
    appendFileSync(timingFile, `${JSON.stringify(measurement())}\n`);
}
