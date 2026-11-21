import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import { ForgeFailure } from "../../../src/contract/failure.ts";
import {
  checkLeaseSubject,
  StateOwner,
} from "../../../src/core/state/index.ts";
import type { LeaseHolder, LeaseRecord } from "../../../src/generated/types.ts";

const timeout = 30_000;
const namespace = "forge/work";
const holder: LeaseHolder = {
  actor: { kind: "agent", id: "lease-subject" },
  session: { id: "lease-subject" },
};

async function owner(legacy?: LeaseRecord) {
  const opened = await createSqliteStore(tmpdir()).open({
    path: ":memory:",
    readOnly: false,
  });
  if (!opened.ok) throw new Error(opened.unavailable.reason);
  const state = new StateOwner(opened.handle.value, { now: () => 1000 });
  state.initialize();
  if (legacy)
    opened.handle.value.run(
      "INSERT INTO state_leases(namespace,subject,generation,body) VALUES (?,?,?,?)",
      [namespace, legacy.subject, legacy.generation, JSON.stringify(legacy)],
    );
  return state;
}

function outcome(work: () => unknown): unknown {
  try {
    work();
    return "accepted";
  } catch (error) {
    if (error instanceof ForgeFailure) return error.error;
    throw error;
  }
}

const length = "Key must contain 1 to 500 characters";
const cases = [
  ["an over-long", "w".repeat(501), length, length],
  ["an empty", "", length, length],
  [
    "a lone-surrogate",
    "\ud800",
    "Lease subject must be well-formed UTF-16 text",
    "Lease subject must be well-formed UTF-16 text",
  ],
  ["a 500-character", "w".repeat(500), undefined, undefined],
] as const;

for (const [label, subject, acquire, held] of cases) {
  test(
    `the shared validator answers ${label} subject exactly as StateOwner does`,
    async () => {
      const state = await owner();
      const acquired = outcome(() =>
        state.acquire(namespace, subject, holder, 60_000, "r-1"),
      );
      expect(outcome(() => checkLeaseSubject(subject, "acquire"))).toEqual(
        acquire === undefined ? "accepted" : acquired,
      );
      expect(acquired).toEqual(
        acquire === undefined
          ? "accepted"
          : { code: "INPUT_INVALID", message: acquire, retry: "never" },
      );
      const fence = { subject, holder, generation: 1 };
      const renewed = outcome(() => state.renew(namespace, fence, 60_000));
      const checked = outcome(() => checkLeaseSubject(subject, "held"));
      if (held !== undefined)
        expect(renewed).toMatchObject({ code: "INPUT_INVALID", message: held });
      expect(checked).toEqual(held === undefined ? "accepted" : renewed);
    },
    timeout,
  );
}

test(
  "StateOwner renews and releases an exact legacy subject",
  async () => {
    const legacy = {
      subject: "work-\ud800",
      holder,
      generation: 1,
      expiresAt: new Date(61_000).toISOString(),
    };
    const state = await owner(legacy);
    const renewed = state.renew(namespace, legacy, 90_000);
    expect(renewed.expiresAt).toBe(new Date(91_000).toISOString());
    expect(state.release(namespace, legacy)).toEqual({
      ...renewed,
      releasedAt: new Date(1000).toISOString(),
    });
  },
  timeout,
);
