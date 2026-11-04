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

if (import.meta.main) {
  const [file, start, end] = process.argv.slice(2);
  if (!file || !start || !end)
    throw new Error(
      "Usage: bun tools/ci/read-trace.ts <trace.jsonl> <start UTC> <end UTC>",
    );
  for (const line of traceWindow(await Bun.file(file).text(), start, end))
    console.log(line);
}
