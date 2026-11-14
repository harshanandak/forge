import { expect, test } from "bun:test";
import { boundDispatch, readLaneControl } from "../../tools/lane-control.ts";
import type { BoundCommand } from "../../src/blocks/work/bound-lane.ts";

function fixture() {
  let now = 0, stopped = false, unknown = false, failed = false, active = 0, peak = 0;
  const calls: { op: string; input: object }[] = [];
  const timers: (() => Promise<void>)[] = [];
  const command: BoundCommand = async (op, input) => {
    calls.push({ op, input });
    if (op === "lane.control") {
      if (unknown) throw new Error("offline");
      return { incarnation: "one", epoch: 1, stopped: stopped && "id" in input && input.id === "work-1394" };
    }
    if (op === "issue.renew") {
      active++; peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      if (failed) throw new Error("renewal failed");
      return { id: "forge-1394", generation: 7, expiresAt: new Date(now + 9000).toISOString() };
    }
    return {};
  };
  return {
    command, calls, timers,
    clock: { now: () => now, schedule: (run: () => Promise<void>, _ms: number) => { timers.push(run); return () => {}; } },
    stop: () => { stopped = true; }, outage: () => { unknown = true; },
    fail: () => { failed = true; }, advance: () => { now += 3000; },
    peak: () => peak,
  };
}

for (const [name, stopped, unknown, eligible] of [
  ["Running control", false, false, true],
  ["Single stop", true, false, false],
  ["Global stop", true, false, false],
  ["Other lane stopped", false, false, true],
  ["Control unknown", false, true, false],
] as const) test(name, async () => {
  const f = fixture();
  if (stopped) f.stop();
  if (unknown) f.outage();
  const lane = boundDispatch(f.command, "work-1394", 7, f.clock);
  let spawns = 0;
  try { await lane.beforeSpawn(); spawns++; } catch { /* Refusal must leave the process untouched. */ }
  expect(spawns).toBe(Number(eligible));
  expect(f.calls.filter(c => c.op === "lane.control")).toEqual([{ op: "lane.control", input: { id: "work-1394" } }]);
  await lane.close();
});

test("Stop during running action: renewal never polls control or cancels work", async () => {
  const f = fixture(), lane = boundDispatch(f.command, "work-1394", 7, f.clock);
  await lane.beforeSpawn();
  f.stop(); f.advance(); await f.timers.shift()!();
  expect(f.calls.filter(c => c.op === "lane.control")).toHaveLength(1);
  const result = "action finished";
  await expect(lane.beforeSpawn()).rejects.toThrow();
  expect(result).toBe("action finished");
  expect(f.calls.filter(c => c.op === "lane.control")).toHaveLength(2);
  await lane.close();
});

for (const name of ["Capacity retry and resume", "Detached start"])
  test(`${name}: a previous answer never grants a later spawn`, async () => {
    const f = fixture(), parent = boundDispatch(f.command, "work-1394", 7, f.clock);
    await parent.beforeSpawn();
    f.stop();
    const child = name === "Detached start" ? boundDispatch(f.command, "work-1394", 7, f.clock) : parent;
    await expect(child.beforeSpawn()).rejects.toThrow();
    expect(f.calls.filter(c => c.op === "lane.control")).toHaveLength(2);
    await child.close(); await parent.close();
  });

test("Renewal failure: serialized renewal blocks every later dispatch", async () => {
  const f = fixture(), lane = boundDispatch(f.command, "work-1394", 7, f.clock);
  await lane.beforeSpawn();
  f.fail(); f.advance();
  await Promise.all([f.timers.shift()!(), lane.beforeSpawn().catch(() => {})]);
  await expect(lane.beforeSpawn()).rejects.toThrow();
  expect(f.peak()).toBe(1);
  expect(f.calls.filter(c => c.op === "lane.control")).toHaveLength(1);
  await lane.close();
});

for (const result of [null, {}, { stopped: false }, { incarnation: "x", epoch: -1, stopped: false }])
  test(`Control unknown rejects malformed ${JSON.stringify(result)}`, async () => {
    expect(await readLaneControl(async () => result, "work-1394")).toBe("unknown");
  });
