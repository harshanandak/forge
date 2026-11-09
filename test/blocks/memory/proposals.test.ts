import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  blockSchema,
  done,
  loadEntry,
  memoryState,
  openHarness,
  ownerApproval,
  type Harness,
} from "./lib.ts";

setDefaultTimeout(30_000);

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

interface Item {
  id: string;
  revision: number;
  kind: string;
  level: string;
  scope?: string;
  tags: string[];
  text: { kind: string; text: string };
  proposedBy: { kind: string; id: string };
  proposedAt: string;
}
interface Queue {
  total: number;
  returned: number;
  next?: number;
  groups: { items: Item[] }[];
}
function setup() {
  const entry = loadEntry("memory");
  const state = memoryState();
  const services = { state, levels: state };
  const call = <T = Record<string, never>>(op: string, input: unknown) =>
    entry[op]!({ input, services }) as Promise<T>;
  const queue = (input: object = {}) => call<Queue>("memory.proposals", input);
  return { call, queue, state };
}
type Call = ReturnType<typeof setup>["call"];
const propose = (call: Call, text: string, tags = ["rule"]) =>
  call<{ id: string; note: { revision: number } }>("memory.add", {
    level: "device",
    text,
    tags,
  });
const ids = (queue: Queue) =>
  queue.groups.flatMap((group) => group.items.map((item) => item.id));
/** What the owner is shown, as memory.accept takes it. */
const acceptItems = (queue: Queue) =>
  queue.groups.flatMap((group) =>
    group.items.map(({ id, revision, text }) => ({
      id,
      revision,
      text: text.text,
    })),
  );

test("an empty queue returns nothing", async () => {
  const { queue } = setup();
  expect(await queue()).toEqual({ total: 0, returned: 0, groups: [] });
});

test("a batch is at most 10 items and 7 by default, and next continues it", async () => {
  const { call, queue } = setup();
  for (let i = 1; i <= 12; i += 1)
    await propose(call, `Rule number ${i} says something of its own ${i}.`);
  const first = await queue();
  expect(first).toMatchObject({ total: 12, returned: 7, next: 7 });
  expect(ids(first)).toHaveLength(7);
  const wide = await queue({ limit: 10 });
  expect(wide).toMatchObject({ total: 12, returned: 10, next: 10 });
  const rest = await queue({ skip: 7 });
  expect(rest).toMatchObject({ total: 12, returned: 5 });
  expect(rest.next).toBeUndefined();
  expect(new Set([...ids(first), ...ids(rest)]).size).toBe(12);
  // The input schema never allows a batch over 10.
  const valid = blockSchema("memory", "proposals.input.json");
  expect(valid({ limit: 10 })).toEqual([]);
  expect(valid({ limit: 11 })).not.toEqual([]);
  expect(valid({ limit: 0 })).not.toEqual([]);
});

test("similar proposals are grouped and unrelated ones stand alone", async () => {
  const { call, queue } = setup();
  const one = await propose(call, "Write the test first.");
  const other = await propose(call, "Merge only when hosted CI is green.");
  const two = await propose(call, "write the test first");
  const three = await propose(call, "Write the test first!");
  const batch = await queue();
  expect(batch.groups.map((group) => group.items.map((i) => i.id))).toEqual([
    [one.id, two.id, three.id],
    [other.id],
  ]);
});

test("every item carries what memory.accept needs and is valid input for it", async () => {
  const { call, queue } = setup();
  await propose(call, "Write the test first.", ["rule", "testing"]);
  await propose(call, "Merge only when hosted CI is green.", ["decision"]);
  const batch = await queue();
  const [item] = batch.groups[0]!.items;
  expect(item).toMatchObject({
    id: "device/note-1",
    revision: 1,
    kind: "note",
    level: "device",
    tags: ["rule", "testing"],
    text: { kind: "untrusted", text: "Write the test first." },
    proposedBy: { kind: "agent", id: "a" },
  });
  expect(typeof item!.proposedAt).toBe("string");
  const shown = await call<{ note: { createdAt: string } }>("memory.show", {
    id: item!.id,
  });
  expect(item!.proposedAt).toBe(shown.note.createdAt);
  expect(
    blockSchema(
      "memory",
      "proposals.output.json",
    )(JSON.parse(JSON.stringify(batch))),
  ).toEqual([]);

  expect(
    await call("memory.accept", {
      items: acceptItems(batch),
      approval: ownerApproval,
    }),
  ).toEqual({
    results: [
      { id: "device/note-1", status: "accepted" },
      { id: "device/note-2", status: "accepted" },
    ],
  });
  expect(await queue()).toEqual({ total: 0, returned: 0, groups: [] });
});

test("a pending revision of an accepted note is listed with its proposed text", async () => {
  const { call, queue } = setup();
  const rule = await propose(call, "use bun");
  const first = await queue();
  await call("memory.accept", {
    items: acceptItems(first),
    approval: ownerApproval,
  });
  expect(await queue()).toMatchObject({ total: 0 });
  await call("memory.add", { id: rule.id, text: "use pnpm instead" });
  const batch = await queue();
  expect(batch.groups[0]!.items[0]).toMatchObject({
    id: rule.id,
    kind: "revision",
    text: { text: "use pnpm instead" },
  });
  expect(
    await call("memory.accept", {
      items: acceptItems(batch),
      approval: ownerApproval,
    }),
  ).toEqual({ results: [{ id: rule.id, status: "accepted" }] });
});

test("only proposals that still wait are listed", async () => {
  const { call, queue } = setup();
  const waiting = await propose(call, "Still waiting for the owner.");
  const withdrawn = await propose(call, "Taken back by an agent.");
  const rejected = await propose(call, "Turned down by the owner.");
  const accepted = await propose(call, "Approved by the owner.");
  await propose(call, "A plain fact needs nobody.", ["fact"]);
  await call("memory.withdraw", {
    items: [{ id: withdrawn.id, revision: withdrawn.note.revision }],
    reason: "dup",
  });
  await call("memory.reject", {
    items: [{ id: rejected.id, revision: rejected.note.revision }],
    approval: ownerApproval,
  });
  await call("memory.accept", {
    items: [
      {
        id: accepted.id,
        revision: accepted.note.revision,
        text: "Approved by the owner.",
      },
    ],
    approval: ownerApproval,
  });
  expect(ids(await queue())).toEqual([waiting.id]);
});

test("listing the queue writes nothing and serves nothing", async () => {
  const { call, queue, state } = setup();
  await propose(call, "Write the test first.");
  const writes = state.counts.put + state.counts.putMany;
  await queue();
  expect(state.counts.put + state.counts.putMany).toBe(writes);
  const rules = await call<{ text: { text: string } }>("memory.rules", {
    notes: true,
  });
  expect(rules.text.text).not.toContain("Write the test first.");
});

test("an agent reads the queue through the runtime without approval", async () => {
  harness = await openHarness(["memory"]);
  const h = harness;
  done(
    await h.call(
      "memory.add",
      { level: "device", text: "Write the test first.", tags: ["rule"] },
      { caller: "agent" },
    ),
  );
  const queue = done(
    await h.call("memory.proposals", {}, { caller: "agent" }),
  ) as Queue;
  expect(queue.total).toBe(1);
  expect(queue.groups[0]!.items[0]!.text.text).toBe("Write the test first.");
});
