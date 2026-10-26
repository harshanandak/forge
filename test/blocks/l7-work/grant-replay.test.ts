import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import { createStateClient } from "../../../src/assembly/state-client.ts";
import { StateOwner } from "../../../src/core/state/index.ts";
import type {
  BoundContext,
  LeaseHolder,
  LeaseRecord,
} from "../../../src/generated/types.ts";

setDefaultTimeout(30_000);
type Handler = (call: {
  input: Record<string, unknown>;
  services: unknown;
}) => unknown;
let operations: Record<string, Handler>;
const globals = globalThis as Record<string, unknown>;
const previousFail = globals.fail;
beforeAll(() => {
  globals.fail = (code: string, message: string) => {
    throw new Error(`${code}: ${message}`);
  };
  operations = require(
    resolve(import.meta.dirname, "../../../src/blocks/work/entry.cts"),
  ) as typeof operations;
});
afterAll(() => {
  if (previousFail === undefined) delete globals.fail;
  else globals.fail = previousFail;
});
const original: LeaseHolder = {
  actor: { kind: "human", id: "local-cli" },
  session: { id: "chat", device: "device", agent: "terminal", harness: "cli" },
};
const caller: LeaseHolder = {
  actor: { kind: "agent", id: "worker" },
  session: { id: "chat", device: "device", agent: "worker", harness: "codex" },
};
async function project(holder = original) {
  const opened = await createSqliteStore(tmpdir()).open({
    path: ":memory:",
    readOnly: false,
  });
  if (!opened.ok) throw new Error(opened.unavailable.reason);
  const owner = new StateOwner(opened.handle.value, { now: () => 1000 });
  owner.initialize();
  owner.put(
    "forge/work",
    "issue:work-1",
    {
      id: "work-1",
      status: "open",
      title: "Replay",
      labels: [],
      dependsOn: [],
      createdAt: new Date(1000).toISOString(),
    },
    holder.actor,
    { expectRevision: 0 },
  );
  const call = (
    op: "claim" | "renew",
    who: LeaseHolder,
    read?: (lease: LeaseRecord | undefined) => LeaseRecord | undefined,
  ) => {
    const context: BoundContext = {
      variant: "leased",
      ...who,
      project: { id: "project" },
      ...(op === "claim"
        ? { leaseMode: "acquire" }
        : { leaseMode: "held", leaseGeneration: 1 }),
    };
    const state = createStateClient({
      owner,
      namespace: "forge/work",
      context,
      write: true,
      requestId: op === "claim" ? "original-claim" : "renew",
    });
    return operations[`issue.${op}`]!({
      input: { id: "work-1", ttlSeconds: op === "claim" ? 1 : 5 },
      services: {
        state: read
          ? { ...state, lease: (subject: string) => read(state.lease(subject)) }
          : state,
      },
    });
  };
  return { owner, call, close: () => opened.handle.close() };
}

test("claim replay after a cross-actor renewal retains the original grant and accepts current caller labels", async () => {
  const source = await project();
  try {
    const granted = source.call("claim", original);
    source.call("renew", caller);
    expect(source.owner.lease("forge/work", "issue:work-1")?.holder).toEqual(
      caller,
    );
    expect(source.call("claim", original)).toEqual(granted);
    expect(granted).toMatchObject({
      generation: 1,
      expiresAt: new Date(2000).toISOString(),
    });
    expect(source.owner.lease("forge/work", "issue:work-1")?.expiresAt).toBe(
      new Date(6000).toISOString(),
    );
  } finally {
    await source.close();
  }
});

for (const fault of ["missing", "generation", "device", "session"] as const) {
  test(`grant replay refuses a ${fault} readback after caller labels change`, async () => {
    const source = await project();
    try {
      source.call("claim", original);
      source.call("renew", caller);
      expect(() =>
        source.call("claim", original, (lease) => {
          if (!lease || fault === "missing") return undefined;
          if (fault === "generation") return { ...lease, generation: 2 };
          return {
            ...lease,
            holder: {
              ...lease.holder,
              session: {
                ...lease.holder.session,
                ...(fault === "device" ? { device: "other" } : { id: "other" }),
              },
            },
          };
        }),
      ).toThrow("Accepted lease did not match its readback");
    } finally {
      await source.close();
    }
  });
}

test("legacy grant readback still refuses another actor with the same session", async () => {
  const legacy: LeaseHolder = {
    actor: original.actor,
    session: { id: "chat" },
  };
  const source = await project(legacy);
  try {
    source.call("claim", legacy);
    expect(() =>
      source.call(
        "claim",
        legacy,
        (lease) =>
          lease && {
            ...lease,
            holder: { ...lease.holder, actor: caller.actor },
          },
      ),
    ).toThrow("Accepted lease did not match its readback");
  } finally {
    await source.close();
  }
});
