#!/usr/bin/env node
import { version } from "../src/version.ts";

// Stub entry point; the generated CLI surface replaces it.
const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-v")) {
  console.log(version);
} else {
  console.error("forge: no commands are available yet. Run `forge --version`.");
  process.exitCode = 2;
}
