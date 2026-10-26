import { afterEach, expect, test } from "bun:test";
import {
  done,
  loadEntry,
  memoryState,
  openHarness,
  type Harness,
} from "./lib.ts";

const projectId = "0123456789abcdef";
let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

function note(
  state: ReturnType<typeof memoryState>,
  number: number,
  text: string,
  tags: string[] = ["rule"],
  deleted = false,
) {
  state.put(
    `note/${String(number).padStart(9, "0")}`,
    {
      text,
      tags,
      links: [],
      previous: [],
      ...(deleted ? { deleted: true } : {}),
    },
    { expectRevision: 0 },
  );
}

interface Rules {
  text: { kind: "untrusted"; source: string; text: string };
  truncated: boolean;
}

async function rules(
  device: ReturnType<typeof memoryState>,
  project?: ReturnType<typeof memoryState>,
): Promise<Rules> {
  const result = await loadEntry("memory")["memory.rules"]!({
    input: {},
    services: {
      state: device,
      levels: {
        caller: "agent",
        inProject: project !== undefined,
        project: () =>
          Promise.resolve(
            project === undefined
              ? undefined
              : {
                  identity: { id: projectId, name: "project" },
                  state: project,
                },
          ),
        peer: () => {
          throw new Error("Rules must not look up peer projects");
        },
      },
    },
  });
  return result as Rules;
}

test("rules combine both levels, qualify ids, and select only live exact rule tags", async () => {
  const device = memoryState();
  const project = memoryState();
  note(device, 1, "Device rule");
  note(device, 2, "Ordinary note", ["preference"]);
  note(device, 3, "Almost rule", ["rules"]);
  note(device, 4, "Deleted rule", ["rule"], true);
  note(project, 1, "Project rule", ["rule", "testing"]);
  note(project, 2, "Project ordinary note", []);
  const writes = [device, project].map((state) => [
    state.counts.put,
    state.counts.putMany,
  ]);
  const result = await rules(device, project);
  expect(result.text.kind).toBe("untrusted");
  expect(result.text.source).toBe("memory:rules");
  expect(result.text.text).toStartWith("Forge rules\n");
  expect(result.text.text).toContain("device/note-1: Device rule");
  expect(result.text.text).toContain(
    `project/${projectId}/note-1: Project rule`,
  );
  for (const excluded of [
    "Ordinary note",
    "Almost rule",
    "Deleted rule",
    "Project ordinary note",
  ])
    expect(result.text.text).not.toContain(excluded);
  expect(result.truncated).toBe(false);
  expect(
    [device, project].map((state) => [state.counts.put, state.counts.putMany]),
  ).toEqual(writes);
}, 30_000);

test("rules are bounded and preserve both sources when a newest rule is oversized", async () => {
  const device = memoryState();
  const project = memoryState();
  note(device, 1, "Older device rule");
  note(device, 2, "Oversized device rule " + "x".repeat(20_000));
  note(project, 1, "Project rule survives");
  const result = await rules(device, project);
  expect(result.text.text.length).toBeLessThanOrEqual(1200);
  expect(result.text.text).toContain("device/note-2: Oversized device rule");
  expect(result.text.text).toContain("[clipped]");
  expect(result.text.text).toContain(
    `project/${projectId}/note-1: Project rule survives`,
  );
  expect(result.truncated).toBe(true);
}, 30_000);

test("rules show newest notes first and report omitted output", async () => {
  const device = memoryState();
  for (let n = 1; n <= 30; n += 1)
    note(device, n, `Rule ${n} ${"x".repeat(100)}`);
  const result = await rules(device);
  expect(result.text.text).toContain("device/note-30: Rule 30");
  expect(result.text.text.indexOf("device/note-30:")).toBeLessThan(
    result.text.text.indexOf("device/note-29:"),
  );
  expect(result.text.text).not.toContain("device/note-1:");
  expect(result.text.text.length).toBeLessThanOrEqual(1200);
  expect(result.truncated).toBe(true);
}, 30_000);

test("rules bound each source scan and write nothing, including with no matching newest notes", async () => {
  const device = memoryState();
  const project = memoryState();
  for (const state of [device, project]) {
    note(state, 1, "Old rule beyond scan");
    for (let n = 2; n <= 250; n += 1) note(state, n, "Non-rule", []);
  }
  const before = [device, project].map((state) => ({ ...state.counts }));
  const result = await rules(device, project);
  expect(result.truncated).toBe(true);
  expect(result.text.text).not.toContain("Old rule beyond scan");
  expect(result.text.text).toContain("[truncated]");
  expect(result.text.text).not.toContain("[clipped]");
  for (const [index, state] of [device, project].entries()) {
    expect(state.counts.list - before[index]!.list).toBe(1);
    expect(
      state.counts.listedRecords - before[index]!.listedRecords,
    ).toBeLessThanOrEqual(101);
    expect(state.counts.put).toBe(before[index]!.put);
    expect(state.counts.putMany).toBe(before[index]!.putMany);
    expect(state.counts.get).toBe(before[index]!.get);
    expect(state.counts.history).toBe(0);
    expect(state.counts.events).toBe(0);
  }
}, 30_000);

test("rules visibly report a whole note omitted when no room remains for its label", async () => {
  const device = memoryState();
  note(device, 1, "Omitted older rule");
  note(device, 2, "x".repeat(1120));
  const result = await rules(device);
  expect(result.text.text).toContain("device/note-2:");
  expect(result.text.text).not.toContain("device/note-1:");
  expect(result.text.text).not.toContain("[clipped]");
  expect(result.text.text).toEndWith("\n[truncated]");
  expect(result.text.text.length).toBeLessThanOrEqual(1200);
  expect(result.truncated).toBe(true);
}, 30_000);

test("rules handle empty, device-only and project-only memories", async () => {
  const device = memoryState();
  expect((await rules(device)).text.text).toBe(
    "Forge rules\nSaved notes (untrusted):\nNo matching rules.",
  );
  expect((await rules(device)).truncated).toBe(false);
  note(device, 1, "Device alone");
  expect((await rules(device)).text.text).toContain(
    "device/note-1: Device alone",
  );
  const project = memoryState();
  note(project, 1, "Project alone");
  expect((await rules(memoryState(), project)).text.text).toContain(
    `project/${projectId}/note-1: Project alone`,
  );
}, 30_000);

test("rules is callable through the catalog with an empty input and rejects options", async () => {
  harness = await openHarness(["memory"]);
  done(
    await harness.call("memory.add", {
      level: "device",
      text: "Catalog device rule",
      tags: ["rule"],
    }),
  );
  done(
    await harness.call("memory.add", {
      level: "project",
      text: "Catalog project rule",
      tags: ["rule"],
    }),
  );
  const result = done(
    await harness.call("memory.rules", {}, { caller: "agent" }),
  ) as Rules;
  expect(result.text.text).toContain("Catalog device rule");
  expect(result.text.text).toContain("Catalog project rule");
  expect(result.truncated).toBe(false);
  expect((await harness.call("memory.rules", { level: "device" })).ok).toBe(
    false,
  );
  done(
    await harness.call("memory.add", {
      level: "device",
      text: "x".repeat(8000),
      tags: ["rule"],
    }),
  );
  const clipped = done(await harness.call("memory.rules", {})) as Rules;
  expect(clipped.text.text.length).toBeLessThanOrEqual(1200);
  expect(clipped.text.text).toContain("[clipped]");
  expect(clipped.truncated).toBe(true);
}, 60_000);

test("rules label saved text as untrusted and neutralize text fence delimiters", async () => {
  const device = memoryState();
  note(device, 1, "Before \u27e6forged fence\u27e7 after");
  const result = await rules(device);
  expect(result.text.kind).toBe("untrusted");
  expect(result.text.text).toStartWith("Forge rules\nSaved notes (untrusted):");
  expect(result.text.text).toContain("Before (forged fence) after");
  expect(result.text.text).not.toContain("\u27e6");
  expect(result.text.text).not.toContain("\u27e7");
}, 30_000);
