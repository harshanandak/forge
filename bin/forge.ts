#!/usr/bin/env node
import { runLocalCommand } from "../src/assembly/command.ts";

process.exitCode = await runLocalCommand(process.argv.slice(2));
