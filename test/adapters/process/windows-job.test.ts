import { expect, test } from "bun:test";
import {
  processIds,
  waitForExit,
  type ExitApi,
  type JobIdQueryApi,
} from "../../../src/adapters/process/windows-job.ts";

const ERROR_MORE_DATA = 234;
const HEADER_BYTES = 8;
const POINTER_BYTES = process.arch === "ia32" ? 4 : 8;

interface FakeOptions {
  /** The process IDs the fake job can list. */
  readonly listable: readonly number[];
  /** What the job reports as assigned; defaults to the listable count. */
  readonly assigned?: number | ((capacity: number) => number);
  /** "more-data" fails with ERROR_MORE_DATA when the buffer is too small, like Windows. */
  readonly overflow: "more-data" | "truncate";
}

function fakeApi(options: FakeOptions): JobIdQueryApi & {
  readonly capacities: readonly number[];
} {
  const capacities: number[] = [];
  return {
    capacities,
    getLastError: () => ERROR_MORE_DATA,
    queryInformationJobObject: (_job, _kind, buffer) => {
      const capacity = (buffer.length - HEADER_BYTES) / POINTER_BYTES;
      capacities.push(capacity);
      const listed = Math.min(capacity, options.listable.length);
      const assigned =
        typeof options.assigned === "function"
          ? options.assigned(capacity)
          : (options.assigned ?? options.listable.length);
      buffer.writeUInt32LE(assigned, 0);
      buffer.writeUInt32LE(listed, 4);
      for (let index = 0; index < listed; index += 1) {
        const offset = HEADER_BYTES + index * POINTER_BYTES;
        if (POINTER_BYTES === 4)
          buffer.writeUInt32LE(options.listable[index]!, offset);
        else buffer.writeBigUInt64LE(BigInt(options.listable[index]!), offset);
      }
      const truncated = options.listable.length > capacity;
      return truncated && options.overflow === "more-data" ? 0 : 1;
    },
  };
}

test("an exiting process counted as assigned but not listable does not grow the buffer", () => {
  // One listable process, two assigned, 16 slots: the call had room and listed one.
  const api = fakeApi({ listable: [101], assigned: 2, overflow: "more-data" });
  expect(processIds(api, 1n)).toEqual([101]);
  expect(api.capacities).toEqual([16]);
}, 5_000);

test("a full buffer on success grows until the whole list fits", () => {
  const listable = Array.from({ length: 30 }, (_, index) => 1000 + index);
  const api = fakeApi({ listable, overflow: "truncate" });
  expect(processIds(api, 1n)).toEqual(listable);
  expect(api.capacities).toEqual([16, 32]);
}, 5_000);

test("ERROR_MORE_DATA grows the buffer until the whole list fits", () => {
  const listable = Array.from({ length: 30 }, (_, index) => 1000 + index);
  const api = fakeApi({ listable, overflow: "more-data" });
  expect(processIds(api, 1n)).toEqual(listable);
  expect(api.capacities).toEqual([16, 32]);
}, 5_000);

test("a full buffer that holds every assigned process is complete and is not queried again", () => {
  const listable = Array.from({ length: 16 }, (_, index) => 1000 + index);
  const api = fakeApi({ listable, overflow: "more-data" });
  expect(processIds(api, 1n)).toEqual(listable);
  expect(api.capacities).toEqual([16]);
}, 5_000);

test("exactly 4096 listable processes return all 4096 at the ceiling", () => {
  const listable = Array.from({ length: 4096 }, (_, index) => 1000 + index);
  const api = fakeApi({ listable, overflow: "more-data" });
  expect(processIds(api, 1n)).toEqual(listable);
  expect(api.capacities).toEqual([16, 4096]);
}, 5_000);

test("a job assigned more than 4096 processes throws a message naming the counts", () => {
  const listable = Array.from({ length: 5000 }, (_, index) => 1000 + index);
  const api = fakeApi({ listable, overflow: "truncate" });
  expect(() => processIds(api, 1n)).toThrow(
    /exceeds 4096.*succeeded=1.*assigned=5000.*listed=16.*capacity=16/s,
  );
}, 5_000);

test("a buffer that is still full and short at the 4096 ceiling throws a message naming the counts", () => {
  const listable = Array.from({ length: 5000 }, (_, index) => 1000 + index);
  // A process starts while the snapshot grows: 4096 assigned at first, 4097 by the last query.
  const api = fakeApi({
    listable,
    assigned: (capacity) => (capacity < 4096 ? 4096 : 4097),
    overflow: "truncate",
  });
  expect(() => processIds(api, 1n)).toThrow(
    /exceeds 4096.*succeeded=1.*assigned=4097.*listed=4096.*capacity=4096/s,
  );
}, 5_000);

const ERROR_INVALID_PARAMETER = 87;

interface FakeProcess {
  /** How OpenProcess answers: a handle, or "gone" (ERROR_INVALID_PARAMETER). */
  readonly open: "ok" | "gone";
  /** Successive WaitForSingleObject results (0 signaled, 258 timeout); the last one repeats. */
  readonly waits?: readonly number[];
  readonly started?: bigint;
}

function fakeExitApi(processes: Readonly<Record<number, FakeProcess>>) {
  let lastError = 0;
  const closed: number[] = [];
  const waited: number[] = [];
  const api: ExitApi = {
    getLastError: () => lastError,
    openProcess: (_access, _inherit, pid) => {
      const spec = processes[pid]!;
      if (spec.open === "ok") return BigInt(pid + 1000);
      lastError = ERROR_INVALID_PARAMETER;
      return 0n;
    },
    getProcessTimes: (handle, created) => {
      created.writeBigUInt64LE(processes[Number(handle) - 1000]!.started ?? 1n);
      return 1;
    },
    waitForSingleObject: (handle) => {
      const pid = Number(handle) - 1000;
      waited.push(pid);
      const waits = processes[pid]!.waits ?? [0];
      const count = waited.filter((item) => item === pid).length;
      return waits[Math.min(count, waits.length) - 1]!;
    },
    closeHandle: (handle) => {
      closed.push(Number(handle) - 1000);
      return 1;
    },
  };
  return { api, closed, waited };
}

test("waitForExit reports each killed process whose object is signaled", async () => {
  const fake = fakeExitApi({ 11: { open: "ok" }, 12: { open: "ok" } });
  const seen: string[] = [];
  const states = await waitForExit(
    [{ pid: 11 }, { pid: 12 }],
    {
      deadlineMs: 1_000,
      onStates: (all) =>
        seen.push(all.map((s) => `${s.pid}:${s.state}`).join()),
    },
    fake.api,
  );
  expect(states).toEqual([
    { pid: 11, state: "signaled" },
    { pid: 12, state: "signaled" },
  ]);
  expect(seen).toEqual(["11:signaled,12:signaled"]);
  expect(fake.closed.sort()).toEqual([11, 12]);
}, 5_000);

test("waitForExit counts a process that no longer exists as gone without waiting on it", async () => {
  const fake = fakeExitApi({ 11: { open: "gone" } });
  expect(
    await waitForExit([{ pid: 11 }], { deadlineMs: 1_000 }, fake.api),
  ).toEqual([{ pid: 11, state: "gone" }]);
  expect(fake.waited).toEqual([]);
}, 5_000);

test("waitForExit waits on a mixed set and never on a reused PID", async () => {
  const fake = fakeExitApi({
    11: { open: "ok", waits: [258, 258, 0] },
    12: { open: "gone" },
    13: { open: "ok", started: 9n },
    14: { open: "ok" },
  });
  const states = await waitForExit(
    [{ pid: 11 }, { pid: 12 }, { pid: 13, started: "5" }, { pid: 14 }],
    { deadlineMs: 1_000, pollIntervalMs: 1 },
    fake.api,
  );
  expect(states).toEqual([
    { pid: 11, state: "signaled" },
    { pid: 12, state: "gone" },
    { pid: 13, state: "gone" },
    { pid: 14, state: "signaled" },
  ]);
  expect(fake.waited).not.toContain(13);
  expect(fake.waited.filter((pid) => pid === 11)).toHaveLength(3);
  expect(fake.closed.sort()).toEqual([11, 13, 14]);
}, 5_000);

test("waitForExit fails at one shared deadline and names the processes still running", async () => {
  const fake = fakeExitApi({
    11: { open: "ok", waits: [258] },
    12: { open: "ok", waits: [258] },
    13: { open: "ok" },
  });
  let final: readonly string[] = [];
  const started = performance.now();
  await expect(
    waitForExit(
      [{ pid: 11 }, { pid: 12 }, { pid: 13 }],
      {
        deadlineMs: 40,
        pollIntervalMs: 2,
        onStates: (all) => {
          final = all.map((s) => `${s.pid}:${s.state}`);
        },
      },
      fake.api,
    ),
  ).rejects.toThrow(/still running 40 ms.*: 11, 12\./);
  expect(performance.now() - started).toBeLessThan(500);
  expect(final).toEqual(["11:running", "12:running", "13:signaled"]);
  expect(fake.closed.sort()).toEqual([11, 12, 13]);
}, 5_000);
