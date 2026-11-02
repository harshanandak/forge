import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LocalState } from "../../../src/assembly/state.ts";
import type { TrackerItem } from "../../../src/generated/types.ts";
const cli =
  process.env.FORGE_MAP_CLI ??
  resolve(import.meta.dirname, "../../../dist/bin/forge.js");
type TreeNode = {
  item: TrackerItem;
  children: TreeNode[];
  openChildren: number;
  closedChildren: number;
};
type Result<Op extends string> = Op extends "tree"
  ? {
      items: TreeNode[];
      parentless: { count: number; ids: string[] };
      closedParents: { count: number; ids: string[] };
    }
  : Op extends "list"
    ? { items: TrackerItem[] }
    : Op extends "lint"
      ? { problems: string[] }
      : TrackerItem;
setDefaultTimeout(30000);
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
function project() {
  const root = mkdtempSync(join(tmpdir(), "forge738-map-"));
  roots.push(root);
  mkdirSync(join(root, ".forge"));
  writeFileSync(join(root, "package.json"), "{}");
  const configure = (required = false) =>
    writeFileSync(
      join(root, ".forge/config.yaml"),
      "schemaVersion: forge.config/1\nblocks:\n  work:\n    source: { builtin: forge/work }\n    bind: { state: core }\n    config:\n      idPrefix: demo\n" +
        (required
          ? '      labels: { required: [{ prefix: "area:" }, { oneOf: [p0, p1, p2, p3] }] }\n'
          : ""),
    );
  configure();
  let spawnCount = 0;
  function call<Op extends string>(
    op: Op,
    input: Record<string, unknown> = {},
    expected = 0,
    flags?: string[],
  ) {
    spawnCount++;
    const result = spawnSync(
      Bun.which("node")!,
      [cli, "issue", op, ...(flags ?? ["--input", JSON.stringify(input)])],
      {
        cwd: root,
        env: {
          ...process.env,
          FORGE_DEVICE_ROOT: join(root, "device"),
          FORGE_SESSION: "map-test",
        },
        encoding: "utf8",
        windowsHide: true,
        timeout: 10000,
      },
    );
    expect(result.error).toBeUndefined();
    if (expected === 0)
      expect(result.status, result.stdout + result.stderr).toBe(0);
    else expect(result.status, result.stdout + result.stderr).not.toBe(0);
    return JSON.parse(result.stdout) as {
      ok: boolean;
      result: Result<Op>;
      error: { code: string };
    };
  }
  return {
    root,
    call,
    configure,
    get spawnCount() {
      return spawnCount;
    },
  };
}
function projectWithIssues() {
  const { root, call, configure } = project();
  const epic = call("create", {
    title: "epic",
    kind: "epic",
    labels: ["area:tracker", "p1"],
  }).result;
  const one = call("create", {
    title: "one",
    kind: "task",
    labels: ["p1"],
    parent: epic.id,
  }).result;
  const two = call("create", {
    title: "two",
    kind: "bug",
    labels: ["area:tracker", "p1", "p2"],
  }).result;
  return { root, call, configure, epic, one, two };
}
test("built CLI updates parent with lease, revision, null, cycle and unknown-parent checks", () => {
  const { call, epic, one, two } = projectWithIssues();
  call("claim", { id: two.id });
  expect(
    call("update", { id: two.id, parent: epic.id, expectRevision: 1 }).result
      .parent,
  ).toBe(epic.id);
  expect(call("show", { id: two.id }).result.parent).toBe(epic.id);
  expect(
    call("update", { id: two.id, parent: null, expectRevision: 2 }).result,
  ).not.toHaveProperty("parent");
  expect(call("show", { id: two.id }).result).not.toHaveProperty("parent");
  expect(
    call("update", { id: two.id, parent: "demo-999", expectRevision: 3 }, 1)
      .error.code,
  ).toBe("NOT_FOUND");
  expect(
    call("update", { id: two.id, parent: epic.id, expectRevision: 1 }, 1).error
      .code,
  ).toBe("REVISION_CONFLICT");
  call("claim", { id: epic.id });
  expect(
    call("update", { id: epic.id, parent: one.id, expectRevision: 1 }, 1).error
      .code,
  ).toBe("INPUT_CONFLICT");
  expect(
    call("update", { id: one.id, parent: two.id, expectRevision: 1 }, 1).ok,
  ).toBe(false);
});
test("built CLI list returns exact ids for each filter and their AND combination", () => {
  const { call, epic, one, two } = projectWithIssues();
  for (const [input, ids] of [
    [{ parent: epic.id }, [one.id]],
    [{ parent: "none" }, [epic.id, two.id]],
    [{ kind: "bug" }, [two.id]],
    [{ label: ["area:tracker", "p2"] }, [two.id]],
    [{ parent: epic.id, kind: "bug", label: ["p1"] }, []],
    [
      {
        status: "open",
        parent: epic.id,
        kind: "task",
        label: ["p1"],
        createdSince: one.createdAt,
        limit: 1,
      },
      [one.id],
    ],
  ] as const)
    expect(
      call("list", input).result.items.map((i: TrackerItem) => i.id),
    ).toEqual([...ids]);
  expect(
    call("list", {}, 0, [
      "--parent",
      epic.id,
      "--kind",
      "task",
      "--label",
      JSON.stringify(["p1"]),
    ]).result.items.map((i: TrackerItem) => i.id),
  ).toEqual([one.id]);
});
test("built CLI tree shows counts, nesting, parentless and closed-parent issues", () => {
  const { call, epic, one, two } = projectWithIssues();
  const closed = call("create", { title: "closed", parent: epic.id }).result;
  call("claim", { id: closed.id });
  call("close", {
    id: closed.id,
    withoutReceipt: "disposable acceptance fixture",
  });
  const closedParent = call("create", {
    title: "closed parent",
    kind: "epic",
  }).result;
  const orphan = call("create", {
    title: "orphan",
    parent: closedParent.id,
  }).result;
  call("claim", { id: closedParent.id });
  call("close", {
    id: closedParent.id,
    withoutReceipt: "disposable acceptance fixture",
  });
  const result = call("tree").result;
  expect(result.items).toMatchObject([
    {
      item: { id: epic.id },
      openChildren: 1,
      closedChildren: 1,
      children: [{ item: { id: one.id } }],
    },
  ]);
  expect(result.parentless).toEqual({ count: 2, ids: [epic.id, two.id] });
  expect(result.closedParents).toEqual({ count: 1, ids: [orphan.id] });
  expect(call("tree", {}, 0, [epic.id]).result.items[0]!.item.id).toBe(epic.id);
});
test("built CLI lint reads required groups and default config stays silent", async () => {
  const fixture = project();
  const { root, call, configure } = fixture;
  const one = { id: "demo-1" };
  const two = { id: "demo-2" };
  const state = new LocalState(join(root, ".forge/state.sqlite"));
  try {
    const owner = (await state.open(true))!;
    for (const [id, labels] of [
      ["work-1", ["p1"]],
      ["work-2", ["area:tracker", "p1", "p2"]],
    ] as const)
      owner.put(
        "forge/work",
        `issue:${id}`,
        {
          id,
          title: id,
          status: "open",
          labels,
          dependsOn: [],
          createdAt: new Date(1000).toISOString(),
        },
        { kind: "agent", id: "test" },
        { expectRevision: 0 },
      );
  } finally {
    await state.close();
  }
  expect(call("lint").result.problems).toEqual([]);
  configure(true);
  const problems = call("lint").result.problems;
  expect(problems).toHaveLength(2);
  expect(
    problems.some(
      (p) => p.includes(one.id) && p.includes("area:") && p.includes("0"),
    ),
  ).toBe(true);
  expect(
    problems.some(
      (p) => p.includes(two.id) && p.includes("p0") && p.includes("2"),
    ),
  ).toBe(true);
  configure();
  expect(call("lint").result.problems).toEqual([]);
  expect(fixture.spawnCount).toBe(3);
});
