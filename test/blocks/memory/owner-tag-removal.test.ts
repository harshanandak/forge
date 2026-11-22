import { expect, test } from "bun:test";
import { memoryOwnerAsk } from "../../../src/assembly/approval.ts";
import {
  blockSchema,
  decisionItems,
  loadEntry,
  memoryState,
  ownerApproval,
} from "./lib.ts";

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
  const call = <T = unknown>(op: string, input: unknown, config = {}) =>
    entry[op]!({ input, config, services }) as Promise<T>;
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
      ).rejects.toMatchObject({
        error: {
          code: "PROPOSAL_CHANGED",
          message: expect.stringContaining(
            "removes the owner tags [rule]",
          ) as unknown,
        },
      });
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
  "a proposal that removes nine owner tags is accepted only when the item lists all nine",
  async () => {
    const { call } = setup();
    const tags = Array.from({ length: 9 }, (_, n) => `owner${n}`);
    const config = { approval: { ownerTags: tags } };
    const { id } = await call<{ id: string }>(
      "memory.add",
      { level: "device", text: "nine", tags },
      config,
    );
    const item = async (removedOwnerTags?: string[]) => ({
      items: [
        {
          id,
          revision: (
            await call<{ note: { revision: number } }>(
              "memory.show",
              { id },
              config,
            )
          ).note.revision,
          text: "nine",
          ...(removedOwnerTags === undefined ? {} : { removedOwnerTags }),
        },
      ],
      approval: ownerApproval,
    });
    await call("memory.accept", await item(), config);
    await call(
      "memory.add",
      { id, text: "nine", tags: [], approval: ownerApproval },
      config,
    );
    const validate = blockSchema("memory", "accept.input.json");
    expect(validate(await item(tags))).toEqual([]);
    await expect(
      call("memory.accept", await item(tags.slice(1)), config),
    ).rejects.toMatchObject({ error: { code: "PROPOSAL_CHANGED" } });
    expect(await call("memory.accept", await item(tags), config)).toMatchObject(
      { results: [{ id, status: "accepted" }] },
    );
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
    ).toContain("\nremoves owner tags: rule, preference");
    const partial = memoryOwnerAsk("memory.accept", {
      items: [{ ...item, removedOwnerTags: ["preference"] }],
    });
    expect(partial).toContain("removes owner tags: preference");
    expect(partial).not.toContain("rule");
    expect(partial).not.toContain("served as an owner rule");
  },
  TIMEOUT,
);
test("the owner's accept prompt shows control characters as visible escapes and keeps the removal line apart", () => {
  const ask = (text: string, removedOwnerTags: string[]) =>
    memoryOwnerAsk("memory.accept", {
      items: [{ id: "device/note-1", revision: 2, text, removedOwnerTags }],
    });
  const hostile = ask("bun\u001b[8m\u009b2K\u007f\r", ["rule\u001b[8m"]);
  expect(/[\p{Cc}\p{Cf}]/u.test(hostile.replaceAll("\n", ""))).toBe(false);
  expect(hostile).toContain("bun\\u001b[8m\\u009b2K\\u007f\\u000d");
  expect(hostile).toEndWith("\nremoves owner tags: rule\\u001b[8m");
  const faked = ask("harmless\nremoves owner tags: none", ["rule"]);
  expect(faked.match(/^removes.*/gmu)).toEqual(["removes owner tags: rule"]);
  expect(faked).toContain("\n    removes owner tags: none");
});
test(
  "memory.accept takes the removed tags in any order but refuses a duplicated list",
  async () => {
    const { call } = setup();
    const id = await acceptedRule(call, "use bun", ["rule", "preference"]);
    await typedRemoval(call, id, "use npm", []);
    const [item] = await decisionItems(call, [id]);
    const accept = (removedOwnerTags: string[]) =>
      call("memory.accept", {
        items: [{ ...item!, removedOwnerTags }],
        approval: ownerApproval,
      });
    await expect(accept(["rule", "preference", "rule"])).rejects.toMatchObject({
      error: { code: "PROPOSAL_CHANGED" },
    });
    expect(await accept(["preference", "rule"])).toMatchObject({
      results: [{ id, status: "accepted" }],
    });
  },
  TIMEOUT,
);
