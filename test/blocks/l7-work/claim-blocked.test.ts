import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  spyOn,
  test,
} from "bun:test";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import { createStateClient } from "../../../src/assembly/state-client.ts";
import { ForgeFailure } from "../../../src/contract/failure.ts";
import { StateOwner } from "../../../src/core/state/index.ts";
import { refuse } from "../../../src/core/trust/index.ts";
import type { LeaseHolder, StateEvent } from "../../../src/generated/types.ts";
import type { HandlerCall } from "../../../src/contract/author.ts";

type Handler = (call: HandlerCall<Record<string, unknown>>) => unknown;
type Blocker = { id: string; holder?: LeaseHolder; holderUnverified?: boolean };
type Grant = {
  id: string;
  generation: number;
  warnings?: { code: string; blockers: Blocker[] }[];
};
const namespace = "forge/work",
  reason = "spike while B lands";
const holder: LeaseHolder = {
  actor: { kind: "agent", id: "A" },
  session: { id: "A" },
};
const globals = globalThis as Record<string, unknown>,
  previousFail = globals.fail;
let operations: Record<string, Handler>;
beforeAll(() => {
  globals.fail = refuse;
  operations = require(
    resolve(import.meta.dirname, "../../../src/blocks/work/entry.cts"),
  ) as typeof operations;
});
afterAll(() => {
  if (previousFail === undefined) delete globals.fail;
  else globals.fail = previousFail;
});

let p: Awaited<ReturnType<typeof project>>;
beforeEach(async () => {
  p = await project();
});
afterEach(async () => {
  await p.close();
});
async function project() {
  const opened = await createSqliteStore(tmpdir()).open({
    path: ":memory:",
    readOnly: false,
  });
  if (!opened.ok) throw new Error(opened.unavailable.reason);
  const real = opened.handle.value;
  let rejectReason = false,
    request = 0;
  const now = Date.parse("2026-11-10T12:00:00Z");
  const run = real.run.bind(real);
  const fault = spyOn(real, "run").mockImplementation((sql, params) => {
    if (
      rejectReason &&
      sql.includes("INSERT INTO state_events") &&
      JSON.stringify(params).includes(reason)
    )
      throw new Error("injected reason event failure");
    return run(sql, params);
  });
  const owner = new StateOwner(real, { now: () => now });
  owner.initialize();
  const dependencies = [0, 1, 0, 0, 99, 3, 0];
  for (const [i, dependency] of dependencies.entries()) {
    const id = `work-${i + 1}`;
    owner.put(
      namespace,
      `issue:${id}`,
      {
        id,
        title: id,
        status: i === 2 ? "closed" : "open",
        dependsOn: dependency ? ["work-" + dependency] : [],
        labels: [],
        createdAt: new Date(now).toISOString(),
      },
      holder.actor,
      { expectRevision: 0 },
    );
  }
  for (const id of [4])
    owner.acquire(namespace, `issue:work-${id}`, holder, 60000, `seed-${id}`);
  function call<T = unknown>(
    op: string,
    id: number,
    extra: Record<string, unknown> = {},
  ): T {
    const state = createStateClient({
      owner,
      namespace,
      write: true,
      requestId: `request-${++request}`,
      context: {
        variant: "leased",
        ...holder,
        project: { id: "test" },
        leaseMode: "acquire",
      },
    });
    return operations[`issue.${op}`]!({
      input: { id: `shown-${id}`, ...extra },
      signal: new AbortController().signal,
      deadline: Number.MAX_SAFE_INTEGER,
      config: { idPrefix: "shown" },
      services: {
        state: { ...state, now: () => now },
        crypto: {
          sha256: (text: string) =>
            createHash("sha256").update(text).digest("hex"),
        },
      },
    }) as T;
  }
  return {
    call,
    close: () => {
      fault.mockRestore();
      return opened.handle.close();
    },
    snapshot: () => {
      const { image: _image, ...state } = owner.export();
      return state;
    },
    held: (id: number) => owner.lease(namespace, `issue:work-${id}`),
    failReason: () => {
      rejectReason = true;
    },
  };
}
function failure(run: () => unknown) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ForgeFailure);
    return (error as ForgeFailure).error;
  }
  throw new Error("Expected the claim to be refused");
}

test("open unheld blocker refuses without changing records, revisions, leases, events or requests", () => {
  const before = p.snapshot(),
    error = failure(() => p.call("claim", 2));
  expect(error.code).toBe("CLAIM_BLOCKED");
  expect(error.observed).toEqual({ blockers: [{ id: "shown-1" }] });
  expect(error.message).toMatch(/shown-1/);
  expect(error.message).toMatch(/open/i);
  expect(error.repair).toMatch(/--reason/);
  expect(p.snapshot()).toEqual(before);
}, 10000);

test("held and missing blockers retain the board shape, shown ids and holder", () => {
  p.call("claim", 1);
  for (const id of [2, 5]) {
    const before = p.snapshot(),
      error = failure(() => p.call("claim", id));
    const blockers =
      id === 2
        ? [{ id: "shown-1", holder, holderUnverified: true }]
        : [{ id: "shown-99" }];
    expect(error.code).toBe("CLAIM_BLOCKED");
    expect(error.observed).toEqual({ blockers });
    expect(error.message).toContain(blockers[0]!.id);
    if (id === 5) expect(error.message).toMatch(/missing/i);
    expect(p.snapshot()).toEqual(before);
  }
}, 10000);

test("reason permits a blocked claim, warns with its blockers and is visible in issue events", () => {
  const result = p.call<Grant>("claim", 2, { reason: `  ${reason}  ` });
  expect(result).toMatchObject({ id: "shown-2", generation: 1 });
  expect(result.warnings).toEqual([
    { code: "CLAIMED_BLOCKED", blockers: [{ id: "shown-1" }] },
  ]);
  expect(p.held(2)).toBeDefined();
  const events = p.call<{ events: StateEvent[] }>("events", 2).events;
  expect(
    events.some((event) => JSON.stringify(event.data).includes(reason)),
  ).toBe(true);
}, 10000);

test("reason event failure rolls back the lease, records, events and request receipt together", () => {
  const before = p.snapshot();
  p.failReason();
  expect(() => p.call("claim", 2, { reason })).toThrow(
    "injected reason event failure",
  );
  expect(p.snapshot()).toEqual(before);
}, 10000);

test("closed dependencies need no reason or warning; an optional reason is recorded", () => {
  expect(p.call<Grant>("claim", 6).warnings ?? []).toEqual([]);
  expect(p.held(6)).toBeDefined();
  expect(p.call<Grant>("claim", 7, { reason }).warnings ?? []).toEqual([]);
  const events = p.call<{ events: StateEvent[] }>("events", 7).events;
  expect(
    events.some((event) => JSON.stringify(event.data).includes(reason)),
  ).toBe(true);
}, 10000);

test.each(["", " \t\n", "x".repeat(65537)])(
  "invalid reason %# refuses with INPUT_INVALID and no writes",
  (reason) => {
    const before = p.snapshot();
    expect(failure(() => p.call("claim", 2, { reason })).code).toBe(
      "INPUT_INVALID",
    );
    expect(p.snapshot()).toEqual(before);
  },
  10000,
);

test("reason accepts the comment limit of 65536 Unicode characters", () => {
  expect(
    p.call<Grant>("claim", 2, { reason: "\u{1f642}".repeat(65536) }).generation,
  ).toBe(1);
}, 10000);

test("seven mixed issues need a claim reason exactly when their board lists BLOCKED_BY", () => {
  for (const id of [1, 2, 4, 5, 6, 7]) {
    const row = p.call<{
      items: { notReadyBecause: { code: string; id?: string }[] }[];
    }>("board", id).items[0]!;
    const blocked = row.notReadyBecause.some((r) => r.code === "BLOCKED_BY");
    if (blocked)
      expect(failure(() => p.call("claim", id)).code).toBe("CLAIM_BLOCKED");
    else if (id === 4)
      expect(failure(() => p.call("claim", id)).code).toBe("LEASE_HELD");
    else expect(p.call<Grant>("claim", id).warnings ?? []).toEqual([]);
  }
}, 10000);
