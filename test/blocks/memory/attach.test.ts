import { expect, test } from "bun:test";
import { blockSchema, loadEntry, memoryState } from "./lib.ts";

interface Identity {
  id: string;
  revision: number;
  scope: string;
}
interface Attached {
  text: { kind: string; source: string; text: string };
  receipt: {
    selected: (Identity & { reasons: string[] })[];
    omitted: (Identity & { reason: string })[];
    packet: { utf8Bytes: number; characters: number; characterUnit: string };
    cap: { limit: number; used: number; unit: string };
    warnings: { code: string; message: string }[];
  };
}
function put(
  state: ReturnType<typeof memoryState>,
  n: number,
  text: string,
  extra = {},
  revision = 0,
) {
  state.put(
    `note/${String(n).padStart(9, "0")}`,
    { text, tags: ["on:memory"], links: [], previous: [], ...extra },
    { expectRevision: revision },
  );
}
async function attach(
  state: ReturnType<typeof memoryState>,
  input: unknown = {},
): Promise<Attached> {
  const entry = loadEntry("memory");
  expect(Object.keys(entry)).toContain("memory.attach");
  const result = (await entry["memory.attach"]!({
    input,
    services: { state, levels: state },
  })) as Attached;
  expect(
    blockSchema("memory", "attach.output.json", ["rules.output.json"])(
      JSON.parse(JSON.stringify(result)),
    ),
  ).toEqual([]);
  expect(result.text).toMatchObject({
    kind: "untrusted",
    source: "memory:attach",
  });
  expect(result.receipt.packet).toEqual({
    utf8Bytes: Buffer.byteLength(result.text.text),
    characters: [...result.text.text].length,
    characterUnit: "Unicode code points",
  });
  expect(result.receipt.cap.used).toBe(Buffer.byteLength(result.text.text));
  return result;
}

test("later paths attach new notes once, labels match exactly, and edited revisions return", async () => {
  const state = memoryState();
  put(state, 1, "memory note");
  put(state, 2, "docs note", { tags: ["on:docs"] });
  put(state, 3, "no substring match", { tags: ["on:mem"] });
  const first = await attach(state, { paths: ["src/blocks/MEMORY/index.cts"] });
  expect(first.receipt.selected).toEqual([
    {
      id: "device/note-1",
      revision: 1,
      scope: "general",
      reasons: ["on:memory"],
    },
  ]);
  const second = await attach(state, {
    paths: ["src\\blocks\\memory\\index.cts", "docs/guide.md"],
    seen: first.receipt.selected,
  });
  expect(second.receipt.selected.map((n) => n.id)).toEqual(["device/note-2"]);
  expect(second.receipt.omitted).toEqual([
    { id: "device/note-1", revision: 1, scope: "general", reason: "seen" },
  ]);
  expect(
    (await attach(state, { labels: ["MEMORY"] })).receipt.selected,
  ).toEqual(first.receipt.selected);
  put(state, 1, "edited memory", {}, 1);
  expect(
    (await attach(state, { labels: ["memory"], seen: first.receipt.selected }))
      .receipt.selected[0]?.revision,
  ).toBe(2);
  expect((await attach(state)).receipt.selected).toEqual([]);
}, 30_000);

test("only rules scopes and levels apply even to asked ids, with asked order then scope and note number", async () => {
  const project = memoryState();
  const state = memoryState(undefined, {
    inProject: true,
    defaultScope: "forge",
    project: () =>
      Promise.resolve({
        identity: { id: "0123456789abcdef", name: "forge" },
        state: project,
      }),
    peer: () => {
      throw new Error("must not read a peer");
    },
  });
  put(state, 1, "project scope", { scope: "forge" });
  put(state, 2, "general");
  put(project, 1, "unscoped project");
  put(project, 2, "general in project", { scope: "general" });
  put(state, 3, "foreign", { scope: "other" });
  put(state, 4, "forgotten", { deleted: true });
  put(state, 5, "explicit only", { tags: [] });
  const result = await attach(state, {
    ids: [
      "device/note-5",
      "device/note-1",
      "device/note-5",
      "device/note-3",
      "device/note-4",
      "project/1111111111111111/note-1",
    ],
    labels: ["memory"],
  });
  expect(result.receipt.selected.map((n) => n.id)).toEqual([
    "device/note-5",
    "device/note-1",
    "device/note-2",
    "project/0123456789abcdef/note-2",
    "project/0123456789abcdef/note-1",
  ]);
  expect(result.receipt.selected[1]?.reasons).toEqual(["asked", "on:memory"]);
  expect(result.text.text).not.toContain("foreign");
  expect(result.text.text).not.toContain("forgotten");
}, 30_000);

test("whole neutralized UTF8 lines fit exactly; oversized matches are named and asked notes warn", async () => {
  const state = memoryState();
  const prefix = "- [general] device/note-1 (created 2026-10-18) ";
  const text =
    "é".repeat(Math.floor((4096 - Buffer.byteLength(prefix)) / 2)) +
    "a".repeat((4096 - Buffer.byteLength(prefix)) % 2);
  put(state, 1, text);
  put(state, 2, "over budget");
  const exact = await attach(state, { labels: ["memory"] });
  expect(exact.receipt.cap).toMatchObject({
    limit: 4096,
    used: 4096,
    unit: "UTF-8 bytes",
  });
  expect(exact.receipt.omitted).toEqual([
    {
      id: "device/note-2",
      revision: 1,
      scope: "general",
      reason: "over-budget",
    },
  ]);
  put(state, 1, "😀⟦中⟧".repeat(1000), {}, 1);
  const skipped = await attach(state, { paths: ["file.memory"] });
  expect(skipped.receipt.selected.map((n) => n.id)).toEqual(["device/note-2"]);
  const asked = await attach(state, { ids: ["device/note-1"] });
  expect(asked.receipt.selected[0]?.reasons).toEqual(["asked"]);
  expect(asked.receipt.cap.used).toBeGreaterThan(4096);
  expect(asked.receipt.warnings).toHaveLength(1);
  expect(asked.receipt.warnings[0]?.message).toContain("device/note-1");
  expect(asked.text.text).toContain("😀(中)");
}, 30_000);

test("attach preserves rules output byte for byte and never writes state", async () => {
  const state = memoryState(undefined, {
    warnings: [{ code: "HOST_WARNING", message: "host warning" }],
  });
  put(state, 1, "rule memory", { tags: ["rule", "on:memory"] });
  const rules = () =>
    loadEntry("memory")["memory.rules"]!({
      input: { notes: true },
      services: { state, levels: state },
    });
  const before = JSON.stringify(await rules());
  const writes = [state.counts.put, state.counts.putMany];
  const first = await attach(state, { labels: ["memory"] });
  await attach(state, { ids: ["device/note-1"], seen: first.receipt.selected });
  expect(first.receipt.warnings).toEqual([
    { code: "HOST_WARNING", message: "host warning" },
  ]);
  expect(JSON.stringify(await rules())).toBe(before);
  expect([state.counts.put, state.counts.putMany]).toEqual(writes);
}, 30_000);

test("attachment scans beyond the first page and ignores empty path segments", async () => {
  const state = memoryState();
  for (let n = 1; n <= 205; n++) put(state, n, "irrelevant", { tags: [] });
  put(state, 206, "late match");
  put(state, 207, "empty signal", { tags: ["on:"] });
  const result = await attach(state, { paths: ["/src//memory/index.cts"] });
  expect(result.receipt.selected.map((note) => note.id)).toEqual([
    "device/note-206",
  ]);
}, 30_000);
