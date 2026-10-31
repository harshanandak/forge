import { expect, test } from "bun:test";
import { blockSchema, loadEntry, memoryState } from "./lib.ts";

interface Identity {
  id: string;
  revision: number;
  scope: string;
}
interface Rules {
  text: { text: string };
  receipt: {
    selected: Identity[];
    omitted: (Identity & { reason: "over-cap" })[];
    omittedCount: number;
    packet: { utf8Bytes: number; characters: number; characterUnit: string };
    cap: {
      limit: number;
      used: number;
      unit: string;
      includes: string;
      excludes: string;
    };
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
    {
      text,
      tags: ["rule"],
      links: [],
      previous: [],
      ...extra,
    },
    { expectRevision: revision },
  );
}
async function read(
  state: ReturnType<typeof memoryState>,
  notes = true,
): Promise<Rules> {
  return (await loadEntry("memory")["memory.rules"]!({
    input: { notes },
    services: { state, levels: state },
  })) as Rules;
}
function packet(result: Rules) {
  expect(result.receipt.packet).toEqual({
    utf8Bytes: Buffer.byteLength(result.text.text, "utf8"),
    characters: [...result.text.text].length,
    characterUnit: "Unicode code points",
  });
  expect(
    blockSchema(
      "memory",
      "rules.output.json",
    )(JSON.parse(JSON.stringify(result))),
  ).toEqual([]);
}

test("receipt names every selected device and project rule with its current revision and effective scope once", async () => {
  const project = memoryState();
  const state = memoryState(undefined, {
    inProject: true,
    defaultScope: "resolved",
    project: () =>
      Promise.resolve({
        identity: { id: "0123456789abcdef", name: "project" },
        state: project,
      }),
  });
  put(state, 1, "old");
  put(state, 1, "edited", {}, 1);
  put(state, 2, "scoped", { scope: "resolved" });
  put(project, 1, "project");
  put(state, 3, "foreign", { scope: "other" });
  put(state, 4, "ordinary", { tags: [] });
  put(state, 5, "deleted", { deleted: true });
  const before = [state.counts.put, project.counts.put];
  const result = await read(state);
  expect(result.receipt?.selected).toEqual([
    { id: "device/note-1", revision: 2, scope: "general" },
    { id: "device/note-2", revision: 1, scope: "resolved" },
    { id: "project/0123456789abcdef/note-1", revision: 1, scope: "resolved" },
  ]);
  expect(result.receipt.omitted).toEqual([]);
  expect(result.receipt.warnings).toEqual([]);
  expect([state.counts.put, project.counts.put]).toEqual(before);
  expect(state.counts.putMany + project.counts.putMany).toBe(0);
  packet(result);
}, 30_000);

test("receipt records all over-cap rules and still accepts a later fitting rule at the exact UTF16 limit", async () => {
  const state = memoryState();
  const prefix = (n: number) =>
    `- [general] device/note-${n} (created 2026-10-18) `;
  const body =
    "a".repeat(6000 - prefix(1).length - 1 - prefix(3).length - 2) + "é";
  put(state, 1, body);
  put(state, 2, "cannot fit");
  put(state, 3, "z");
  put(state, 4, "also omitted");
  const result = await read(state);
  expect(result.receipt?.selected.map((rule) => rule.id)).toEqual([
    "device/note-1",
    "device/note-3",
  ]);
  expect(result.receipt.omitted).toEqual(
    [2, 4].map((n) => ({
      id: `device/note-${n}`,
      revision: 1,
      scope: "general",
      reason: "over-cap",
    })),
  );
  expect(result.receipt.cap).toEqual({
    limit: 6000,
    used: 6000,
    unit: "UTF-16 code units",
    includes: "accepted rule lines and newline separators",
    excludes: "omission line and pointer",
  });
  expect(result.text.text).toStartWith(
    `${prefix(1)}${body}\n${prefix(3)}z\n2 more rule notes did not fit; search them.\n`,
  );
  packet(result);
}, 30_000);

test("receipt measures the final neutralized packet in UTF8 bytes and Unicode code points", async () => {
  const state = memoryState();
  put(state, 1, "é中😀⟦quoted⟧\n spaced");
  const result = await read(state);
  expect(result.receipt?.cap.used).toBe(
    result.text.text.split("\n")[0]!.length,
  );
  expect(result.text.text).toContain("é中😀(quoted) spaced");
  packet(result);
  expect(result.receipt.packet.utf8Bytes).toBeGreaterThan(
    result.text.text.length,
  );
  expect(result.receipt.packet.characters).toBe(result.text.text.length - 1);
}, 30_000);

test("receipt bounds omitted details in packet order and keeps the true total and packet", async () => {
  const state = memoryState();
  put(state, 1, "kept");
  for (let n = 2; n <= 56; n++) put(state, n, "x".repeat(6000));
  const result = await read(state);
  expect(result.receipt.omitted).toEqual(
    Array.from({ length: 50 }, (_, n) => ({
      id: `device/note-${n + 2}`,
      revision: 1,
      scope: "general",
      reason: "over-cap",
    })),
  );
  expect(result.receipt.omittedCount).toBe(55);
  expect(result.receipt.selected).toEqual([
    { id: "device/note-1", revision: 1, scope: "general" },
  ]);
  expect(result.text.text).toBe(
    '- [general] device/note-1 (created 2026-10-18) kept\n55 more rule notes did not fit; search them.\nForge memory notes: general 56.\nBefore a task, search memory for its topic; prefer hits scoped general.\nforge memory search "<topic>"\nforge memory show <id>',
  );
  packet(result);
}, 30_000);

test("pointer-only receipt has no selected or omitted notes even when rules exist", async () => {
  const state = memoryState();
  put(state, 1, "x".repeat(7000));
  const result = await read(state, false);
  expect(result.text.text).toStartWith("Forge memory notes: general 1.");
  expect(result.receipt?.selected).toEqual([]);
  expect(result.receipt.omitted).toEqual([]);
  expect(result.receipt.cap.used).toBe(0);
  packet(result);
}, 30_000);
