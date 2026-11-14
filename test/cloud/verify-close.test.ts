import { expect, test } from "bun:test";
import manifest from "../../src/blocks/work/forge.block.json" with { type: "json" };
import CloseInput from "../../src/blocks/work/schemas/CloseInput.json" with { type: "json" };
import { schemas } from "../../cloud/src/issue-read.ts";
import { decodeEvidence } from "../../cloud/src/evidence-receipts.ts";
import {
  admissionFixture,
  namespace,
  subject,
} from "./receipt-admission.fixture.ts";

test("issue.close with pr dispatches verification and returns the closed issue", async () => {
  const f = await admissionFixture();
  try {
    const before = f.snapshot();
    const response = await f.command();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { op: string; result: unknown };
    expect(body.op).toBe("issue.close");
    expect(body.result).toMatchObject({ id: "work-1", status: "closed" });
    const after = f.snapshot();
    expect(after.evidence).toHaveLength(1);
    const receipt = decodeEvidence(String(after.evidence[0]!.body));
    expect(body.result).toHaveProperty("receipt", receipt.id);
    expect(after.tables.state_leases).toEqual(before.tables.state_leases);
    expect(after.tables.domain_cloud_command_receipts!.length).toBe(
      before.tables.domain_cloud_command_receipts!.length + 1,
    );
    const calls = f.state.calls.length;
    expect(f.state.prReads).toBe(2);
    expect(await (await f.command()).json()).toEqual(body);
    expect(f.snapshot()).toEqual(after);
    expect(f.state.calls).toHaveLength(calls);
  } finally {
    f.dbSource.close();
  }
}, 30_000);

const shapes: readonly [string, object, boolean][] = [
  ["pr", { pr: 490 }, true],
  ["receipt", { receipt: "local-receipt" }, true],
  ["reason", { withoutReceipt: "manual close" }, true],
  ["missing proof", {}, true],
  ["receipt and pr", { receipt: "local-receipt", pr: 490 }, false],
  ["reason and pr", { withoutReceipt: "manual close", pr: 490 }, false],
  [
    "receipt and reason",
    { receipt: "local-receipt", withoutReceipt: "manual close" },
    true,
  ],
  ...[0, -1, 1.5, "490", null].map((pr): [string, object, boolean] => [
    `invalid pr ${JSON.stringify(pr)}`,
    { pr },
    false,
  ]),
];
for (const [name, input, valid] of shapes)
  test(`close input shape: ${name}`, () => {
    expect(
      schemas().validate(CloseInput.$ref, { id: "work-1", ...input }).length ===
        0,
    ).toBe(valid);
  }, 30_000);

for (const [name, input, code] of [
  ["local receipt", { receipt: "local-receipt" }, "INPUT_INVALID"],
  ["pr and receipt", { pr: 490, receipt: "local-receipt" }, "INPUT_INVALID"],
  [
    "pr and reason",
    { pr: 490, withoutReceipt: "manual close" },
    "INPUT_INVALID",
  ],
  ["zero pr", { pr: 0 }, "INPUT_INVALID"],
] as const)
  test(`cloud close refusal: ${name}`, async () => {
    const f = await admissionFixture();
    try {
      const before = f.snapshot();
      await expect(
        f.command({ id: "work-1", ...input }),
      ).rejects.toHaveProperty("error.code", code);
      expect(f.owner.get(namespace, subject)?.value).toHaveProperty(
        "status",
        "open",
      );
      expect(f.snapshot().evidence).toEqual(before.evidence);
      expect(f.snapshot().tables.state_records).toEqual(
        before.tables.state_records,
      );
      expect(f.snapshot().tables.state_events).toEqual(
        before.tables.state_events,
      );
      expect(f.snapshot().tables.state_leases).toEqual(
        before.tables.state_leases,
      );
      expect(f.state.calls).toEqual([]);
    } finally {
      f.dbSource.close();
    }
  }, 30_000);

test("close without receipt preserves the existing route and skips GitHub", async () => {
  const f = await admissionFixture();
  try {
    const response = await f.command({
      id: "work-1",
      withoutReceipt: "manual close",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty(
      "result.withoutReceipt",
      "manual close",
    );
    expect(f.owner.get(namespace, subject)?.value).toHaveProperty(
      "status",
      "closed",
    );
    expect(f.snapshot().evidence).toEqual([]);
    expect(f.state.calls).toEqual([]);
  } finally {
    f.dbSource.close();
  }
}, 30_000);

for (const op of ["receipt.admit", "receipt.show"])
  test(`${op} is absent from the catalog and refused by the cloud`, async () => {
    const f = await admissionFixture();
    try {
      const before = f.snapshot();
      await expect(
        f.command({ id: "work-1", pr: 490 }, op),
      ).rejects.toHaveProperty("error.code", "UNKNOWN_COMMAND");
      expect(f.snapshot()).toEqual(before);
      expect(Object.hasOwn(manifest.operations, op)).toBe(false);
    } finally {
      f.dbSource.close();
    }
  }, 30_000);
