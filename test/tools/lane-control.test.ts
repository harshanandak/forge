import { expect, setDefaultTimeout, test } from "bun:test";
import {
  boundDispatch,
  openBoundRunner,
  readLaneControl,
} from "../../tools/lane-control.ts";
import type { BoundCommand } from "../../src/blocks/work/bound-lane.ts";
import { ForgeFailure } from "../../src/contract/failure.ts";
setDefaultTimeout(5000);
const head = "a".repeat(40);

function fixture() {
  let now = 0,
    stopped = "",
    unknown = false,
    failed = false,
    active = 0,
    peak = 0;
  const calls: { op: string; input: object }[] = [];
  const timers: (() => Promise<void>)[] = [];
  const command: BoundCommand = async (op, input) => {
    calls.push({ op, input });
    if (op === "lane.control") {
      if (unknown) throw new Error("offline");
      return {
        incarnation: "one",
        epoch: 1,
        stopped: stopped === "all" || ("id" in input && stopped === input.id),
      };
    }
    if (op === "issue.renew") {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      if (failed) throw new Error("renewal failed");
      return {
        id: "forge-1394",
        generation: 7,
        expiresAt: new Date(now + 9000).toISOString(),
      };
    }
    if (op === "lane.show") return { worktree: "E:/fixture" };
    if (op === "lane.next")
      return {
        lane: "forge-1394",
        kind: "harness",
        n: 1,
        raw: JSON.stringify({ generation: 7, head }),
      };
    if (op === "lane.record" && failed)
      throw new ForgeFailure({
        code: "LEASE_EXPIRED",
        message: "Grant expired",
        retry: "never",
      });
    return { recorded: true };
  };
  return {
    command,
    calls,
    timers,
    clock: {
      now: () => now,
      schedule: (run: () => Promise<void>, _ms: number) => {
        timers.push(run);
        return () => {};
      },
    },
    stop: (id = "work-1394") => {
      stopped = id;
    },
    outage: () => {
      unknown = true;
    },
    fail: () => {
      failed = true;
    },
    advance: () => {
      now += 3000;
    },
    peak: () => peak,
  };
}

for (const [name, stopped, unknown, eligible] of [
  ["Running control", "", false, true],
  ["Single stop", "work-1394", false, false],
  ["Global stop", "all", false, false],
  ["Other lane stopped", "work-2", false, true],
  ["Control unknown", "", true, false],
] as const)
  test(name, async () => {
    const f = fixture();
    if (stopped) f.stop(stopped);
    if (unknown) f.outage();
    const lane = boundDispatch(f.command, "work-1394", 7, f.clock);
    let spawns = 0;
    try {
      await lane.beforeSpawn();
      spawns++;
    } catch {
      /* Refusal must leave the process untouched. */
    }
    expect(spawns).toBe(Number(eligible));
    expect(f.calls.filter((c) => c.op === "lane.control")).toEqual([
      { op: "lane.control", input: { id: "work-1394" } },
    ]);
    await lane.close();
  });

test("Stop during running action: renewal never polls control or cancels work", async () => {
  const f = fixture(),
    lane = boundDispatch(f.command, "work-1394", 7, f.clock);
  await lane.beforeSpawn();
  f.stop();
  f.advance();
  await f.timers.shift()!();
  expect(f.calls.filter((c) => c.op === "lane.control")).toHaveLength(1);
  const running = Promise.withResolvers<string>();
  running.resolve("action finished");
  await expect(lane.beforeSpawn()).rejects.toThrow();
  expect(await running.promise).toBe("action finished");
  expect(f.calls.filter((c) => c.op === "lane.control")).toHaveLength(2);
  await lane.close();
});

test("Renewal failure: serialized renewal blocks every later dispatch", async () => {
  const f = fixture(),
    lane = boundDispatch(f.command, "work-1394", 7, f.clock);
  await lane.beforeSpawn();
  f.fail();
  f.advance();
  await Promise.all([f.timers.shift()!(), lane.beforeSpawn().catch(() => {})]);
  await expect(lane.beforeSpawn()).rejects.toThrow();
  expect(f.peak()).toBe(1);
  expect(f.calls.filter((c) => c.op === "lane.control")).toHaveLength(1);
  await lane.close();
});

for (const result of [
  null,
  {},
  { stopped: false },
  { incarnation: "x", epoch: -1, stopped: false },
])
  test(`Control unknown rejects malformed ${JSON.stringify(result)}`, async () => {
    expect(
      await readLaneControl(() => Promise.resolve(result), "work-1394"),
    ).toBe("unknown");
  });

for (const losesGrant of [false, true])
  test(`attached action records its normal result after renewal failure: lost=${losesGrant}`, async () => {
    const f = fixture();
    let closed = false;
    const runner = (await openBoundRunner(
      "E:/fixture",
      "forge-1394",
      head,
      () =>
        Promise.resolve({
          command: f.command,
          readHead: () => Promise.resolve(head),
          close: () => {
            closed = true;
            return Promise.resolve();
          },
        }),
      f.clock,
    ))!;
    await runner.beforeSpawn();
    f.stop();
    if (losesGrant) {
      f.fail();
      f.advance();
      await f.timers.shift()!();
    }
    const outcome = runner.finish(true, true);
    if (losesGrant)
      await expect(outcome).rejects.toMatchObject({
        error: { code: "LEASE_EXPIRED" },
      });
    else await outcome;
    expect(closed).toBe(true);
    expect(f.calls.filter((c) => c.op === "lane.record")).toEqual([
      {
        op: "lane.record",
        input: {
          id: "forge-1394",
          action: 1,
          result: JSON.stringify({ head, done: true }),
        },
      },
    ]);
    expect(f.calls.filter((c) => c.op === "lane.control")).toHaveLength(1);
    await expect(runner.beforeSpawn()).rejects.toThrow();
  });

test("renewal remains serialized when timer and dispatch arrive together", async () => {
  const f = fixture(),
    lane = boundDispatch(f.command, "work-1394", 7, f.clock);
  await lane.beforeSpawn();
  await Promise.all([f.timers.shift()!(), lane.beforeSpawn()]);
  expect(f.peak()).toBe(1);
  expect(f.calls.filter((c) => c.op === "issue.renew")).toHaveLength(2);
  expect(f.calls.filter((c) => c.op === "lane.control")).toHaveLength(2);
  await lane.close();
});

test("changed action number during completion rebind refuses without a record", async () => {
  const f = fixture();
  let reservations = 0;
  const command: BoundCommand = (op, input, ...rest) =>
    op === "lane.next"
      ? Promise.resolve({
          lane: "forge-1394",
          kind: "harness",
          n: ++reservations,
          raw: JSON.stringify({ generation: 7, head }),
        })
      : f.command(op, input, ...rest);
  const runner = (await openBoundRunner(
    "E:/fixture",
    "forge-1394",
    head,
    () =>
      Promise.resolve({
        command,
        readHead: () => Promise.resolve("b".repeat(40)),
        close: () => Promise.resolve(),
      }),
    f.clock,
  ))!;
  await expect(runner.finish(true, true)).rejects.toThrow(
    "pending dispatch action changed",
  );
  expect(f.calls.filter((c) => c.op === "lane.record")).toHaveLength(0);
});
