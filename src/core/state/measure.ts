// Temporary diagnostic spans. The CLI enables them only for the measurement fixture.
interface Phase {
  ms: number;
  selfMs: number;
  count: number;
}
interface Frame {
  name: string;
  started: number;
  children: number;
}
let enabled = false;
let handlerEntryMs: number | undefined;
const phases: Record<string, Phase> = {};
const counts: Record<string, number> = {};
const stack: Frame[] = [];
function add(name: string, ms: number, selfMs = ms): void {
  const phase = (phases[name] ??= { ms: 0, selfMs: 0, count: 0 });
  phase.ms += ms;
  phase.selfMs += selfMs;
  phase.count++;
}
export function enableMeasurement(): void {
  enabled = true;
  add("process.start_to_cli_entry", performance.now());
  measure("start", "cli.dispatch_and_cleanup");
}
export function measure(action: "start" | "end" | "count", name: string): void {
  if (!enabled) return;
  if (action === "count") {
    counts[name] = (counts[name] ?? 0) + 1;
    return;
  }
  const now = performance.now();
  if (action === "start") {
    if (name === "handler" && handlerEntryMs === undefined)
      handlerEntryMs = now;
    stack.push({ name, started: now, children: 0 });
    return;
  }
  const index = stack.findLastIndex((frame) => frame.name === name);
  if (index < 0) return;
  // Exceptional exits close unfinished child spans at the same timestamp.
  while (stack.length > index) {
    const frame = stack.pop()!;
    const ms = now - frame.started;
    add(frame.name, ms, ms - frame.children);
    const parent = stack.at(-1);
    if (parent) parent.children += ms;
  }
}
export function measured<T>(name: string, body: () => T): T {
  measure("start", name);
  try {
    return body();
  } finally {
    measure("end", name);
  }
}
export function measurement(): object {
  measure("end", "cli.dispatch_and_cleanup");
  return {
    kind: "memory.move.phases",
    notesMoved: counts.notes_moved ?? 0,
    totalMs: performance.now(),
    processStartToHandlerMs: handlerEntryMs ?? null,
    // Sum selfMs, not inclusive ms: child spans are already included in their parents.
    accountedMs: Object.values(phases).reduce(
      (sum, phase) => sum + phase.selfMs,
      0,
    ),
    phases,
    counts,
  };
}
