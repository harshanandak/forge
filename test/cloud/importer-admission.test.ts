import { expect, setDefaultTimeout, test } from "bun:test";
import { spyOn } from "bun:test";
import { currentState, pagesOf } from "../../tools/import-current-state.ts";
import * as importer from "../../tools/import-current-state.ts";
import { imageDigests } from "../../tools/import-current.ts";
import {
  validateDeclaredWorkRecord,
  workFamilyDeclarations,
  workFamilyPolicy,
} from "../../src/blocks/work/state-families.ts";
import { StateOwner } from "../../src/core/state/index.ts";
import { limitsFrom, restorePage } from "../../cloud/src/dump.ts";
import { domain } from "../../cloud/src/project.ts";
import * as f from "./import-current-state.fixture.ts";

setDefaultTimeout(120_000);
const limits = limitsFrom({});
const repair = "Imported: closed before Forge required close evidence";
const cases = [
  ["issue:work-2", null],
  ["issue:work-2", { ...f.issueValue("work-2"), id: "bogus" }],
  ["issue:work-2", { ...f.issueValue("work-2"), parent: "bogus" }],
  [
    "issue:work-2",
    { ...f.issueValue("work-2"), dependsOn: ["work-1", "work-1"] },
  ],
  ["comment:work-1:1", null],
  ["comment:work-1:1", { id: "work-1", body: "x", call: {}, checkpoint: {} }],
  ["link:work-1:1", null],
  [
    "link:work-1:1",
    { id: "work-1", relation: "reference", url: "javascript:alert(1)" },
  ],
  ["comment:work-1:9007199254740992", { id: "work-1", body: "x" }],
  ["slots:work-1", { count: 17, next: 0 }],
  [
    "issue:work-2",
    { ...f.issueValue("work-2"), status: "closed", withoutReceipt: "" },
  ],
] as const;
test.each(cases)(
  "main admission refuses %s before the first import write",
  (key, value) => {
    const reason = validateDeclaredWorkRecord(key, value);
    expect(reason).toBeDefined();
    const source = f.source(4, false, false, (_db, state) =>
      state.put(f.ns, key, value, f.actor, { expectRevision: 0 }),
    );
    const scratch = f.database();
    f.owner(scratch).initialize();
    const before = f.snapshot(scratch),
      original = f.snapshot(source.db);
    const write = spyOn(scratch, "run");
    try {
      let refused: unknown;
      try {
        currentState(source.db, scratch, source.manifest, limits);
      } catch (error) {
        refused = error;
      }
      expect(refused).toMatchObject({
        error: { code: "INPUT_INVALID", observed: { id: key, reason } },
      });
      expect(write).not.toHaveBeenCalled();
      expect(f.snapshot(scratch)).toEqual(before);
      expect(f.snapshot(source.db)).toEqual(original);
      expect(source.bytes()).toBe(source.manifest.sha256);
    } finally {
      write.mockRestore();
    }
  },
);

test("154 one-time close repairs retain 8066 records and all six paged readback digests", () => {
  const source = f.source(8066, false, false, (_db, state) => {
    for (let n = 1; n <= 154; n++)
      state.put(
        f.ns,
        `issue:work-${n}`,
        { ...f.issueValue(`work-${n}`, `Synthetic ${n}`), status: "closed" },
        f.actor,
        { expectRevision: 1 },
      );
    state.putNext(
      f.ns,
      "comment:work-1:",
      () => ({ value: { id: "work-1", body: "valid comment" } }),
      f.actor,
    );
    state.putNext(
      f.ns,
      "link:work-1:",
      () => ({
        value: {
          id: "work-1",
          relation: "reference",
          url: "https://example.com/one",
        },
      }),
      f.actor,
    );
    state.delete(f.ns, "issue:work-8062", f.actor, { expectRevision: 1 });
    state.delete(f.ns, "issue:work-8063", f.actor, { expectRevision: 1 });
  });
  const scratch = f.database();
  f.owner(scratch).initialize();
  const projected = currentState(source.db, scratch, source.manifest, limits);
  expect(projected.records).toBe(8066);
  expect(projected.repaired).toEqual({ records: 154, historicalUpdates: 154 });
  for (const record of f.owner(scratch).list(f.ns)) {
    expect(
      validateDeclaredWorkRecord(record.key, record.value),
    ).toBeUndefined();
    if (
      record.key.startsWith("issue:") &&
      (record.value as { status: string }).status === "closed"
    )
      expect(record.value).toHaveProperty("withoutReceipt", repair);
  }
  const target = f.cloudDatabase(),
    owner = new StateOwner(target, { now: () => f.at }, [workFamilyPolicy]);
  owner.initialize([domain]);
  for (const page of pagesOf(scratch, limits))
    restorePage(target, owner, page, limits);
  expect(imageDigests(target)).toEqual(imageDigests(scratch));
  expect(owner.list(f.ns)).toHaveLength(8066);
  expect(source.bytes()).toBe(source.manifest.sha256);
});

test("all declared work families have an explicit import or acknowledged local disposition", () => {
  const dispositions = importer.importDispositions;
  expect(dispositions).toBeDefined();
  expect(Object.keys(dispositions).sort()).toEqual(
    Object.keys(workFamilyDeclarations).sort(),
  );
  expect(
    Object.values(dispositions).every((row) => row.reason.trim().length > 0),
  ).toBe(true);
  const source = f.source(4, false, false, (_db, state) => {
    for (const [key, value] of [
      ["autopilot-clock:work-1", { startedAt: new Date(f.at).toISOString() }],
      ["autopilot-ask:work-1", {}],
      ["autopilot-event:work-1:1", {}],
    ] as const)
      state.put(f.ns, key, value, f.actor, { expectRevision: 0 });
  });
  const scratch = f.database();
  f.owner(scratch).initialize();
  const projected = currentState(source.db, scratch, source.manifest, limits);
  expect(projected.records).toBe(4);
  const rows = projected.leftBehind.report.records;
  for (const shape of [
    "autopilot-clock:*",
    "autopilot-ask:*",
    "autopilot-event:*",
  ]) {
    const expected = {
      namespace: f.ns,
      shape,
      count: 1,
      reason:
        "local runtime state; retained in the pre-cutover snapshot; never imported as live approvals",
    };
    expect(rows).toContainEqual(expected);
  }
});
