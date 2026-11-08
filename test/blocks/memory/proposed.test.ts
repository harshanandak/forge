import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { localCall } from "../../../src/assembly/index.ts";
import type { ResultEnvelope } from "../../../src/generated/types.ts";
import { record } from "../../../src/surface/dispatch.ts";
import { createMcpHandlers } from "../../../src/surface/mcp.ts";
import {
  blockSchema,
  decisionItem,
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

const agent = { by: "agent", reason: "I think the owner would agree" };
const source = { harness: "codex", thread: "owner-chat", message: "reply-1" };

interface Note {
  status?: string;
  tags: string[];
  text: { text: string };
  proposal?: { text: { text: string }; tags: string[] };
  rejectedProposals?: { text: { text: string } }[];
  approval?: { by: string };
  revision: number;
}
interface Reply {
  status: string;
  id: string;
  notice?: string;
  note: Note;
  results: { id: string; status: string }[];
}
interface Rules {
  text: { text: string };
  receipt: {
    selected: { id: string }[];
    proposed?: { count: number; message: string };
  };
}
function setup() {
  const entry = loadEntry("memory");
  const state = memoryState();
  const services = { state, levels: state };
  const call = <T = Reply>(op: string, input: unknown) =>
    entry[op]!({ input, services }) as Promise<T>;
  const rules = () => call<Rules>("memory.rules", { notes: true });
  return { call, rules, state };
}
type Call = ReturnType<typeof setup>["call"];
async function refused(run: () => unknown, code = "HUMAN_REQUIRED") {
  try {
    await run();
  } catch (error) {
    expect(error).toMatchObject({ error: { code } });
    return;
  }
  throw new Error(`expected ${code}`);
}
/** Accept or reject notes as the owner would: bound to the revision and text they are shown. */
async function decide(
  call: Call,
  op: "memory.accept" | "memory.reject",
  ids: string[],
  approval: unknown = ownerApproval,
) {
  return call(op, { items: await decisionItems(call, ids), approval });
}
/** An active rule: added (proposed), then accepted with the owner's approval. */
async function activeRule(call: Call, text: string) {
  const added = await propose(call, text);
  await decide(call, "memory.accept", [added.id]);
  return added;
}
async function propose(call: Call, text: string, tags = ["rule"]) {
  return call("memory.add", { level: "device", text, tags });
}

test("a new rule note waits for the owner and is not served as a rule", async () => {
  const { call, rules } = setup();
  const added = await propose(call, "never deploy on friday");
  expect(added.status).toBe("added");
  expect(added.note.status).toBe("proposed");
  expect(added.notice).toContain("waits for the owner");
  expect(added.notice).toContain("memory.accept");

  const served = await rules();
  expect(served.text.text).not.toContain("never deploy on friday");
  expect(served.receipt.selected).toEqual([]);
  expect(served.receipt.proposed).toEqual({
    count: 1,
    message: "1 proposed rule awaits owner review",
  });
  const attached = await call<{ receipt: { selected: unknown[] } }>(
    "memory.attach",
    { ids: [added.id] },
  );
  expect(attached.receipt.selected).toEqual([]);

  const found = await call<{ hits: { id: string; status?: string }[] }>(
    "memory.search",
    { query: "friday" },
  );
  expect(found.hits).toMatchObject([{ id: added.id, status: "proposed" }]);
  expect(await call("memory.show", { id: added.id })).toMatchObject({
    status: "found",
    note: { status: "proposed" },
  });
});

test("notes without an owner tag take effect at once", async () => {
  const { call, rules } = setup();
  const plain = await call("memory.add", {
    level: "device",
    text: "plain fact",
    tags: ["fact", "rule-of-thumb"],
  });
  expect(plain.note.status).toBeUndefined();
  expect(plain.notice).toBeUndefined();
  const untagged = await call("memory.add", {
    level: "device",
    text: "untagged",
  });
  expect(untagged.note.status).toBeUndefined();
  const served = await rules();
  expect(served.receipt.proposed).toBeUndefined();
});

test("an inline owner approval on add never activates an owner-tagged note", async () => {
  const { call, rules } = setup();
  const claimed = await call("memory.add", {
    level: "device",
    text: "agent claims the owner agreed",
    tags: ["rule"],
    approval: ownerApproval,
  });
  expect(claimed.note.status).toBe("proposed");
  const served = await rules();
  expect(served.text.text).not.toContain("agent claims the owner agreed");
  expect(served.receipt.proposed?.count).toBe(1);
  // The same claim on an edit that changes an accepted rule's text or adds an owner tag.
  const rule = await activeRule(call, "accepted rule text");
  const edited = await call("memory.add", {
    id: rule.id,
    text: "claimed rewrite",
    approval: ownerApproval,
  });
  expect(edited.note.text.text).toBe("accepted rule text");
  expect(edited.note.proposal?.text.text).toBe("claimed rewrite");
  const plain = await call("memory.add", {
    level: "device",
    text: "claimed tag",
    tags: ["fact"],
  });
  const tagged = await call("memory.add", {
    id: plain.id,
    text: "claimed tag",
    tags: ["fact", "rule"],
    approval: ownerApproval,
  });
  expect(tagged.note.tags).toEqual(["fact"]);
  expect((await rules()).text.text).not.toContain("claimed rewrite");
});

test("memory.accept with an owner approval makes the proposed rule served", async () => {
  const { call, rules } = setup();
  const added = await propose(call, "always write the test first");
  const accepted = await decide(call, "memory.accept", [added.id]);
  expect(accepted).toMatchObject({
    results: [{ id: added.id, status: "accepted" }],
  });
  const served = await rules();
  expect(served.text.text).toContain("always write the test first");
  expect(served.receipt.selected.map((rule) => rule.id)).toEqual([added.id]);
  expect(served.receipt.proposed).toBeUndefined();
  const shown = await call("memory.show", { id: added.id });
  expect(shown.note.status).toBeUndefined();
  expect(shown.note.approval).toMatchObject({ by: "owner" });
  expect(await decide(call, "memory.accept", [added.id])).toMatchObject({
    results: [{ id: added.id, status: "not_proposed" }],
  });
});

test("accept and reject refuse a missing or agent approval before any write", async () => {
  const { call, rules, state } = setup();
  const added = await propose(call, "owner only rule");
  const items = await decisionItems(call, [added.id]);
  const writes = state.counts.put + state.counts.putMany;
  for (const op of ["memory.accept", "memory.reject"])
    for (const approval of [undefined, agent])
      await refused(() => call(op, { items, approval }));
  expect(state.counts.put + state.counts.putMany).toBe(writes);
  expect((await rules()).text.text).not.toContain("owner only rule");
  expect(await call("memory.show", { id: added.id })).toMatchObject({
    note: { status: "proposed" },
  });
});

test("an edit to an accepted rule keeps serving the old text until accepted", async () => {
  const { call, rules } = setup();
  const added = await activeRule(call, "use bun");
  const edited = await call("memory.add", { id: added.id, text: "use npm" });
  expect(edited.status).toBe("updated");
  expect(edited.note.text.text).toBe("use bun");
  expect(edited.note.proposal?.text.text).toBe("use npm");
  expect(edited.notice).toContain("memory.accept");

  const served = await rules();
  expect(served.text.text).toContain("use bun");
  expect(served.text.text).not.toContain("use npm");
  expect(served.receipt.proposed?.count).toBe(1);
  const found = await call<{ hits: { id: string }[] }>("memory.search", {
    query: "npm",
  });
  expect(found.hits.map((hit) => hit.id)).toEqual([added.id]);
  const attached = await call<{ text: { text: string } }>("memory.attach", {
    ids: [added.id],
  });
  expect(attached.text.text).not.toContain("use npm");

  await decide(call, "memory.accept", [added.id]);
  const after = await rules();
  expect(after.text.text).toContain("use npm");
  expect(after.text.text).not.toContain("use bun");
  const shown = await call("memory.show", { id: added.id });
  expect(shown.note.proposal).toBeUndefined();
  expect(shown.note.text.text).toBe("use npm");
});

test("an edit that adds an owner tag is proposed and the tags stay until accepted", async () => {
  const { call, rules } = setup();
  const plain = await call("memory.add", {
    level: "device",
    text: "ship small changes",
    tags: ["fact"],
  });
  const edited = await call("memory.add", {
    id: plain.id,
    text: "ship small changes",
    tags: ["fact", "rule"],
  });
  expect(edited.status).toBe("updated");
  expect(edited.note.tags).toEqual(["fact"]);
  expect(edited.note.proposal?.tags).toEqual(["fact", "rule"]);
  expect((await rules()).text.text).not.toContain("ship small changes");
  await decide(call, "memory.accept", [plain.id]);
  expect((await rules()).text.text).toContain("ship small changes");
});

test("reject closes the proposal and keeps it in history", async () => {
  const { call, rules } = setup();
  const added = await propose(call, "rejected idea");
  expect(await decide(call, "memory.reject", [added.id])).toMatchObject({
    results: [{ id: added.id, status: "rejected" }],
  });
  expect(await call("memory.show", { id: added.id })).toMatchObject({
    status: "found",
    note: { status: "rejected", text: { text: "rejected idea" } },
  });
  const served = await rules();
  expect(served.text.text).not.toContain("rejected idea");
  expect(served.receipt.proposed).toBeUndefined();
  for (const op of ["memory.accept", "memory.reject"] as const)
    expect(await decide(call, op, [added.id])).toMatchObject({
      results: [{ id: added.id, status: "not_proposed" }],
    });

  const rule = await activeRule(call, "keep this text");
  await call("memory.add", { id: rule.id, text: "worse text" });
  await decide(call, "memory.reject", [rule.id]);
  const shown = await call("memory.show", { id: rule.id });
  expect(shown.note.text.text).toBe("keep this text");
  expect(shown.note.proposal).toBeUndefined();
  expect(shown.note.rejectedProposals).toMatchObject([
    { text: { text: "worse text" } },
  ]);
  expect((await rules()).text.text).toContain("keep this text");
});

test("an approval for one revision never accepts or rejects a note edited since", async () => {
  const { call, rules, state } = setup();
  const rule = await activeRule(call, "use bun");
  await call("memory.add", { id: rule.id, text: "use npm" });
  const seen = await decisionItems(call, [rule.id]);
  expect(seen[0]).toMatchObject({ text: "use npm" });
  // The note is edited after the owner was shown "use npm" and before the call lands.
  await call("memory.add", { id: rule.id, text: "use yarn" });
  const writes = state.counts.put + state.counts.putMany;
  for (const op of ["memory.accept", "memory.reject"])
    await refused(
      () => call(op, { items: seen, approval: ownerApproval }),
      "PROPOSAL_CHANGED",
    );
  // Right revision, wrong text, and right text, wrong revision, are both refused.
  const current = await decisionItems(call, [rule.id]);
  await refused(
    () =>
      call("memory.accept", {
        items: [{ ...current[0]!, text: "use npm" }],
        approval: ownerApproval,
      }),
    "PROPOSAL_CHANGED",
  );
  await refused(
    () =>
      call("memory.accept", {
        items: [{ ...current[0]!, revision: current[0]!.revision - 1 }],
        approval: ownerApproval,
      }),
    "PROPOSAL_CHANGED",
  );
  expect(state.counts.put + state.counts.putMany).toBe(writes);
  const served = await rules();
  expect(served.text.text).toContain("use bun");
  expect(served.text.text).not.toMatch(/use (npm|yarn)/);
  // The matching revision and text work, and only then is the new text served.
  expect(await decide(call, "memory.accept", [rule.id])).toMatchObject({
    results: [{ id: rule.id, status: "accepted" }],
  });
  expect((await rules()).text.text).toContain("use yarn");
});

test("a stale item refuses the whole batch before any note is written", async () => {
  const { call, rules, state } = setup();
  const first = await propose(call, "first of two");
  const second = await propose(call, "second of two");
  const items = await decisionItems(call, [first.id, second.id]);
  await call("memory.add", { id: second.id, text: "second changed" });
  const writes = state.counts.put + state.counts.putMany;
  await refused(
    () => call("memory.accept", { items, approval: ownerApproval }),
    "PROPOSAL_CHANGED",
  );
  expect(state.counts.put + state.counts.putMany).toBe(writes);
  expect((await rules()).text.text).not.toMatch(/of two|second changed/);
  for (const id of [first.id, second.id])
    expect(await call("memory.show", { id })).toMatchObject({
      note: { status: "proposed" },
    });
});

test("accept and reject take at most 10 items and report ids that are not found", async () => {
  const { call } = setup();
  expect(
    await call("memory.accept", {
      items: [{ id: "device/note-99", revision: 1, text: "gone" }],
      approval: ownerApproval,
    }),
  ).toMatchObject({ results: [{ id: "device/note-99", status: "not_found" }] });
  harness = await openHarness(["memory"]);
  const items = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: `device/note-${i + 1}`,
      revision: 1,
      text: "x",
    }));
  for (const op of ["memory.accept", "memory.reject"]) {
    const overflow = await harness.call(op, {
      items: items(11),
      approval: ownerApproval,
    });
    expect(overflow.ok).toBe(false);
    expect(JSON.stringify(overflow)).toContain("at most 10 items");
  }
  // Ten items pass the schema; the approval is still required, so the call asks the owner.
  const ten = await harness.call("memory.accept", {
    items: items(10),
    approval: ownerApproval,
  });
  expect(JSON.stringify(ten)).not.toContain("at most 10 items");
});

function pending(result: ResultEnvelope | undefined): string {
  expect(result).toMatchObject({
    ok: false,
    error: { code: "APPROVAL_REQUIRED" },
  });
  const request = record(record(result?.result)?.request);
  expect(request?.id).toMatch(/^[a-f0-9-]{36}$/);
  return String(request?.id);
}

test("the owner's approval of accept and reject binds the operation, the ids and their revisions", async () => {
  harness = await openHarness(["memory"]);
  const h = harness;
  const added = async (text: string) =>
    (
      done(
        await h.call("memory.add", { level: "device", text, tags: ["rule"] }),
      ) as { id: string }
    ).id;
  const shownItem = async (id: string) =>
    decisionItem(
      id,
      done(await h.call("memory.show", { id })) as {
        note: { revision: number; text: { text: string } };
      },
    );
  const first = await added("first proposed rule");
  const second = await added("second proposed rule");
  const firstItem = await shownItem(first);
  const secondItem = await shownItem(second);
  const mcp = createMcpHandlers(h.assembly.catalog, {}, localCall(h.assembly));

  const claim = { by: "owner", quote: "Accept it." };
  const request = pending(
    await mcp.callTool("memory_accept", {
      items: [firstItem],
      approval: claim,
    }),
  );
  expect(done(await h.call("memory.show", { id: first }))).toMatchObject({
    note: { status: "proposed" },
  });
  const reply = { request, quote: claim.quote, source };
  // The reply is bound to these items and to accept: other notes, another revision or text, and
  // reject do not use it.
  for (const [tool, items] of [
    ["memory_accept", [secondItem]],
    ["memory_accept", [firstItem, secondItem]],
    ["memory_accept", [{ ...firstItem, revision: firstItem.revision + 1 }]],
    ["memory_accept", [{ ...firstItem, text: "something else" }]],
    ["memory_reject", [firstItem]],
  ] as const)
    expect(await mcp.callTool(tool, { items, approval: reply })).toMatchObject({
      ok: false,
      error: { code: "APPROVAL_REQUIRED" },
    });
  for (const id of [first, second])
    expect(done(await h.call("memory.show", { id }))).toMatchObject({
      note: { status: "proposed" },
    });
  expect(
    await mcp.callTool("memory_accept", {
      items: [firstItem],
      approval: reply,
    }),
  ).toMatchObject({
    ok: true,
    result: { results: [{ id: first, status: "accepted" }] },
  });
  expect(
    await mcp.callTool("memory_accept", {
      items: [firstItem],
      approval: reply,
    }),
  ).toMatchObject({ ok: false, error: { code: "APPROVAL_REQUIRED" } });

  const rejectRequest = pending(
    await mcp.callTool("memory_reject", {
      items: [secondItem],
      approval: { by: "owner", quote: "No." },
    }),
  );
  expect(
    await mcp.callTool("memory_reject", {
      items: [secondItem],
      approval: { request: rejectRequest, quote: "No.", source },
    }),
  ).toMatchObject({
    ok: true,
    result: { results: [{ id: second, status: "rejected" }] },
  });
  const served = done(await h.call("memory.rules", { notes: true })) as {
    text: { text: string };
  };
  expect(served.text.text).toContain("first proposed rule");
  expect(served.text.text).not.toContain("second proposed rule");
});

test("an owner approval granted for one proposal cannot activate a replacement edited in while it waited", async () => {
  harness = await openHarness(["memory"]);
  const h = harness;
  const added = done(
    await h.call("memory.add", {
      level: "device",
      text: "approved wording",
      tags: ["rule"],
    }),
  ) as { id: string };
  const shown = done(await h.call("memory.show", { id: added.id })) as {
    note: { revision: number; text: { text: string } };
  };
  const items = [decisionItem(added.id, shown)];
  const mcp = createMcpHandlers(h.assembly.catalog, {}, localCall(h.assembly));
  const request = pending(
    await mcp.callTool("memory_accept", {
      items,
      approval: { by: "owner", quote: "Yes, that wording." },
    }),
  );
  // While the owner's reply is on its way, the note is edited to different text.
  done(
    await h.call("memory.add", {
      id: added.id,
      text: "different wording slipped in",
    }),
  );
  const late = await mcp.callTool("memory_accept", {
    items,
    approval: { request, quote: "Yes, that wording.", source },
  });
  expect(late).toMatchObject({
    ok: false,
    error: { code: "PROPOSAL_CHANGED" },
  });
  const served = done(await h.call("memory.rules", { notes: true })) as {
    text: { text: string };
  };
  expect(served.text.text).not.toMatch(/approved wording|different wording/);
});

test("export and restore carry proposed and rejected state and never accept it", async () => {
  const from = setup();
  const proposed = await propose(from.call, "proposed stays proposed");
  const rejected = await propose(from.call, "rejected stays rejected");
  await decide(from.call, "memory.reject", [rejected.id]);
  const edited = await activeRule(from.call, "accepted text");
  await from.call("memory.add", { id: edited.id, text: "pending edit text" });
  const history = await activeRule(from.call, "history text");
  await from.call("memory.add", { id: history.id, text: "rejected edit text" });
  await decide(from.call, "memory.reject", [history.id]);

  const bundle = await from.call<{
    format: string;
    notes: unknown[];
  }>("memory.export", { level: "device" });
  expect(bundle.format).toBe("forge.memory.export/3");
  const restoreInput = {
    ...bundle,
    approval: ownerApproval,
  };
  expect(blockSchema("memory", "restore.input.json")(restoreInput)).toEqual([]);

  const into = setup();
  expect(await into.call("memory.restore", restoreInput)).toMatchObject({
    added: 4,
    conflicts: [],
  });
  const served = await into.rules();
  expect(served.text.text).toContain("accepted text");
  expect(served.text.text).toContain("history text");
  expect(served.text.text).not.toMatch(
    /proposed stays|rejected stays|pending edit|rejected edit/,
  );
  // Two notes are accepted with a pending or rejected revision; two never were accepted.
  expect(served.receipt.selected).toHaveLength(2);
  expect(served.receipt.proposed?.count).toBe(2);
  expect(await into.call("memory.show", { id: proposed.id })).toMatchObject({
    note: { status: "proposed", text: { text: "proposed stays proposed" } },
  });
  const restoredRejected = await into.call("memory.show", {
    id: rejected.id,
  });
  expect(restoredRejected.note.status).toBe("rejected");
  expect(restoredRejected.note.approval).toBeUndefined();
  expect(await into.call("memory.show", { id: edited.id })).toMatchObject({
    note: {
      text: { text: "accepted text" },
      proposal: { text: { text: "pending edit text" } },
    },
  });
  expect(await into.call("memory.show", { id: history.id })).toMatchObject({
    note: {
      text: { text: "history text" },
      rejectedProposals: [{ text: { text: "rejected edit text" } }],
    },
  });
  // The pending items stay pending after the round trip: only an accept serves them.
  await decide(into.call, "memory.accept", [edited.id]);
  expect((await into.rules()).text.text).toContain("pending edit text");
});

test("a bundle with no proposal state stays the format older restorers read", async () => {
  const { call } = setup();
  await call("memory.add", { level: "device", text: "plain note" });
  expect(
    await call<{ format: string }>("memory.export", { level: "device" }),
  ).toMatchObject({ format: "forge.memory.export/2" });
});
