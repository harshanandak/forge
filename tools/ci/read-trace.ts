export function traceWindow(
  jsonl: string,
  start: string,
  end: string,
): string[] {
  const from = Date.parse(start);
  const to = Date.parse(end);
  if (!start.endsWith("Z") || !end.endsWith("Z") || !(from <= to))
    throw new Error(
      "Expected an ordered UTC window with timestamps ending in Z",
    );
  return jsonl.split(/\r?\n/).filter((line) => {
    try {
      const row = JSON.parse(line) as { timestamp?: unknown } | null;
      if (typeof row?.timestamp !== "string") return false;
      const at = Date.parse(row.timestamp);
      return at >= from && at <= to;
    } catch {
      return false; // Stopping the sampler can leave an incomplete final line.
    }
  });
}

export function parseCounters(header: string[], fields: string[]) {
  return Object.fromEntries(
    header.flatMap((key, i) =>
      /\\LogicalDisk\(/i.test(key) ||
      /\\Process\((MsMpEng|TiWorker|SearchIndexer|SearchProtocolHost|csc|node|bun|git|powershell|typeperf)(#\d+)?\)/i.test(
        key,
      )
        ? [
            [
              key,
              fields[i]?.trim() &&
              Number.isFinite(+fields[i]) &&
              +fields[i] >= 0
                ? +fields[i]
                : null,
            ],
          ]
        : [],
    ),
  );
}
export function topIo(lines: string[]): [string, number][] {
  const rows = lines.map(
    (line) =>
      JSON.parse(line) as {
        timestamp: string;
        diskQueueLength?: number;
        performanceCounters?: Record<string, number | null>;
      },
  );
  const worst = rows
    .filter((r) => typeof r.diskQueueLength === "number")
    .sort((a, b) => b.diskQueueLength! - a.diskQueueLength!)[0];
  const totals = new Map<string, number>();
  for (const row of rows.filter(
    (r) =>
      worst &&
      Math.abs(Date.parse(r.timestamp) - Date.parse(worst.timestamp)) <= 2500,
  ))
    for (const [key, value] of Object.entries(row.performanceCounters ?? {})) {
      const name = /\\Process\(([^)]+)\)\\IO Data Bytes\/sec$/i.exec(key)?.[1];
      if (name && value !== null)
        totals.set(name, (totals.get(name) ?? 0) + value);
    }
  return [...totals].sort((a, b) => b[1] - a[1]);
}

/** Relog expands the union of binary-log instances; an absent instance has an empty cell. */
export function mergeCounterLog(jsonl: string, csv: string) {
  const fields = (line: string) => line.trim().slice(1, -1).split('","');
  const [head = "", ...lines] = csv.replace(/^\uFEFF/, "").split(/\r?\n/);
  const header = fields(head);
  const bias = Number(/\((-?\d+)\)$/.exec(header[0] ?? "")?.[1] ?? 0);
  const samples = lines
    .filter((line) => /^"\d/.test(line))
    .map((line) => {
      const [stamp = "", ...values] = fields(line);
      const [month, day, year, hour, minute, second, ms] = stamp
        .split(/\D/)
        .map(Number);
      const at =
        Date.UTC(year!, month! - 1, day, hour, minute, second, ms ?? 0) +
        bias * 60000;
      return { at, counters: parseCounters(header.slice(1), values), values };
    });
  let index = 0,
    collectorCpu = 0;
  for (const sample of samples)
    collectorCpu += Object.entries(sample.counters).reduce(
      (sum, [key, value]) =>
        sum +
        (/\\Process\(typeperf(#\d+)?\)\\% Processor Time$/i.test(key)
          ? (value ?? 0)
          : 0),
      0,
    );
  const rows = jsonl
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const row = JSON.parse(line) as { timestamp: string };
      const at = Date.parse(row.timestamp);
      while (index + 1 < samples.length && samples[index + 1]!.at <= at)
        index++;
      const sample = samples[index];
      const fresh = sample && at >= sample.at && at - sample.at < 2500;
      const metrics = Object.fromEntries(
        Object.entries({
          cpuPercent: "\\Processor(_Total)\\% Processor Time",
          availableMemoryMB: "\\Memory\\Available MBytes",
          diskTimePercent: "\\PhysicalDisk(_Total)\\% Disk Time",
          diskQueueLength: "\\PhysicalDisk(_Total)\\Avg. Disk Queue Length",
        }).map(([key, path]) => {
          const i = header.findIndex((name) => name.endsWith(path)) - 1;
          const value = fresh ? sample.values[i] : undefined;
          return [
            key,
            value?.trim() && Number.isFinite(+value) && +value >= 0
              ? +value
              : null,
          ];
        }),
      );
      return JSON.stringify({
        ...row,
        ...metrics,
        performanceCounters: fresh ? sample.counters : null,
      });
    });
  return {
    jsonl: rows.join("\n") + "\n",
    collectorCpuPercent: samples.length ? collectorCpu / samples.length : null,
    samples: samples.length,
  };
}

if (import.meta.main) {
  const [file, start, end] = process.argv.slice(2);
  if (!file || !start || !end)
    throw new Error(
      "Usage: bun tools/ci/read-trace.ts <trace.jsonl> <start UTC> <end UTC>",
    );
  const lines = traceWindow(await Bun.file(file).text(), start, end);
  for (const line of lines) console.log(line);
  console.log(
    "Top I/O processes during the worst disk-queue window (+/-2.5s; summed bytes/sec samples):",
    JSON.stringify(topIo(lines)),
  );
}
