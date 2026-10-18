// The §4 example handler compiles against the author types, and a handler that returns a Promise
// does not. `bun check` type-checks this file; the test also runs the handlers.
import { expect, test } from "bun:test";
import {
  ForgeFailure,
  type Operations,
  type StateClient,
  type StateRecord,
} from "../../src/contract/author.ts";

interface BumpInput {
  readonly current: string;
  readonly part: "major" | "minor" | "patch";
}
interface BumpOutput {
  readonly next: string;
}
interface MarkInput {
  readonly version: string;
  readonly expectRevision: number;
}
interface MarkOutput {
  readonly version: string;
  readonly revision: number;
}

const parse = (v: string) => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) throw new Error(`not a semantic version: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])] as const;
};

const operations = {
  "semver.bump"({ input }: { input: BumpInput }): BumpOutput {
    const [a, b, c] = parse(input.current);
    const next =
      input.part === "major"
        ? `${a + 1}.0.0`
        : input.part === "minor"
          ? `${a}.${b + 1}.0`
          : `${a}.${b}.${c + 1}`;
    return { next };
  },
  "semver.mark"({
    input,
    services,
  }: {
    input: MarkInput;
    services: { state: StateClient };
  }): MarkOutput {
    const rec = services.state.put(
      "released",
      { version: input.version },
      { expectRevision: input.expectRevision },
    );
    return { version: input.version, revision: rec.revision };
  },
} satisfies Operations<{
  "semver.bump": [BumpInput, BumpOutput];
  "semver.mark": [MarkInput, MarkOutput];
}>;

const asyncOperations: Operations<{
  "slow.run": [BumpInput, Promise<BumpOutput>];
}> = {
  // @ts-expect-error a handler that returns a Promise is refused (trusted-action-sync/v1)
  "slow.run": () => Promise.resolve({ next: "1.0.0" }),
};

function memoryState(): StateClient {
  const records = new Map<string, StateRecord>();
  return {
    get: (key) => records.get(key),
    put(key, value, { expectRevision }) {
      const current = records.get(key)?.revision ?? 0;
      if (current !== expectRevision) {
        throw new ForgeFailure({
          code: "REVISION_CONFLICT",
          message: `expected revision ${expectRevision}, found ${current}`,
          currentRevision: current,
          retry: "reconcile_first",
        });
      }
      const record: StateRecord = {
        namespace: "io.github.alice/semver",
        key,
        revision: current + 1,
        value,
        updatedAt: "2026-10-18T10:00:00Z",
        updatedBy: { kind: "agent", id: "a" },
      };
      records.set(key, record);
      return record;
    },
    list: () => [...records.values()],
    events: () => [],
  };
}

test("the §4 handlers run against the author types and a state client", () => {
  expect(
    operations["semver.bump"]({ input: { current: "1.4.2", part: "minor" } }),
  ).toEqual({ next: "1.5.0" });
  const state = memoryState();
  const mark = (expectRevision: number) =>
    operations["semver.mark"]({
      input: { version: "1.5.0", expectRevision },
      services: { state },
    });
  expect(mark(0)).toEqual({ version: "1.5.0", revision: 1 });
  expect(() => mark(0)).toThrow(ForgeFailure);
  expect(asyncOperations).toBeDefined();
}, 30_000);
