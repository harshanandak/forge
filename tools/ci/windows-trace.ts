import { execFile, spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [mode, trace = `${process.env.RUNNER_TEMP}/windows-trace.jsonl`] =
  process.argv.slice(2);
const names = ["bun", "node", "powershell", "pwsh", "git", "cmd", "conhost"];
const system = `${process.env.SystemRoot ?? "C:/Windows"}/System32/`;
const read = (suffix: string) =>
  Bun.file(trace + suffix)
    .text()
    .catch(() => null);
const csv = (line: string) => line.slice(1, -1).split('","');
const processPattern = new RegExp(
  `^"(${names.join("|")})\\.exe","(\\d+)"`,
  "gim",
);
try {
  if (mode === "start") {
    // No console or inherited pipe ties the sampler to the Actions step shell.
    Bun.spawn([process.execPath, import.meta.path, "sample", trace], {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore"],
    }).unref();
  } else if (mode === "stop") {
    let identity = await read(".pid");
    for (let n = 0; n < 30 && !identity; n++) {
      await Bun.sleep(100);
      identity = await read(".pid");
    }
    if (!identity) throw new Error("sampler never started");
    await Bun.write(trace + ".stop", identity);
    for (let n = 0; n < 30 && (await read(".done")) !== identity; n++)
      await Bun.sleep(100);
    if ((await read(".done")) !== identity)
      throw new Error("Sampler did not stop");
    console.log(`Runner trace: ${await read(".summary")}`);
  } else if (mode === "sample") {
    const identity = JSON.stringify({
      pid: process.pid,
      started: performance.timeOrigin,
    });
    await Bun.write(trace + ".pid", identity);
    const keys =
      "cpuPercent availableMemoryMB diskTimePercent diskQueueLength".split(" ");
    let values: (number | null)[] = [],
      updated = -Infinity;
    const counter = spawn(
      system + "typeperf.exe",
      [
        "\\Processor(_Total)\\% Processor Time",
        "\\Memory\\Available MBytes",
        "\\PhysicalDisk(_Total)\\% Disk Time",
        "\\PhysicalDisk(_Total)\\Avg. Disk Queue Length",
        "-si",
        "1",
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    const clear = () => values.fill(null);
    counter.on("error", clear).on("exit", clear);
    createInterface({ input: counter.stdout }).on("line", (line) => {
      if (!/^"\d/.test(line)) return; // Skip typeperf's header and diagnostics.
      const fields = csv(line).slice(1);
      if (fields.length !== 4) return;
      values = fields.map((v) =>
        v.trim() && Number.isFinite(+v) && +v >= 0 ? +v : null,
      );
      updated = performance.now();
    });
    const summary = {
      samples: 0,
      maxGapMs: 0,
      at: "",
      maxProcessCounts: Object.fromEntries(
        names.map((n) => [n, null as number | null]),
      ),
      sampleDurationMs: { mean: 0, max: 0 },
      samplerCpuPercent: 0,
    };
    let previous: number | null = null,
      previousCpu = process.cpuUsage(),
      cpuTotal = 0;
    let processes: { name: string; pid: number }[] | null = null;
    let processesAt: number | null = null,
      processScanMs: number | null = null;
    let scanning = false;
    const began = performance.now();
    try {
      // Only this process can accept its PID AND start-time token; never signal a reused PID.
      while ((await read(".stop")) !== identity) {
        const at = performance.now(),
          timestamp = new Date().toISOString();
        const gapMs = previous === null ? null : at - previous;
        if ((summary.samples + 1) % 5 === 0 && !scanning) {
          scanning = true;
          const started = performance.now();
          execFile(
            system + "tasklist.exe",
            ["/fo", "csv", "/nh"],
            { encoding: "utf8", windowsHide: true, timeout: 1000 },
            (error, stdout) => {
              processes = error
                ? null
                : [...stdout.matchAll(processPattern)].map((m) => ({
                    name: m[1]!.toLowerCase(),
                    pid: Number(m[2]),
                  }));
              processesAt = error ? null : performance.now();
              processScanMs = performance.now() - started;
              scanning = false;
            },
          );
        }
        const processCounts = Object.fromEntries(
          names.map((n) => [
            n,
            processes?.filter((p) => p.name === n).length ?? null,
          ]),
        );
        const usage = process.cpuUsage(previousCpu);
        const samplerCpuMs = (usage.user + usage.system) / 1000;
        previousCpu = process.cpuUsage();
        cpuTotal += samplerCpuMs;
        const sampleDurationMs = performance.now() - at;
        const metrics = Object.fromEntries(
          keys.map((k, i) => [
            k,
            performance.now() - updated < 2500 ? (values[i] ?? null) : null,
          ]),
        );
        const row = {
          timestamp,
          gapMs,
          processes,
          processesAgeMs: processesAt === null ? null : at - processesAt,
          processScanMs,
          processCounts,
          ...metrics,
          samplerCpuMs,
          sampleDurationMs,
        };
        appendFileSync(trace, JSON.stringify(row) + "\n");
        processScanMs = null;
        summary.samples++;
        if (summary.samples === 1 || (gapMs ?? 0) > summary.maxGapMs) {
          summary.maxGapMs = gapMs ?? 0;
          summary.at = timestamp;
        }
        for (const n of names)
          if (processCounts[n] != null)
            summary.maxProcessCounts[n] = Math.max(
              summary.maxProcessCounts[n] ?? 0,
              processCounts[n],
            );
        summary.sampleDurationMs.mean +=
          (sampleDurationMs - summary.sampleDurationMs.mean) / summary.samples;
        summary.sampleDurationMs.max = Math.max(
          summary.sampleDurationMs.max,
          sampleDurationMs,
        );
        previous = at;
        await Bun.sleep(Math.max(1, 1000 - (performance.now() - at)));
      }
    } finally {
      counter.kill();
    }
    summary.samplerCpuPercent =
      (100 * cpuTotal) / Math.max(1, performance.now() - began);
    await Bun.write(trace + ".summary", JSON.stringify(summary));
    await Bun.write(trace + ".done", identity);
  }
} catch (error) {
  try {
    const { name, message } =
      error instanceof Error ? error : new Error(String(error));
    appendFileSync(trace + ".error", JSON.stringify({ name, message }) + "\n");
  } catch {
    // A full or unwritable temp directory must stay nonfatal.
  }
  console.log("Runner trace: no trace (sampler unavailable or failed)");
}
