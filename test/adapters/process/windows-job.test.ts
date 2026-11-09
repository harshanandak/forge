import { expect, test } from "bun:test";
import {
  processIds,
  type JobIdQueryApi,
} from "../../../src/adapters/process/windows-job.ts";

const ERROR_MORE_DATA = 234;
const HEADER_BYTES = 8;
const POINTER_BYTES = process.arch === "ia32" ? 4 : 8;

interface FakeOptions {
  /** The process IDs the fake job can list. */
  readonly listable: readonly number[];
  /** What the job reports as assigned; defaults to the listable count. */
  readonly assigned?: number;
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
      buffer.writeUInt32LE(options.assigned ?? options.listable.length, 0);
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
  const listable = Array.from({ length: 40 }, (_, index) => 1000 + index);
  const api = fakeApi({ listable, overflow: "truncate" });
  expect(processIds(api, 1n)).toEqual(listable);
  expect(api.capacities).toEqual([16, 32, 64]);
}, 5_000);

test("ERROR_MORE_DATA grows the buffer until the whole list fits", () => {
  const listable = Array.from({ length: 40 }, (_, index) => 1000 + index);
  const api = fakeApi({ listable, overflow: "more-data" });
  expect(processIds(api, 1n)).toEqual(listable);
  expect(api.capacities).toEqual([16, 40]);
}, 5_000);

test("a list that fills the 4096 ceiling throws a message naming the counts", () => {
  const listable = Array.from({ length: 5000 }, (_, index) => 1000 + index);
  const api = fakeApi({ listable, overflow: "truncate" });
  expect(() => processIds(api, 1n)).toThrow(
    /exceeds 4096.*succeeded=1.*assigned=5000.*listed=4096.*capacity=4096/s,
  );
}, 5_000);
