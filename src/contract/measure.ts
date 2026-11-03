// Temporary diagnostics for the measurement lane; enabled only by the CLI fixture.
interface Interval {
  name: string;
  start: number;
  end?: number;
}
interface Phase {
  ms: number;
  selfMs: number;
  count: number;
}
let enabled = false;
const intervals: Interval[] = [];
const counts: Record<string, number> = {};
const noop = (): void => {};
export function enableMeasurement(entryMs: number): void {
  enabled = true;
  intervals.push({ name: "process.start_to_entry", start: 0, end: entryMs });
}
export function count(name: string, amount = 1): void {
  if (enabled) counts[name] = (counts[name] ?? 0) + amount;
}
export function span(name: string, start?: number): () => void {
  if (!enabled) return noop;
  const interval: Interval = { name, start: start ?? performance.now() };
  intervals.push(interval);
  return () => {
    interval.end ??= performance.now();
  };
}
export function measured<T>(name: string, body: () => T): T {
  const end = span(name);
  try {
    return body();
  } finally {
    end();
  }
}
export function measuredAsync<T>(
  name: string,
  body: () => Promise<T>,
): Promise<T> {
  if (!enabled) return body();
  const end = span(name);
  try {
    return body().finally(end);
  } catch (error) {
    end();
    throw error;
  }
}
export function measurement(endMs: number): object {
  const phases: Record<string, Phase> = {};
  const events: Array<{ at: number; index: number; opening: boolean }> = [];
  for (const [index, interval] of intervals.entries()) {
    const end = interval.end ?? endMs;
    const phase = (phases[interval.name] ??= { ms: 0, selfMs: 0, count: 0 });
    phase.ms += end - interval.start;
    phase.count++;
    events.push(
      { at: interval.start, index, opening: true },
      { at: end, index, opening: false },
    );
  }
  events.sort((a, b) => a.at - b.at);
  const active = new Set<number>();
  let previous = 0;
  // Partition the timeline: the most recently started active span owns each slice.
  // This also avoids double-counting overlapping asynchronous closes and imports.
  for (const event of events) {
    let owner = -1;
    for (const index of active) if (index > owner) owner = index;
    if (owner >= 0)
      phases[intervals[owner]!.name]!.selfMs += event.at - previous;
    if (event.opening) active.add(event.index);
    else active.delete(event.index);
    previous = event.at;
  }
  return {
    kind: "cli.startup.phases",
    totalMs: endMs,
    accountedMs: Object.values(phases).reduce(
      (sum, phase) => sum + phase.selfMs,
      0,
    ),
    accounting:
      "selfMs partitions elapsed time; latest-started span owns overlaps; ms is inclusive",
    phases,
    counts,
  };
}
