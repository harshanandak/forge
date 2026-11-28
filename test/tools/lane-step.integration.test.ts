import { expect, setDefaultTimeout, test } from "bun:test";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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
  const otherDevice = inspectFixture();
  otherDevice.facts.caller.device = "different-device";
  const otherActor = inspectFixture();
  const actorLane = otherActor.facts.lane;
  if (!actorLane?.lease) throw new Error("Expected a fixture lease");
  const holder = {
    actor: "different-actor",
    session: otherActor.facts.caller.session,
  };
  otherActor.facts.lane = {
    ...actorLane,
    lease: { ...actorLane.lease, holder },
  };
  const moved = inspectFixture();
  const lane = moved.facts.lane;
  if (!lane) throw new Error("Expected a fixture lane");
  let laneReads = 0;
  const movingLane = {
    ...moved,
    reads: {
      ...moved.reads,
      lane: () =>
        Promise.resolve(
          laneReads++ === 0 ? lane : { ...lane, branch: "feat/moved" },
        ),
    },
  };
  for (const [f, field, code] of [
    [expired, "lease", "LEASE_EXPIRED"],
    [other, "lease", "LEASE_NOT_HELD"],
    [missing, "issue", "LANE_NOT_FOUND"],
    [otherDevice, "lease", "LEASE_NOT_HELD"],
    [otherActor, "lease", "LEASE_NOT_HELD"],
    [movingLane, "branch", "CONTEXT_MISMATCH"],
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

test("I4 refuses a branch switch at the same HEAD during status", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "forge-lane-step-")));
  try {
    const f = cliFixture(root);
    const branch = "feat/other";
    const result = await f.runWithBranchSwitch(branch);
    const after = f.snapshot();
    expect(after.branch).toBe(`refs/heads/${branch}`);
    expect(f.head()).toBe(f.request.expectedHead);
    expect(after.status).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject(
      refusal("workspace", "UNAVAILABLE"),
    );
    expect(result.exitCode).toBe(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(["ancestor swap", "in-project ancestor link"] as const)(
  "A9 refuses a brief opened through an %s",
  async (scenario) => {
    const root = realpathSync.native(
      mkdtempSync(join(tmpdir(), "forge-brief-path-")),
    );
    try {
      const f = cliFixture(root);
      const { path } = f.request.brief;
      const parent = dirname(path);
      const outside = join(root, "outside");
      const inside = join(dirname(parent), "other-briefs");
      const link = scenario === "ancestor swap" ? outside : inside;
      const preload = join(root, "swap-before-brief-open.ts");
      let args: string[] = [];
      if (scenario === "ancestor swap") {
        mkdirSync(outside);
        linkSync(path, join(outside, basename(path)));
        writeFileSync(
          preload,
          `
import { mock } from "bun:test";
import * as fs from "node:fs";
import { relative } from "node:path";
const original = { ...fs };
const brief = ${JSON.stringify(path)};
mock.module("node:fs", () => ({
  ...original,
  openSync(path, ...args) {
    if (typeof path === "string" && relative(brief, path) === "") {
      original.renameSync(${JSON.stringify(parent)}, ${JSON.stringify(inside)});
      original.symlinkSync(${JSON.stringify(outside)}, ${JSON.stringify(parent)}, "junction");
    }
    return original.openSync(path, ...args);
  },
}));
`,
        );
        args = ["--preload", preload];
      } else {
        renameSync(parent, inside);
        symlinkSync(inside, parent, "junction");
      }
      const result = await f.run(f.request, args);
      expect(realpathSync.native(parent), result.stderr).toBe(link);
      expect(result.exitCode, result.stdout || result.stderr).toBe(2);
      expect(JSON.parse(result.stdout)).toEqual(
        refusal("brief.path", "UNAVAILABLE"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);
