import { expect, test } from "bun:test";
import * as approval from "../../../src/assembly/approval.ts";
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
test(
  "the stored accept prompt shows control characters as visible escapes and keeps the removal line apart",
  () => {
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
  },
  TIMEOUT,
);

test(
  "memory display builders quote identifiers and keep static restore counts",
  () => {
    const { memoryOwnerDisplayAsk = memoryOwnerAsk } =
      approval as typeof approval & {
        memoryOwnerDisplayAsk?: typeof memoryOwnerAsk;
      };
    const id = 'item"\\\u0007\n\u202e';
    const quoted = '"item\\"\\\\\\u0007\\u000a\\u202e"';
    const cases = [
      [
        "memory.forget",
        { id },
        `Forget note ${quoted}. Its text is hidden and kept only as a private backup.`,
      ],
      [
        "memory.forget",
        { id, undo: true },
        `Restore the forgotten note ${quoted} with its saved text and history.`,
      ],
      [
        "decision.adopt",
        { id },
        `Adopt decision ${quoted} so it becomes a binding standing rule.`,
      ],
      [
        "memory.restore",
        { notes: [] },
        "Restore 0 notes from an export into Forge memory.",
      ],
      [
        "memory.restore",
        { notes: [{}] },
        "Restore 1 note from an export into Forge memory.",
      ],
      [
        "memory.restore",
        { notes: [{}, {}] },
        "Restore 2 notes from an export into Forge memory.",
      ],
    ] as const;
    expect(
      cases.map(([op, input]) => memoryOwnerDisplayAsk(op, input)),
    ).toEqual(cases.map(([, , expected]) => expected));
  },
  TIMEOUT,
);
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

test(
  "removing the last owner tag stages an edit whose proposed text matches another rule",
  async () => {
    const { call } = setup();
    await acceptedRule(call, "use bun", ["rule"]);
    const id = await acceptedRule(call, "use npm", ["rule"]);
    const edited = await typedRemoval(call, id, "use bun", []);
    expect(edited).toMatchObject({
      id,
      status: "updated",
      note: { proposal: { tags: [], text: { text: "use bun" } } },
    });
    expect(edited).not.toHaveProperty("similarTo");
  },
  TIMEOUT,
);

test(
  "staged edits still check for twins when an owner tag is added or retained",
  async () => {
    const { call } = setup();
    const twin = await acceptedRule(call, "use bun", ["rule"]);
    const plain = await call<{ id: string }>("memory.add", {
      level: "device",
      text: "install Node",
    });
    const tagged = await acceptedRule(call, "pin tool versions", [
      "rule",
      "preference",
    ]);
    const expected = { status: "exists", id: twin };
    const added = await typedRemoval(call, plain.id, "use bun", ["rule"]);
    const retained = await typedRemoval(call, tagged, "use bun", [
      "preference",
    ]);
    expect(added).toMatchObject(expected);
    expect(retained).toMatchObject(expected);
  },
  TIMEOUT,
);

test(
  "removing the last owner tag from a unique rule still stages a revision",
  async () => {
    const { call } = setup();
    const id = await acceptedRule(call, "use bun", ["rule"]);
    expect(await typedRemoval(call, id, "use bun", [])).toMatchObject({
      id,
      status: "updated",
      note: { proposal: { tags: [] } },
    });
  },
  TIMEOUT,
);

test(
  "memory.accept takes a genuinely unsorted list of removed owner tags",
  async () => {
    const { call } = setup();
    const id = await acceptedRule(call, "use bun", ["rule", "preference"]);
    await typedRemoval(call, id, "use npm", []);
    const items = await decisionItems(call, [id]);
    expect(items[0]?.removedOwnerTags).toEqual(["rule", "preference"]);
    expect(
      await call("memory.accept", { items, approval: ownerApproval }),
    ).toEqual({
      results: [{ id, status: "accepted" }],
    });
  },
  TIMEOUT,
);

const bmpCodes =
  "0085 200b 2060 feff 202a 202b 202c 202d 202e 2066 2067 2068 2069 2028 2029".split(
    " ",
  );
const bmpControls = bmpCodes
  .map((hex) => String.fromCharCode(parseInt(hex, 16)))
  .join("");
const bmpEscapes = bmpCodes.map((hex) => "\\u" + hex).join("");
const supplementaryControls = "\u{e0001}\u{e0020}";
const supplementaryEscapes = "\\udb40\\udc01\\udb40\\udc20";
const rawControls = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const hostileItem = (controls: string) => ({
  id: "id" + controls,
  revision: "rev" + controls,
  text: "text" + controls,
  removedOwnerTags: ["tag" + controls],
});

test.each([
  ["BMP controls", bmpControls, bmpEscapes],
  [
    "both UTF-16 units of supplementary controls",
    supplementaryControls,
    supplementaryEscapes,
  ],
] as const)(
  "stored ask builder robustness: escapes %s in every field",
  (_case, controls, escapes) => {
    const ask = memoryOwnerAsk("memory.accept", {
      items: [hostileItem(controls)],
    });
    expect(ask.split("\n").slice(1)).toEqual([
      "- id" + escapes + " (revision rev" + escapes + "):",
      "    text" + escapes,
      "removes owner tags: tag" + escapes,
    ]);
    expect(rawControls.test(ask.replaceAll("\n", ""))).toBe(false);
  },
  TIMEOUT,
);

test(
  "accept and reject display asks quote and escape each displayed field",
  () => {
    const escapes = bmpEscapes + supplementaryEscapes;
    const { removedOwnerTags, ...item } = hostileItem(
      bmpControls + supplementaryControls,
    );
    const asks = [
      approval.memoryOwnerDisplayAsk("memory.accept", {
        items: [{ ...item, removedOwnerTags }],
      }),
      approval.memoryOwnerDisplayAsk("memory.reject", { items: [item] }),
    ];
    const lines = [
      '- "id' + escapes + '" (revision "rev' + escapes + '"):',
      '    "text' + escapes + '"',
    ];
    expect(asks.map((ask) => ask.split("\n").slice(1))).toEqual([
      [...lines, 'removes owner tags: "tag' + escapes + '"'],
      lines,
    ]);
    for (const ask of asks)
      expect(rawControls.test(ask.replaceAll("\n", ""))).toBe(false);
  },
  TIMEOUT,
);

test(
  "only accept asks show the removal line even if a reject item supplies tags",
  () => {
    const item = { id: "device/note-1", revision: 2, text: "use npm" };
    const input = { items: [{ ...item, removedOwnerTags: ["rule"] }] };
    const builders = [memoryOwnerAsk, approval.memoryOwnerDisplayAsk];
    const showsRemoval = (op: string) =>
      builders.map((ask) => ask(op, input).includes("\nremoves owner tags: "));
    expect(showsRemoval("memory.accept")).toEqual([true, true]);
    expect(showsRemoval("memory.reject")).toEqual([false, false]);
  },
  TIMEOUT,
);
