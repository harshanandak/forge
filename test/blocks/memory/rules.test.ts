import { afterEach, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { localCall } from "../../../src/assembly/index.ts";
import { runCli } from "../../../src/surface/cli.ts";
import type { ResultEnvelope } from "../../../src/generated/types.ts";
import {
  ownerApproval,
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
const marker = "deploy PRIVATE_MEMORY_MARKER\v\f\u0085\u2028\u2029";

test("device memory uses the checkout scope without a project store", async () => {
  const state = memoryState(undefined, { defaultScope: "checkout-alias" });
  const entry = loadEntry("memory");
  const services = { state, levels: state };
  const config = { scope: "unavailable-project-override" };
  expect(await entry["memory.scope"]!({ input: {}, config, services })).toEqual(
    {
      scope: "checkout-alias",
    },
  );
  const added = (await entry["memory.add"]!({
    input: { level: "device", text: "checkout heron" },
    config,
    services,
  })) as { id: string; note: { scope?: string } };
  expect(added.note.scope).toBe("checkout-alias");
  const rules = (await entry["memory.rules"]!({
    input: {},
    config,
    services,
  })) as Pointer;
  expect(rules.text.text).toContain("general 0, checkout-alias 1.");
  const found = (await entry["memory.search"]!({
    input: { query: "heron" },
    services,
  })) as { hits: { id: string; scope?: string }[] };
  expect(found.hits).toMatchObject([{ id: added.id, scope: "checkout-alias" }]);
}, 30_000);

test("empty normalized folder uses general for scope, rules and new device notes", async () => {
  harness = await openHarness(["memory"], {}, { project: "你好" });
  expect(done(await harness.call("memory.scope", {}))).toEqual({
    scope: "general",
  });
  const empty = done(await harness.call("memory.rules", {})) as Pointer;
  expect(empty.text.text).toContain("general 0.");
  const added = done(
    await harness.call("memory.add", {
      level: "device",
      text: "emptyfolderneedle",
    }),
  ) as { id: string; note: { scope?: string } };
  expect(added.note.scope).toBe("general");
  const rules = done(await harness.call("memory.rules", {})) as Pointer;
  expect(rules.text.text).toContain("general 1.");
  const found = done(
    await harness.call("memory.search", {
      query: "emptyfolderneedle",
      scope: "general",
    }),
  ) as { hits: { id: string }[] };
  expect(found.hits.map((hit) => hit.id)).toEqual([added.id]);
}, 60_000);

test("unscoped device and project notes keep baseline order and scope labels", async () => {
  harness = await openHarness(["memory"]);
  writeFileSync(
    join(harness.deviceRoot, "memory-scopes.json"),
    JSON.stringify({ project: "shared" }),
  );
  const add = async (
    level: "device" | "project",
    text: string,
    scope?: string | null,
  ) =>
    done(
      await harness!.call("memory.add", {
        level,
        text,
        ...(scope === undefined ? {} : { scope }),
      }),
    ) as { id: string };
  const device = await add("device", "rankgeneralneedle", null);
  const project = await add("project", "rankprojectneedle");
  const foreignDevice = await add("device", "rankgeneralneedle", "foreign");
  const foreignProject = await add("device", "rankprojectneedle", "foreign");
  for (const [query, unscoped, foreign] of [
    ["rankgeneralneedle", device.id, foreignDevice.id],
    ["rankprojectneedle", project.id, foreignProject.id],
  ] as const) {
    const found = done(await harness.call("memory.search", { query })) as {
      hits: { id: string; scope?: string }[];
    };
    expect(found.hits.map((hit) => hit.id)).toEqual([foreign, unscoped]);
    expect(found.hits.map((hit) => hit.scope)).toEqual(["foreign", undefined]);
  }
}, 60_000);

test("alias changes between pages do not reorder or repeat baseline search results", async () => {
  harness = await openHarness(["memory"]);
  const alias = (scope: string) =>
    writeFileSync(
      join(harness!.deviceRoot, "memory-scopes.json"),
      JSON.stringify({ project: scope }),
    );
  alias("alpha");
  const ids: string[] = [];
  for (const scope of ["alpha", "beta"]) {
    const added = done(
      await harness.call("memory.add", {
        level: "device",
        scope,
        text: "paginationneedle",
      }),
    ) as { id: string };
    ids.push(added.id);
  }
  const first = done(
    await harness.call("memory.search", {
      query: "paginationneedle",
      limit: 1,
    }),
  ) as { hits: { id: string }[]; next: string };
  expect(first.next).toBe("3:1");
  alias("beta");
  expect(done(await harness.call("memory.scope", {}))).toEqual({
    scope: "beta",
  });
  const second = done(
    await harness.call("memory.search", {
      query: "paginationneedle",
      limit: 1,
      cursor: first.next,
    }),
  ) as { hits: { id: string }[]; next?: string };
  expect([...first.hits, ...second.hits].map((hit) => hit.id)).toEqual(
    [...ids].reverse(),
  );
  expect(second.next).toBeUndefined();
}, 60_000);

test("default search keeps legacy device and project scopes in baseline relevance order", async () => {
  harness = await openHarness(["memory"], {}, { project: "legacy" });
  const ids: string[] = [];
  for (const [level, scope] of [
    ["device", "prior-label"],
    ["project", "prior-label"],
    ["device", null],
    ["device", "general"],
    ["device", "legacy"],
  ] as const) {
    const added = done(
      await harness.call("memory.add", {
        level,
        scope,
        text:
          scope === "prior-label"
            ? "silverheronunique silverheronunique"
            : "silverheronunique",
      }),
    ) as { id: string };
    ids.push(added.id);
  }
  const search = async (extra: Record<string, unknown> = {}) =>
    done(
      await harness!.call("memory.search", {
        query: "silverheronunique",
        ...extra,
      }),
    ) as { hits: { id: string; scope?: string }[]; next?: string };
  const found = await search();
  expect(found.hits.map((hit) => hit.id).sort()).toEqual([...ids].sort());
  expect(found.hits.map((hit) => hit.id)).toEqual([
    ids[0]!,
    ids[1]!,
    ids[4]!,
    ids[3]!,
    ids[2]!,
  ]);
  expect(
    (await search({ scope: "prior-label" })).hits.map((hit) => hit.id).sort(),
  ).toEqual(ids.slice(0, 2).sort());
  const pages: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await search({
      limit: 1,
      ...(cursor === undefined ? {} : { cursor }),
    });
    pages.push(...page.hits.map((hit) => hit.id));
    cursor = page.next;
  } while (cursor !== undefined);
  expect(pages).toEqual(found.hits.map((hit) => hit.id));
  const rules = done(await harness.call("memory.rules", {})) as Pointer;
  expect(rules.text.text).toContain("prefer hits scoped legacy or general");
}, 60_000);

test("outside a project default search keeps existing scoped device notes in baseline order", async () => {
  const entry = loadEntry("memory");
  const state = memoryState();
  const services = { state, levels: state };
  for (const scope of ["general", "prior-label", null]) {
    await entry["memory.add"]!({
      input: { level: "device", text: "silverheronunique", scope },
      services,
    });
  }
  const found = (await entry["memory.search"]!({
    input: { query: "silverheronunique" },
    services,
  })) as { hits: { scope?: string }[] };
  expect(found.hits).toHaveLength(3);
  expect(found.hits.map((hit) => hit.scope)).toEqual([
    undefined,
    "prior-label",
    "general",
  ]);
  expect(found.hits.some((hit) => hit.scope === "prior-label")).toBe(true);
}, 30_000);

for (const [first, second, scope] of [
  ["forge-new", "forge", "forge"],
  ["litemed-workspace", "curapod", "curapod"],
] as const) {
  test(`aliases share rules, default adds and searches between ${first} and ${second}`, async () => {
    harness = await openHarness(["memory"], {}, { project: first });
    writeFileSync(
      join(harness.deviceRoot, "memory-scopes.json"),
      JSON.stringify({ [first]: scope, [second]: scope }),
    );
    const peer = await openHarness(
      ["memory"],
      {},
      { deviceRoot: harness.deviceRoot, project: second },
    );
    try {
      for (const current of [harness, peer]) {
        const rules = done(await current.call("memory.rules", {})) as Pointer;
        expect(rules.text.text).toContain(`general 0, ${scope} 0.`);
        expect(existsSync(join(current.root, ".forge/state.sqlite"))).toBe(
          false,
        );
      }
      const added = done(
        await harness.call("memory.add", {
          level: "device",
          text: "shared alias heron checklist",
        }),
      ) as { id: string; note: { scope?: string } };
      expect(added.note.scope).toBe(scope);
      for (const [text, noteScope] of [
        ["general alias heron checklist", "general"],
        ["foreign alias heron checklist", "unrelated"],
      ])
        done(
          await peer.call("memory.add", {
            level: "device",
            text,
            scope: noteScope,
          }),
        );
      for (const current of [harness, peer]) {
        const found = done(
          await current.call("memory.search", { query: "heron" }),
        ) as {
          hits: { id: string; scope?: string }[];
        };
        expect(found.hits.map((hit) => hit.scope).sort()).toEqual(
          ["general", scope, "unrelated"].sort(),
        );
        expect(found.hits.map((hit) => hit.scope)).toEqual([
          "unrelated",
          "general",
          scope,
        ]);
        expect(found.hits.some((hit) => hit.id === added.id)).toBe(true);
        expect(done(await current.call("memory.scope", {}))).toEqual({ scope });
        const rules = done(await current.call("memory.rules", {})) as Pointer;
        expect(rules.text.text).toContain(`general 1, ${scope} 1.`);
      }
    } finally {
      await peer.close();
    }
  }, 60_000);
}

test("repo scope overrides aliases for rules, new notes and default search; explicit scopes and edits survive", async () => {
  harness = await openHarness(["memory"], { "memory.scope": "repo:override" });
  writeFileSync(
    join(harness.deviceRoot, "memory-scopes.json"),
    JSON.stringify({ project: "alias" }),
  );
  const added = done(
    await harness.call("memory.add", {
      level: "device",
      text: "override kestrel",
    }),
  ) as { id: string; note: { scope?: string } };
  expect(added.note.scope).toBe("repo:override");
  expect(done(await harness.call("memory.scope", {}))).toEqual({
    scope: "repo:override",
  });
  for (const scope of ["alias", "general", null]) {
    done(
      await harness.call("memory.add", {
        level: "device",
        scope,
        text: "override kestrel",
      }),
    );
  }
  const found = done(
    await harness.call("memory.search", { query: "kestrel" }),
  ) as { hits: { scope?: string }[] };
  expect(found.hits.map((hit) => hit.scope).sort()).toEqual(
    ["alias", "general", "repo:override", undefined].sort(),
  );
  const explicit = done(
    await harness.call("memory.search", { query: "kestrel", scope: "alias" }),
  ) as { hits: { scope: string }[] };
  expect(explicit.hits.map((hit) => hit.scope)).toEqual(["alias"]);
  const edited = done(
    await harness.call("memory.add", {
      id: "device/note-2",
      expectRevision: 1,
      text: "edited kestrel",
    }),
  ) as { note: { scope?: string } };
  expect(edited.note.scope).toBe("alias");
  const unscoped = done(
    await harness.call("memory.add", {
      id: "device/note-4",
      expectRevision: 1,
      text: "edited unscoped kestrel",
    }),
  ) as { note: { scope?: string } };
  expect(unscoped.note.scope).toBeUndefined();
  writeFileSync(join(harness.deviceRoot, "memory-scopes.json"), "invalid JSON");
  expect(done(await harness.call("memory.scope", {}))).toEqual({
    scope: "repo:override",
  });
}, 60_000);

test("scope aliases are re-read and invalid maps refuse before saving a note", async () => {
  harness = await openHarness(["memory"]);
  const aliases = join(harness.deviceRoot, "memory-scopes.json");
  expect(done(await harness.call("memory.scope", {}))).toEqual({
    scope: "project",
  });
  expect(existsSync(aliases)).toBe(false);
  for (const scope of ["alpha", "beta"]) {
    writeFileSync(aliases, JSON.stringify({ project: scope }));
    expect(done(await harness.call("memory.scope", {}))).toEqual({ scope });
  }
  for (const invalid of [
    "invalid JSON",
    "[]",
    "null",
    JSON.stringify({ project: "UPPER" }),
    JSON.stringify({ project: 7 }),
  ]) {
    writeFileSync(aliases, invalid);
    for (const [op, input] of [
      ["memory.scope", {}],
      ["memory.rules", {}],
      ["memory.add", { level: "device", text: "must not be saved" }],
    ] as const) {
      const result = await harness.call(op, input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("INPUT_INVALID");
    }
  }
  expect(
    done(await harness.call("memory.export", { level: "device" })),
  ).toMatchObject({ notes: [], count: 0 });
  expect(existsSync(join(harness.root, ".forge/state.sqlite"))).toBe(false);
  const explicit = done(
    await harness.call("memory.add", {
      level: "device",
      scope: "explicit",
      text: "explicit heron",
    }),
  ) as { id: string };
  const found = done(
    await harness.call("memory.search", { scope: "explicit", query: "heron" }),
  ) as { hits: { id: string }[] };
  expect(found.hits.map((hit) => hit.id)).toEqual([explicit.id]);
  const defaults = done(
    await harness.call("memory.search", { query: "heron" }),
  ) as { hits: { id: string }[] };
  expect(defaults.hits.map((hit) => hit.id)).toEqual([explicit.id]);
}, 60_000);

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
        scope: scope ?? null,
      }),
    );
  const forgotten = done(
    await harness.call("memory.add", {
      level: "device",
      text: marker,
      scope: "general",
    }),
  ) as { id: string };
  done(
    await harness.call("memory.forget", {
      approval: ownerApproval,
      id: forgotten.id,
    }),
  );
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
  expect(result.text.text.length).toBeLessThan(400);
  for (const output of [json.stdout, text.stdout]) {
    expect(output).not.toContain("PRIVATE_MEMORY_MARKER");
    expect(output).not.toMatch(/(?:device|project\/[a-f0-9]+)\/note-\d+/);
    expect(output).not.toMatch(/[\v\f\u0085\u2028\u2029]/u);
  }
  expect(result.text.text).toContain('forge memory search "<topic>"');
  expect(result.text.text).toContain("forge memory show <id>");
  expect(result.text.text).not.toContain("--input");
  const found = await runCli(
    harness.assembly.catalog,
    ["memory", "search", "deploy"],
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
    ["memory", "show", hits[0]!.id],
    call,
  );
  expect(done(JSON.parse(shown.stdout) as ResultEnvelope)).toMatchObject({
    status: "found",
    note: { text: { text: marker } },
  });
  expect(result.text.text).toContain("general 3, forge 3.");
  expect((await harness.call("memory.rules", { level: "device" })).ok).toBe(
    false,
  );
}, 60_000);

test("pointer prefers the resolved scope and general without excluding other notes", async () => {
  harness = await openHarness(["memory"], { "memory.scope": "forge" });
  const result = done(await harness.call("memory.rules", {})) as Pointer;
  expect(result.text.text).toContain(
    "Before a task, search memory for its topic",
  );
  expect(result.text.text).toContain("prefer hits scoped forge or general");
  expect(result.text.text).not.toContain("1 notes");
}, 60_000);

test("counts every note through bounded pages without a scan ceiling or writes", async () => {
  const state = memoryState();
  for (let n = 1; n <= 17001; n++)
    state.put(
      `note/${String(n).padStart(9, "0")}`,
      { text: marker, tags: [], links: [], previous: [], scope: "general" },
      { expectRevision: 0 },
    );
  const before = state.counts.put;
  const pages: Parameters<typeof state.listRange>[0][] = [];
  const result = (await loadEntry("memory")["memory.rules"]!({
    config: { scope: "ignored-outside-project" },
    input: {},
    services: {
      state: {
        ...state,
        listRange(options: Parameters<typeof state.listRange>[0]) {
          pages.push(options);
          return state.listRange(options);
        },
      },
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
  expect(pages.length).toBeGreaterThan(1);
  expect(pages.every((page) => page.limit <= 1000)).toBe(true);
  expect(state.counts.listedRecords).toBe(17001);
  expect(result.text.text).toContain("general 17001.");
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
    expect(done(await harness.call("memory.scope", {}))).toEqual({
      scope: scope ?? "general",
    });
    expect(empty.text.text).toContain("general 0");
    if (scope !== undefined && scope !== "general")
      expect(empty.text.text).toContain(`${scope} 0`);
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
      `general ${scope === "general" ? 2 : 1}`,
    );
    if (scope !== undefined && scope !== "general")
      expect(result.text.text).toContain(`${scope} 1`);
    expect(result.text.text).not.toContain("other-project");
    expect(result.text.text.length).toBeLessThan(400);
    expect(existsSync(store)).toBe(false);
  }, 60_000);
}
