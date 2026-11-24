#!/usr/bin/env node
import { runSessionStart } from "../dist/hooks/session-start.js";

process.exitCode = await runSessionStart();
