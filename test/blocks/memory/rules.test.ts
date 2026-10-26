import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { localCall } from "../../../src/assembly/index.ts";
import { runCli } from "../../../src/surface/cli.ts";
import type { ResultEnvelope } from "../../../src/generated/types.ts";
import {
  done,
  loadEntry,
  memoryState,
  openHarness,
  type Harness,
} from "./lib.ts";

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});
interface Pointer {
  text: { text: string };
}
const marker = "task PRIVATE_MEMORY_MARKER\v\f\u0085\u2028\u2029";

test("startup counts applicable scopes without text or ids in JSON or --text; commands retrieve on demand", async () => {
  harness = await openHarness(["memory"], { "memory.scope": "forge" });
  for (const [level, scope, tags] of [
    ["device", undefined, []],
    ["device", "general", ["rule"]],
    ["device", "forge", []],
    ["device", "another-project", ["rule"]],
    ["project", undefined, []],
    ["project", "general", []],
    ["project", "forge", ["rule"]],
    ["project", "another-project", []],
  ] as const)
    done(
      await harness.call("memory.add", {
        level,
        text: marker,
        tags,
        ...(scope === undefined ? {} : { scope }),
      }),
    );
  const forgotten = done(
    await harness.call("memory.add", {
      level: "device",
      text: marker,
      scope: "general",
    }),
  ) as { id: string };
  done(await harness.call("memory.forget", { id: forgotten.id }));
  const peer = await openHarness(
    ["memory"],
    {},
    { deviceRoot: harness.deviceRoot, project: "peer" },
  );
  try {
    done(
      await peer.call("memory.add", {
        level: "project",
        text: marker,
        scope: "general",
      }),
    );
  } finally {
    await peer.close();
  }
  const call = localCall(harness.assembly);
  const json = await runCli(
    harness.assembly.catalog,
    ["memory", "rules"],
    call,
  );
  const text = await runCli(
    harness.assembly.catalog,
    ["memory", "rules", "--text"],
    call,
  );
  const result = done(JSON.parse(json.stdout) as ResultEnvelope) as Pointer;
  expect(result.text.text).toContain("general: 3");
  expect(result.text.text).toContain("forge: 3");
  expect(result.text.text.length).toBeLessThan(400);
  for (const output of [json.stdout, text.stdout]) {
    expect(output).not.toContain("PRIVATE_MEMORY_MARKER");
    expect(output).not.toMatch(/(?:device|project\/[a-f0-9]+)\/note-\d+/);
    expect(output).not.toMatch(/[\v\f\u0085\u2028\u2029]/u);
  }
  expect(result.text.text).toContain("Search memory before starting a task.");
  const commands = [
    ...result.text.text.matchAll(
      new RegExp("forge memory (search|show) --input '([^']+)'", "g"),
    ),
  ];
  expect(commands.map((match) => match[1])).toEqual(["search", "show"]);
  const input: unknown = JSON.parse(commands[0]![2]!);
  const found = await runCli(
    harness.assembly.catalog,
    ["memory", "search", "--input", JSON.stringify(input)],
    call,
  );
  const hits = (
    done(JSON.parse(found.stdout) as ResultEnvelope) as {
      hits: { id: string }[];
    }
  ).hits;
  expect(hits.length).toBeGreaterThan(0);
  const shown = await runCli(
    harness.assembly.catalog,
    [
      "memory",
      "show",
      "--input",
      commands[1]![2]!.replace("<id>", hits[0]!.id),
    ],
    call,
  );
  expect(done(JSON.parse(shown.stdout) as ResultEnvelope)).toMatchObject({
    status: "found",
    note: { text: { text: marker } },
  });
  expect((await harness.call("memory.rules", { level: "device" })).ok).toBe(
    false,
  );
}, 60_000);

test("counts all live notes beyond the old scan ceiling and writes nothing", async () => {
  const state = memoryState();
  for (let n = 1; n <= 1201; n++)
    state.put(
      `note/${String(n).padStart(9, "0")}`,
      { text: marker, tags: [], links: [], previous: [], scope: "general" },
      { expectRevision: 0 },
    );
  const before = state.counts.put;
  const result = (await loadEntry("memory")["memory.rules"]!({
    config: { scope: "ignored-outside-project" },
    input: {},
    services: {
      state,
      levels: {
        inProject: false,
        project: () => {
          throw Error("must not open a project");
        },
        peer: () => {
          throw Error("must not open peers");
        },
      },
    },
  })) as Pointer;
  expect(result.text.text).toContain("general: 1201");
  expect(result.text.text).not.toContain("ignored-outside-project");
  expect(result.text.text).not.toContain("PRIVATE_MEMORY_MARKER");
  expect(result.text.text.length).toBeLessThan(400);
  expect(state.counts.put).toBe(before);
  expect(state.counts.putMany).toBe(0);
}, 30_000);

for (const [folder, scope] of [
  ["fresh-folder", "fresh-folder"],
  ["__..MyProj", "myproj"],
  ["!!!", undefined],
  ["general", "general"],
  ["a".repeat(64), "a".repeat(64)],
] as const) {
  test(`pointer uses normalized scope for ${folder} before identity exists without creating a store`, async () => {
    harness = await openHarness(["memory"], {}, { project: folder });
    const store = join(harness.root, ".forge", "state.sqlite");
    expect(existsSync(store)).toBe(false);
    const empty = done(await harness.call("memory.rules", {})) as Pointer;
    expect(empty.text.text).toContain("general: 0");
    if (scope !== undefined && scope !== "general")
      expect(empty.text.text).toContain(`${scope}: 0`);
    for (const noteScope of ["general", scope, "other-project"]) {
      if (noteScope !== undefined)
        done(
          await harness.call("memory.add", {
            level: "device",
            text: marker,
            scope: noteScope,
          }),
        );
    }
    const result = done(await harness.call("memory.rules", {})) as Pointer;
    expect(result.text.text).toContain(
      `general: ${scope === "general" ? 2 : 1}`,
    );
    if (scope !== undefined && scope !== "general")
      expect(result.text.text).toContain(`${scope}: 1`);
    expect(result.text.text).not.toContain("other-project");
    expect(result.text.text.length).toBeLessThan(400);
    expect(existsSync(store)).toBe(false);
  }, 60_000);
}
