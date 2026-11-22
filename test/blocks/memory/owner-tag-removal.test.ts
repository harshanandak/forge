import { expect, test } from "bun:test";
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
  return { call };
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
async function attempt(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    expect(error).toMatchObject({ error: { code: "HUMAN_REQUIRED" } });
  }
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
  "a typed owner approval cannot drop the last owner tag and change the text",
  async () => {
    const { call } = setup();
    const id = await acceptedRule(call, "use bun", ["rule"]);
    await attempt(() =>
      call("memory.add", {
        id,
        text: "use npm",
        tags: [],
        approval: ownerApproval,
      }),
    );
    await expectUnchanged(call, id, "use bun", ["rule"], "use npm");
  },
  TIMEOUT,
);

test(
  "a typed owner approval cannot drop the last owner tag with the text unchanged",
  async () => {
    const { call } = setup();
    const id = await acceptedRule(call, "use bun", ["rule"]);
    await attempt(() =>
      call("memory.add", {
        id,
        text: "use bun",
        tags: [],
        approval: ownerApproval,
      }),
    );
    await expectUnchanged(call, id, "use bun", ["rule"], "use npm");
  },
  TIMEOUT,
);

test(
  "a second edit after a typed tag removal still waits for the owner",
  async () => {
    const { call } = setup();
    const id = await acceptedRule(call, "use bun", ["rule"]);
    await attempt(() =>
      call("memory.add", {
        id,
        text: "use bun",
        tags: [],
        approval: ownerApproval,
      }),
    );
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
    await attempt(() =>
      call("memory.add", {
        id,
        text: "use bun",
        tags: ["rule"],
        approval: ownerApproval,
      }),
    );
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
