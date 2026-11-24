#!/usr/bin/env node
import { runPreTool } from "../dist/hooks/pre-tool.js";

process.exitCode = await runPreTool();
