import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateWithSchema } from "../../../src/contract/schema.ts";

setDefaultTimeout(30_000);

type Grant = { generation: number; expiresAt: string };
type Handler = (call: {
  input: { id: string; ttlSeconds?: number };
  config?: unknown;
  services: unknown;
}) => Grant;

const root = resolve(import.meta.dirname, "../../../src/blocks/work");
let operations: Record<string, Handler>;
const globals = globalThis as Record<string, unknown>;
const hadFail = "fail" in globals;
const previousFail = globals.fail;
beforeAll(() => {
  globals.fail = (code: string, message: string) => {
    throw new Error(`${code}: ${message}`);
  };
  operations = require(resolve(root, "entry.cts")) as typeof operations;
});
afterAll(() => {
  if (hadFail) globals.fail = previousFail;
  else delete globals.fail;
});

function project() {
  let now = 1000;
  let lease: (Grant & { holder: unknown }) | undefined;
  const writeLease = (_subject: string, ttl: number) => {
    lease = {
      generation: 1,
      holder: {
        actor: { kind: "agent", id: "worker" },
        session: { id: "test" },
      },
      expiresAt: new Date(now + ttl).toISOString(),
    };
    return lease;
  };
  const state = {
    now: () => now,
    get: () => ({ value: { id: "work-1", status: "open" } }),
    lease: () => lease,
    acquire: writeLease,
    renew: writeLease,
  };
  return {
    advance: () => (now += 1000),
    call: (
      operation: "claim" | "renew",
      config?: unknown,
      ttlSeconds?: number,
    ) =>
      operations[`issue.${operation}`]!({
        input: {
          id: "work-1",
          ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
        },
        config,
        services: { state },
      }),
  };
}

for (const operation of ["claim", "renew"] as const) {
  test(`${operation} uses the configured claim lifetime when input omits ttlSeconds`, () => {
    const source = project();
    if (operation === "renew") source.call("claim", undefined, 60);
    source.advance();
    expect(source.call(operation, { claimTtlSeconds: 7200 }).expiresAt).toBe(
      new Date(2000 + 7200 * 1000).toISOString(),
    );
  });

  test(`${operation} lets an explicit duration override the configured lifetime`, () => {
    const source = project();
    if (operation === "renew") source.call("claim", undefined, 60);
    expect(
      source.call(operation, { claimTtlSeconds: 7200 }, 17).expiresAt,
    ).toBe(new Date(1000 + 17 * 1000).toISOString());
  });

  test(`${operation} preserves the one-hour fallback without a configured lifetime`, () => {
    for (const config of [undefined, {}]) {
      const source = project();
      if (operation === "renew") source.call("claim", undefined, 60);
      expect(source.call(operation, config).expiresAt).toBe(
        new Date(1000 + 3600 * 1000).toISOString(),
      );
    }
  });
}

test("claimTtlSeconds is a bounded integer configuration with a one-hour default", () => {
  const schema = JSON.parse(
    readFileSync(resolve(root, "schemas/config.json"), "utf8"),
  ) as { properties: { claimTtlSeconds?: { default: unknown } } };
  expect(schema.properties.claimTtlSeconds?.default).toBe(3600);
  expect(validateWithSchema(schema, {})).toEqual([]);
  for (const claimTtlSeconds of [1, 7200, 604800])
    expect(validateWithSchema(schema, { claimTtlSeconds })).toEqual([]);
  for (const claimTtlSeconds of [0, -1, 604801, 1.5, "7200", null])
    expect(validateWithSchema(schema, { claimTtlSeconds })).not.toEqual([]);
});
