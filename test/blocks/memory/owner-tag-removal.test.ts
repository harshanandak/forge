import { expect, test } from "bun:test";
import { memoryOwnerAsk } from "../../../src/assembly/approval.ts";
import { decisionItems, loadEntry, memoryState, ownerApproval } from "./lib.ts";

const TIMEOUT = 30_000;

interface Shown {
  note: { status?: string; tags: string[]; text: { text: string } };
}
interface Rules {
  text: { text: string };
  receipt: { selected: { id: string }[] };
}
function setup() {
  const entry = loadEntry("memory");
  const state = memoryState();
  const services = { state, levels: state };
  const call = <T = unknown>(op: string, input: unknown) =>
    entry[op]!({ input, services }) as Promise<T>;
  return { call, state };
}
type Call = ReturnType<typeof setup>["call"];

async function acceptedRule(call: Call, text: string, tags: string[]) {
  const added = await call<{ id: string }>("memory.add", {
    level: "device",
    text,
    tags,
  });
  await call("memory.accept", {
    items: await decisionItems(call, [added.id]),
    approval: ownerApproval,
  });
  return added.id;
}
function typedRemoval(call: Call, id: string, text: string, tags: string[]) {
  return call("memory.add", { id, text, tags, approval: ownerApproval });
}
async function expectUnchanged(
  call: Call,
  id: string,
  text: string,
  tags: string[],
  never: string,
) {
  const shown = await call<Shown>("memory.show", { id });
  expect(shown.note.status).toBeUndefined();
  expect(shown.note.tags).toEqual(tags);
  expect(shown.note.text.text).toBe(text);
  const rules = await call<Rules>("memory.rules", { notes: true });
  expect(rules.text.text).toContain(text);
  expect(rules.text.text).not.toContain(never);
  expect(rules.receipt.selected.map((rule) => rule.id)).toContain(id);
  const attached = await call<{ text: { text: string } }>("memory.attach", {
    ids: [id],
  });
  expect(attached.text.text).toContain(text);
  expect(attached.text.text).not.toContain(never);
}

test(
  "a typed owner approval cannot drop the last owner tag, with the text changed or not",
  async () => {
    for (const text of ["use npm", "use bun"]) {
      const { call } = setup();
      const id = await acceptedRule(call, "use bun", ["rule"]);
      expect(await typedRemoval(call, id, text, [])).toMatchObject({
        status: "updated",
        note: { tags: ["rule"], proposal: { tags: [] } },
      });
      await expectUnchanged(call, id, "use bun", ["rule"], "use npm");
    }
  },
  TIMEOUT,
);

test(
  "a second edit after a typed tag removal still waits for the owner",
  async () => {
    const { call } = setup();
    const id = await acceptedRule(call, "use bun", ["rule"]);
    await typedRemoval(call, id, "use bun", []);
    await call("memory.add", { id, text: "use npm" });
    await expectUnchanged(call, id, "use bun", ["rule"], "use npm");
  },
  TIMEOUT,
);

test(
  "a typed owner approval cannot drop one of two owner tags with the text unchanged",
  async () => {
    const { call } = setup();
    const id = await acceptedRule(call, "use bun", ["rule", "preference"]);
    expect(await typedRemoval(call, id, "use bun", ["rule"])).toMatchObject({
      status: "updated",
      note: { tags: ["rule", "preference"], proposal: { tags: ["rule"] } },
    });
    await expectUnchanged(
      call,
      id,
      "use bun",
      ["rule", "preference"],
      "use npm",
    );
  },
  TIMEOUT,
);

test(
  "memory.accept refuses a staged tag removal that does not name the removed tags, and applies it when named",
  async () => {
    const { call, state } = setup();
    const id = await acceptedRule(call, "use bun", ["rule"]);
    await typedRemoval(call, id, "use npm", []);
    const [item] = await decisionItems(call, [id]);
    expect(item).toMatchObject({ removedOwnerTags: ["rule"] });
    const { removedOwnerTags: _named, ...unnamed } = item!;
    const writes = state.counts.put + state.counts.putMany;
    for (const named of [undefined, ["preference"], []])
      await expect(
        call("memory.accept", {
          items: [
            {
              ...unnamed,
              ...(named === undefined ? {} : { removedOwnerTags: named }),
            },
          ],
          approval: ownerApproval,
        }),
      ).rejects.toMatchObject({ error: { code: "PROPOSAL_CHANGED" } });
    expect(state.counts.put + state.counts.putMany).toBe(writes);
    await expectUnchanged(call, id, "use bun", ["rule"], "use npm");
    expect(
      await call("memory.accept", {
        items: await decisionItems(call, [id]),
        approval: ownerApproval,
      }),
    ).toMatchObject({ results: [{ id, status: "accepted" }] });
    const shown = await call<Shown>("memory.show", { id });
    expect(shown.note.tags).toEqual([]);
    expect(shown.note.text.text).toBe("use npm");
    expect(shown.note.status).toBeUndefined();
  },
  TIMEOUT,
);

test(
  "the owner's accept prompt names the owner tags a proposal removes",
  () => {
    const item = { id: "device/note-1", revision: 2, text: "use npm" };
    expect(
      memoryOwnerAsk("memory.accept", {
        items: [{ ...item, removedOwnerTags: ["rule", "preference"] }],
      }),
    ).toContain(
      "removes owner tags: rule, preference (it will no longer be served as an owner rule)",
    );
  },
  TIMEOUT,
);
