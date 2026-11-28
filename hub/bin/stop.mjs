#!/usr/bin/env node
import { runStop } from "../dist/hooks/stop.js";

process.exitCode = await runStop();
