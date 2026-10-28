import { expect, test } from "bun:test";
import { createReceiptsService } from "../../../src/assembly/providers.ts";
import { hash } from "../../../src/blocks/check/receipt.ts";

test("verified receipt reads preserve subject and reject a tampered subject", () => {
  const body = {
    version: 1,
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    status: "NOT_EXECUTED",
    subject: "a".repeat(40),
    checkedAt: "2026-10-28T00:00:00Z",
    checked: [],
    reason: "No checks selected",
    inputsDigest: `sha256:${"b".repeat(64)}`,
    runs: [],
  };
  let value = { ...body, digest: hash(body) };
  const service = createReceiptsService(
    {
      op: "fixture.read",
      effects: [],
      signal: new AbortController().signal,
      deadline: Date.now() + 1000,
      processContainment: "supervised",
    },
    {
      get: (key) =>
        key === `runs/${body.id}`
          ? {
              namespace: "forge/check",
              key,
              value,
              revision: 1,
              updatedAt: body.checkedAt,
              updatedBy: { kind: "human", id: "test" },
            }
          : undefined,
    },
  );
  expect(service.get(body.id)).toEqual({
    id: body.id,
    status: body.status,
    subject: body.subject,
  });
  expect(service.get("absent")).toBeUndefined();
  expect(Object.keys(service)).toEqual(["get"]);
  value = { ...value, subject: "c".repeat(40) };
  expect(() => service.get(body.id)).toThrow("Receipt integrity failed");
}, 1000);
