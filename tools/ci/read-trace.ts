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
