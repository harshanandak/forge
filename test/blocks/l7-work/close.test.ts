import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { resolve } from "node:path";

setDefaultTimeout(30_000);

type Handler = (call: {
  input: Record<string, unknown>;
  services: unknown;
}) => Record<string, unknown>;
let operations: Record<string, Handler>;
const globals = globalThis as Record<string, unknown>;
const previousFail = globals.fail;
beforeAll(() => {
  globals.fail = (code: string) => {
    throw new Error(code);
  };
  operations = require(
    resolve(import.meta.dirname, "../../../src/blocks/work/entry.cts"),
  ) as typeof operations;
});
afterAll(() => {
  if (previousFail === undefined) delete globals.fail;
  else globals.fail = previousFail;
});

function project(receipt?: { id: string; status: string }) {
  let record = {
    key: "issue:work-1",
    revision: 1,
    updatedAt: "2026-10-26T00:00:00Z",
    value: {
      id: "work-1",
      title: "Deliver",
      status: "open",
      labels: [],
      dependsOn: [],
      createdAt: "2026-10-26T00:00:00Z",
    },
  };
  const state = {
    now: () => 0,
    lease: () => undefined,
    acquire: () => undefined,
    get: (key: string) =>
      key === record.key ? structuredClone(record) : undefined,
    list: () => [structuredClone(record)],
    put(
      key: string,
      value: typeof record.value,
      options: { expectRevision: number },
    ) {
      expect(options.expectRevision).toBe(record.revision);
      record = {
        key,
        value: structuredClone(value),
        revision: record.revision + 1,
        updatedAt: record.updatedAt,
      };
      return structuredClone(record);
    },
  };
  return {
    call: (input: Record<string, unknown>) =>
      operations["issue.close"]!({
        input: { id: "work-1", ...input },
        services: {
          state,
          receipts: {
            get: (id: string) => {
              return receipt?.id === id ? receipt : undefined;
            },
          },
        },
      }),
    read: () =>
      operations["issue.show"]!({
        input: { id: "work-1" },
        services: { state },
      }),
    stored: () => structuredClone(record),
  };
}

for (const input of [
  {},
  { reason: "merged in abc" },
  { withoutReceipt: "  \n\t" },
]) {
  test(`close refuses missing delivery evidence ${JSON.stringify(input)} without changing the item`, () => {
    const harness = project();
    const before = harness.stored();
    expect(() => harness.call(input)).toThrow("RECEIPT_REQUIRED");
    expect(harness.stored()).toEqual(before);
    expect(harness.read().status).toBe("open");
  });
}

for (const status of ["FAIL", "INCOMPLETE", "NOT_EXECUTED", undefined]) {
  test(`close refuses ${status ?? "unknown"} evidence without changing the item`, () => {
    const harness = project(status ? { id: "receipt", status } : undefined);
    const before = harness.stored();
    expect(() => harness.call({ receipt: "receipt" })).toThrow(
      "RECEIPT_INVALID",
    );
    expect(harness.stored()).toEqual(before);
  });
}

test("close stores its evidence, survives show readback and replaces previous evidence", () => {
  const harness = project({ id: "receipt", status: "PASS" });
  expect(harness.call({ receipt: "receipt", reason: "merged" })).toMatchObject({
    status: "closed",
    receipt: "receipt",
  });
  expect(harness.read()).toMatchObject({
    status: "closed",
    receipt: "receipt",
  });
  expect(harness.call({ withoutReceipt: "Superseded" })).toMatchObject({
    status: "closed",
    withoutReceipt: "Superseded",
  });
  expect(harness.read().receipt).toBeUndefined();
  expect(harness.read()).toMatchObject({
    withoutReceipt: "Superseded",
  });
  harness.call({ receipt: "receipt" });
  expect(harness.read().withoutReceipt).toBeUndefined();
  expect(harness.read().receipt).toBe("receipt");
});

test("an invalid supplied receipt cannot be hidden by an exemption", () => {
  const harness = project();
  expect(() =>
    harness.call({ receipt: "unknown", withoutReceipt: "Superseded" }),
  ).toThrow("RECEIPT_INVALID");
  expect(harness.read().status).toBe("open");
});
