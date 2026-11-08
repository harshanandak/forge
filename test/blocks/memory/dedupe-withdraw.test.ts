import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  blockSchema,
  decisionItems,
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

interface Note {
  status?: string;
  tags: string[];
  text: { text: string };
  proposal?: { text: { text: string } };
  rejectedProposals?: {
    text: { text: string };
    withdrawn?: { by: string; reason: { text: string } };
  }[];
  revision: number;
}
interface Reply {
  status: string;
  id: string;
  notice?: string;
  similarTo?: string[];
  note: Note;
  results: { id: string; status: string }[];
}
interface Rules {
  text: { text: string };
  receipt: { selected: { id: string }[]; proposed?: { count: number } };
}
function setup() {
  const entry = loadEntry("memory");
  const state = memoryState();
  const services = { state, levels: state };
  const call = <T = Reply>(op: string, input: unknown) =>
    entry[op]!({ input, services }) as Promise<T>;
  const rules = () => call<Rules>("memory.rules", { notes: true });
  return { call, rules };
}
type Call = ReturnType<typeof setup>["call"];
const propose = (call: Call, text: string, extra: object = {}) =>
  call("memory.add", { level: "device", text, tags: ["rule"], ...extra });
async function accept(call: Call, ids: string[]) {
  return call("memory.accept", {
    items: await decisionItems(call, ids),
    approval: ownerApproval,
  });
}
const withdraw = (call: Call, id: string, revision: number, reason = "dup") =>
  call("memory.withdraw", { items: [{ id, revision }], reason });

// Ten distinct words; dropping one leaves 9 shared of 10 in the union: exactly the similarity threshold.
const TEN = "alpha bravo charlie delta echo foxtrot golf hotel india juliet";
// Eighteen distinct words; swapping one leaves 17 shared of 19 in the union: just under it.
const EIGHTEEN = Array.from({ length: 18 }, (_, i) => `word${i + 1}x`);

test("five adds of the same owner rule make one proposal and four notices naming it", async () => {
  const { call, rules } = setup();
  const text = "Reviewers approve direction, never implementation details.";
  const first = await propose(call, text);
  expect(first.status).toBe("added");
  for (let i = 0; i < 4; i += 1) {
    const again = await propose(call, text);
    expect(again.status).toBe("exists");
    expect(again.id).toBe(first.id);
    expect(again.notice).toContain(`already proposed as ${first.id}`);
  }
  expect((await rules()).receipt.proposed?.count).toBe(1);
  // No number was spent on the refused adds.
  const other = await propose(call, "A clearly different rule about releases.");
  expect(other.status).toBe("added");
  expect(other.id).toBe("device/note-2");
});

test("a clearly different rule still creates its own proposal", async () => {
  const { call, rules } = setup();
  await propose(call, "Always write the test first.");
  const other = await propose(call, "Merge only when hosted CI is green.");
  expect(other.status).toBe("added");
  expect((await rules()).receipt.proposed?.count).toBe(2);
});

test("case, spacing and punctuation never make a second proposal", async () => {
  const { call } = setup();
  const first = await propose(call, "Write the test first.");
  const again = await propose(call, "  WRITE   the test, first!! ");
  expect(again).toMatchObject({ status: "exists", id: first.id });
});

test("an active rule is reported as already active", async () => {
  const { call } = setup();
  const first = await propose(call, "Write the test first.");
  await accept(call, [first.id]);
  const again = await propose(call, "write the test first");
  expect(again.status).toBe("exists");
  expect(again.id).toBe(first.id);
  expect(again.notice).toContain("already active");
});

test("close wording is kept as its own proposal with a similarTo hint, at the 0.9 boundary", async () => {
  const { call, rules } = setup();
  const base = await propose(call, TEN);
  expect(base.similarTo).toBeUndefined();
  // 9 of 10 words shared: exactly 0.9. Not suppressed; the hint names the close note.
  const minusOne = TEN.split(" ").slice(0, 9).join(" ");
  const close = await propose(call, minusOne);
  expect(close.status).toBe("added");
  expect(close.id).not.toBe(base.id);
  expect(close.similarTo).toEqual([base.id]);
  expect(close.notice).toContain(
    `similar to ${base.id}; withdraw this one if it says the same thing`,
  );
  // 8 of 10 words shared: 0.8, and 8 of 9 against the note above: no hint.
  const minusTwo = TEN.split(" ").slice(0, 8).join(" ");
  expect((await propose(call, minusTwo)).similarTo).toBeUndefined();

  const long = await propose(call, EIGHTEEN.join(" "));
  const swapped = [...EIGHTEEN.slice(0, 17), "newword"].join(" ");
  // 17 of 19 words in the union: 0.894, just under the threshold: no hint.
  const under = await propose(call, swapped);
  expect(under.status).toBe("added");
  expect(under.similarTo).toBeUndefined();
  // 17 of 18 in the union: 0.944, over it: still added, with a hint naming both notes.
  const dropped = await propose(call, EIGHTEEN.slice(0, 17).join(" "));
  expect(dropped.status).toBe("added");
  expect(dropped.similarTo).toEqual([long.id, under.id]);
  // Every one of them waits for the owner.
  expect((await rules()).receipt.proposed?.count).toBe(6);
});

test("the same words in another order are a different rule and reach the owner", async () => {
  const { call, rules } = setup();
  const first = await propose(
    call,
    "Always encrypt backups; never delete originals.",
  );
  await accept(call, [first.id]);
  const opposite = await propose(
    call,
    "Always delete originals; never encrypt backups.",
  );
  expect(opposite.status).toBe("added");
  expect(opposite.id).not.toBe(first.id);
  expect(opposite.note.status).toBe("proposed");
  expect(opposite.similarTo).toEqual([first.id]);
  expect(opposite.notice).toContain(
    `similar to ${first.id}; withdraw this one if it says the same thing`,
  );
  expect(opposite.notice!.length).toBeLessThanOrEqual(600);
  const served = await rules();
  expect(served.text.text).toContain("Always encrypt backups");
  expect(served.text.text).not.toContain("Always delete originals");
  expect(served.receipt.proposed?.count).toBe(1);
});

test("only owner-tagged notes in the same scope are compared", async () => {
  const { call } = setup();
  expect(
    (await propose(call, "Write the test first.", { scope: "one" })).status,
  ).toBe("added");
  expect(
    (await propose(call, "Write the test first.", { scope: "two" })).status,
  ).toBe("added");
  const plain = (text: string) =>
    call("memory.add", { level: "device", text, tags: ["fact"] });
  expect((await plain("Write the test first.")).status).toBe("added");
  expect((await plain("Write the test first.")).status).toBe("added");
});

test("an edit that would repeat another owner note is not proposed", async () => {
  const { call, rules } = setup();
  const rule = await propose(call, "Write the test first.");
  await accept(call, [rule.id]);
  const plain = await call("memory.add", {
    level: "device",
    text: "write the test first",
    tags: ["fact"],
  });
  const edited = await call("memory.add", {
    id: plain.id,
    text: "write the test first",
    tags: ["rule"],
  });
  expect(edited).toMatchObject({ status: "exists", id: rule.id });
  const shown = await call("memory.show", { id: plain.id });
  expect(shown.note.proposal).toBeUndefined();
  expect(shown.note.tags).toEqual(["fact"]);
  expect((await rules()).receipt.proposed).toBeUndefined();
});

test("an edit never turns another note into a second proposal of an owner note's exact text", async () => {
  const { call } = setup();
  const rule = await propose(call, "Write the test first.");
  const pending = await propose(call, "Merge on green CI.");
  const edited = await call("memory.add", {
    id: pending.id,
    text: "write the test, first!",
  });
  expect(edited).toMatchObject({ status: "exists", id: rule.id });
  const kept = await call("memory.show", { id: pending.id });
  expect(kept.note.text.text).toBe("Merge on green CI.");
  expect(kept.note.status).toBe("proposed");

  const withdrawn = await propose(call, "Review before merging.");
  await withdraw(call, withdrawn.id, withdrawn.note.revision);
  expect(
    await call("memory.add", {
      id: withdrawn.id,
      text: "Write the test first.",
    }),
  ).toMatchObject({ status: "exists", id: rule.id });
  expect((await call("memory.show", { id: withdrawn.id })).note.status).toBe(
    "withdrawn",
  );

  const rejected = await propose(call, "Ship small changes.");
  await call("memory.reject", {
    items: await decisionItems(call, [rejected.id]),
    approval: ownerApproval,
  });
  expect(
    await call("memory.add", {
      id: rejected.id,
      text: "WRITE THE TEST FIRST",
    }),
  ).toMatchObject({ status: "exists", id: rule.id });
  expect((await call("memory.show", { id: rejected.id })).note.status).toBe(
    "rejected",
  );
});

test("an edit to close wording is kept and names the close note", async () => {
  const { call } = setup();
  const base = await propose(call, TEN);
  const other = await propose(call, "A different rule about releases.");
  const edited = await call("memory.add", {
    id: other.id,
    text: TEN.split(" ").slice(0, 9).join(" "),
  });
  expect(edited.status).toBe("updated");
  expect(edited.similarTo).toEqual([base.id]);
  expect(edited.notice).toContain("similar to");
});

test("the add notice tells agents which tags need the owner and how to take a proposal back", async () => {
  const { call } = setup();
  const added = await propose(call, "Write the test first.");
  expect(added.notice).toContain("directional");
  expect(added.notice).toContain("fact, procedure or reference");
  expect(added.notice).toContain("memory.withdraw");
  expect(added.notice!.length).toBeLessThanOrEqual(600);
});

test("withdraw closes a proposal, keeps it in history and never serves it", async () => {
  const { call, rules } = setup();
  const added = await propose(call, "Write the test first.");
  const shown = await call("memory.show", { id: added.id });
  expect(
    await call("memory.withdraw", {
      items: [{ id: added.id, revision: shown.note.revision }],
      reason: "Same rule as the note the owner already approved",
    }),
  ).toMatchObject({ results: [{ id: added.id, status: "withdrawn" }] });

  const after = await call("memory.show", { id: added.id });
  expect(after.note.status).toBe("withdrawn");
  expect(after.note.rejectedProposals?.[0]).toMatchObject({
    text: { text: "Write the test first." },
    withdrawn: {
      by: "agent",
      reason: { text: "Same rule as the note the owner already approved" },
    },
  });
  const served = await rules();
  expect(served.text.text).not.toContain("Write the test first.");
  expect(served.receipt.selected).toEqual([]);
  expect(served.receipt.proposed).toBeUndefined();
  const attached = await call<{ receipt: { selected: unknown[] } }>(
    "memory.attach",
    { ids: [added.id] },
  );
  expect(attached.receipt.selected).toEqual([]);
});

test("withdraw cannot be used to activate text or to take back an accepted note", async () => {
  const { call, rules } = setup();
  const rule = await propose(call, "Write the test first.");
  await accept(call, [rule.id]);
  const current = await call("memory.show", { id: rule.id });
  expect(await withdraw(call, rule.id, current.note.revision)).toMatchObject({
    results: [{ id: rule.id, status: "not_proposed" }],
  });
  expect((await rules()).text.text).toContain("Write the test first.");
  expect((await call("memory.show", { id: rule.id })).note.status).toBe(
    undefined,
  );

  const waiting = await propose(call, "Merge only on green CI.");
  const shown = await call("memory.show", { id: waiting.id });
  await withdraw(call, waiting.id, shown.note.revision);
  expect((await rules()).text.text).not.toContain("Merge only on green CI.");
  // A withdrawn note is not proposed any more, so the owner's accept leaves it alone.
  expect(
    await call("memory.accept", {
      items: [
        {
          id: waiting.id,
          revision: (await call("memory.show", { id: waiting.id })).note
            .revision,
          text: "Merge only on green CI.",
        },
      ],
      approval: ownerApproval,
    }),
  ).toMatchObject({ results: [{ id: waiting.id, status: "not_proposed" }] });
  expect((await rules()).text.text).not.toContain("Merge only on green CI.");
});

test("withdrawing a pending revision keeps the accepted text served", async () => {
  const { call, rules } = setup();
  const rule = await propose(call, "use bun");
  await accept(call, [rule.id]);
  const edited = await call("memory.add", { id: rule.id, text: "use npm" });
  expect(edited.note.proposal?.text.text).toBe("use npm");
  await withdraw(call, rule.id, edited.note.revision, "Bun is settled");
  const shown = await call("memory.show", { id: rule.id });
  expect(shown.note.proposal).toBeUndefined();
  expect(shown.note.status).toBeUndefined();
  expect(shown.note.text.text).toBe("use bun");
  expect(shown.note.rejectedProposals?.[0]).toMatchObject({
    text: { text: "use npm" },
    withdrawn: { by: "agent", reason: { text: "Bun is settled" } },
  });
  const served = await rules();
  expect(served.text.text).toContain("use bun");
  expect(served.text.text).not.toContain("use npm");
  expect(served.receipt.proposed).toBeUndefined();
});

test("a stale revision is left alone and unknown ids are reported", async () => {
  const { call } = setup();
  const added = await propose(call, "Write the test first.");
  const stale = await call("memory.withdraw", {
    items: [
      { id: added.id, revision: added.note.revision + 5 },
      { id: "device/note-99", revision: 1 },
    ],
    reason: "dup",
  });
  expect(stale.results).toEqual([
    { id: added.id, status: "conflict" },
    { id: "device/note-99", status: "not_found" },
  ]);
  expect((await call("memory.show", { id: added.id })).note.status).toBe(
    "proposed",
  );
});

test("editing a withdrawn owner-tagged note proposes it again", async () => {
  const { call } = setup();
  const added = await propose(call, "first try");
  await withdraw(call, added.id, added.note.revision);
  const edited = await call("memory.add", {
    id: added.id,
    text: "a better try",
  });
  expect(edited.note.status).toBe("proposed");
  expect(edited.notice).toContain("proposed again");
});

test("export and restore keep a withdrawn proposal withdrawn", async () => {
  const from = setup();
  const added = await propose(from.call, "Write the test first.");
  await withdraw(from.call, added.id, added.note.revision, "dup of note-9");
  const bundle = JSON.parse(
    JSON.stringify(await from.call("memory.export", { level: "device" })),
  ) as { format: string };
  expect(bundle.format).toBe("forge.memory.export/3");
  const restoreInput = { ...bundle, approval: ownerApproval };
  expect(blockSchema("memory", "restore.input.json")(restoreInput)).toEqual([]);
  const into = setup();
  await into.call("memory.restore", restoreInput);
  const shown = await into.call("memory.show", { id: added.id });
  expect(shown.note.status).toBe("withdrawn");
  expect(shown.note.rejectedProposals?.[0]?.withdrawn?.reason.text).toBe(
    "dup of note-9",
  );
  const served = await into.rules();
  expect(served.text.text).not.toContain("Write the test first.");
  expect(served.receipt.proposed).toBeUndefined();
});

test("an agent withdraws without owner approval and must say why", async () => {
  harness = await openHarness(["memory"]);
  const h = harness;
  const added = done(
    await h.call(
      "memory.add",
      { level: "device", text: "Write the test first.", tags: ["rule"] },
      { caller: "agent" },
    ),
  ) as Reply;
  const none = await h.call(
    "memory.withdraw",
    { items: [{ id: added.id, revision: added.note.revision }], reason: "" },
    { caller: "agent" },
  );
  expect(none.ok).toBe(false);
  const result = done(
    await h.call(
      "memory.withdraw",
      {
        items: [{ id: added.id, revision: added.note.revision }],
        reason: "Settled by the owner's earlier rule",
      },
      { caller: "agent" },
    ),
  ) as Reply;
  expect(result.results).toEqual([{ id: added.id, status: "withdrawn" }]);
});
