import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InspectRefusal } from "../../tools/lane-step-contract.ts";
import { inspect } from "../../tools/lane-step.ts";
import {
  cliFixture,
  expectedContext,
  inspectFixture,
} from "./lane-step-fixture.ts";

setDefaultTimeout(30_000);

type Fixture = ReturnType<typeof inspectFixture>;

const refusal = (field: string, code?: InspectRefusal["code"]) => ({
  status: "refused",
  field,
  ...(code ? { code } : {}),
});

async function inspectUnchanged(f: Fixture, input: unknown = f.request) {
  const before = structuredClone({ input, facts: f.facts });
  const result = await inspect(input, f.reads);
  expect({ input, facts: f.facts }).toEqual(before);
  return result;
}

test("P1 closed request", async () => {
  const request = inspectFixture().request;
  const { expectedHead: _expectedHead, ...missingHead } = request;
  for (const [input, field] of [
    [{ ...request, extra: true }, "extra"],
    [missingHead, "expectedHead"],
    [{ ...request, brief: { ...request.brief, extra: true } }, "brief.extra"],
  ] as const) {
    const f = inspectFixture();
    const result = await inspectUnchanged(f, input);
    expect(f.calls).toEqual([]);
    expect(result).toMatchObject(refusal(field, "INPUT_INVALID"));
  }
});

test("P2 malformed values", async () => {
  for (const [field, value] of [
    ["expectedHead", "z".repeat(40)],
    ["workspace", "relative/workspace"],
  ] as const) {
    const f = inspectFixture();
    const result = await inspectUnchanged(f, { ...f.request, [field]: value });
    expect(f.calls).toEqual([]);
    expect(result).toMatchObject(refusal(field, "INPUT_INVALID"));
  }
});

test("I1 valid", async () => {
  const f = inspectFixture();
  expect(await inspectUnchanged(f)).toEqual({
    status: "context",
    context: expectedContext(f.request),
  });
});

test("I2 brief edited", async () => {
  const f = inspectFixture();
  f.facts.bytes = new TextEncoder().encode("Approved brief\n");
  expect(await inspectUnchanged(f)).toMatchObject(
    refusal("brief.digest", "BRIEF_DIGEST_MISMATCH"),
  );
});

test("I3 wrong worktree", async () => {
  const f = inspectFixture();
  const input = { ...f.request, workspace: join(f.request.workspace, "other") };
  expect(await inspectUnchanged(f, input)).toMatchObject(refusal("workspace"));
});

test("I4 wrong branch", async () => {
  const f = inspectFixture();
  f.facts.workspace.branch = "feat/another";
  expect(await inspectUnchanged(f)).toMatchObject(refusal("branch"));
});

test("I5 stale head", async () => {
  const f = inspectFixture();
  f.facts.workspace.head = "b".repeat(40);
  expect(await inspectUnchanged(f)).toMatchObject(refusal("expectedHead"));
});

test("I6 lease", async () => {
  const expired = inspectFixture();
  expired.facts.now += 1;
  const other = inspectFixture();
  other.facts.caller.session = "different-session";
  const missing = inspectFixture();
  missing.facts.lane = undefined;
  for (const [f, field, code] of [
    [expired, "lease", "LEASE_EXPIRED"],
    [other, "lease", "LEASE_NOT_HELD"],
    [missing, "issue", "LANE_NOT_FOUND"],
  ] as const)
    expect(await inspectUnchanged(f)).toMatchObject(refusal(field, code));
});

test("I7 dirty tree", async () => {
  for (const status of ["?? untracked.txt", " M tracked.txt"]) {
    const f = inspectFixture();
    f.facts.workspace.status = status;
    expect(await inspectUnchanged(f)).toMatchObject(
      refusal("workspace", "WORKTREE_DIRTY"),
    );
  }
});

test("C1 CLI", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "forge-lane-step-")));
  try {
    const f = cliFixture(root);
    const before = f.snapshot();
    const valid = await f.run(f.request);
    const invalid = await f.run({ ...f.request, extra: true });
    expect(f.snapshot()).toEqual(before);
    expect(valid.exitCode, valid.stdout || valid.stderr).toBe(0);
    expect(JSON.parse(valid.stdout)).toEqual({
      status: "context",
      context: expectedContext(f.request),
    });
    expect(invalid.exitCode).not.toBeNull();
    expect(invalid.exitCode).not.toBe(0);
    expect(JSON.parse(invalid.stdout)).toMatchObject(
      refusal("extra", "INPUT_INVALID"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
