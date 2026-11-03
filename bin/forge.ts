#!/usr/bin/env node
const entryMs = performance.now();
const entryEpochMs = performance.timeOrigin + entryMs;
const entryHrtimeNs = process.hrtime.bigint();
const processStartHrtimeNs = entryHrtimeNs - BigInt(Math.round(entryMs * 1e6));
const timingFile = process.env.FORGE_CLI_TIMING_FILE;
if (timingFile) {
  const { appendFileSync } = await import("node:fs");
  const { registerHooks } = await import("node:module");
  const { enableMeasurement, span, count, measured, measurement } =
    await import("../src/contract/measure.ts");
  enableMeasurement(entryMs);
  span("cli.lifetime", entryMs);
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      return measured("modules.resolve", () => nextResolve(specifier, context));
    },
    load(url, context, nextLoad) {
      return measured("modules.load", () => {
        const loaded = nextLoad(url, context);
        count("modules.loaded");
        if (url.startsWith("file:")) count("modules.file_loads");
        return loaded;
      });
    },
  });
  process.once("exit", () => {
    hooks.deregister();
    const endMs = performance.now();
    appendFileSync(
      timingFile,
      `${JSON.stringify({
        ...measurement(endMs),
        entryMs,
        entryEpochMs,
        entryHrtimeNs: entryHrtimeNs.toString(),
        processStartHrtimeNs: processStartHrtimeNs.toString(),
        entryHrtimeRelativeToStartMs:
          Number(entryHrtimeNs - processStartHrtimeNs) / 1e6,
        hrtimeElapsedMs: Number(process.hrtime.bigint() - entryHrtimeNs) / 1e6,
        node: process.version,
        platform: process.platform,
      })}\n`,
    );
  });
  const endImport = span("modules.graph");
  const { runLocalCommand } = await import("../src/assembly/command.ts");
  endImport();
  process.exitCode = await runLocalCommand(process.argv.slice(2));
} else {
  const { runLocalCommand } = await import("../src/assembly/command.ts");
  process.exitCode = await runLocalCommand(process.argv.slice(2));
}
