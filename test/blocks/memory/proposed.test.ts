import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { localCall } from "../../../src/assembly/index.ts";
import type { ResultEnvelope } from "../../../src/generated/types.ts";
import { record } from "../../../src/surface/dispatch.ts";
import { createMcpHandlers } from "../../../src/surface/mcp.ts";
import {
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
async function refused(run: () => unknown) {
  try {
    await run();
  } catch (error) {
    expect(error).toMatchObject({ error: { code: "HUMAN_REQUIRED" } });
    return;
  }
  throw new Error("expected HUMAN_REQUIRED");
}
/** An active rule: added (proposed), then accepted with the owner's approval. */
async function activeRule(
  call: ReturnType<typeof setup>["call"],
  text: string,
) {
  const added = await propose(call, text);
  await call("memory.accept", { ids: [added.id], approval: ownerApproval });
  return added;
}
async function propose(
  call: ReturnType<typeof setup>["call"],
  text: string,
  tags = ["rule"],
) {
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
  const accepted = await call("memory.accept", {
    ids: [added.id],
    approval: ownerApproval,
  });
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
  expect(
    await call("memory.accept", { ids: [added.id], approval: ownerApproval }),
  ).toMatchObject({ results: [{ id: added.id, status: "not_proposed" }] });
});

test("accept and reject refuse a missing or agent approval before any write", async () => {
  const { call, rules, state } = setup();
  const added = await propose(call, "owner only rule");
  const writes = state.counts.put + state.counts.putMany;
  for (const op of ["memory.accept", "memory.reject"])
    for (const approval of [undefined, agent])
      await refused(() => call(op, { ids: [added.id], approval }));
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

  await call("memory.accept", { ids: [added.id], approval: ownerApproval });
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
  await call("memory.accept", { ids: [plain.id], approval: ownerApproval });
  expect((await rules()).text.text).toContain("ship small changes");
});

test("reject closes the proposal and keeps it in history", async () => {
  const { call, rules } = setup();
  const added = await propose(call, "rejected idea");
  expect(
    await call("memory.reject", { ids: [added.id], approval: ownerApproval }),
  ).toMatchObject({ results: [{ id: added.id, status: "rejected" }] });
  expect(await call("memory.show", { id: added.id })).toMatchObject({
    status: "found",
    note: { status: "rejected", text: { text: "rejected idea" } },
  });
  const served = await rules();
  expect(served.text.text).not.toContain("rejected idea");
  expect(served.receipt.proposed).toBeUndefined();
  for (const op of ["memory.accept", "memory.reject"])
    expect(
      await call(op, { ids: [added.id], approval: ownerApproval }),
    ).toMatchObject({ results: [{ id: added.id, status: "not_proposed" }] });

  const rule = await activeRule(call, "keep this text");
  await call("memory.add", { id: rule.id, text: "worse text" });
  await call("memory.reject", { ids: [rule.id], approval: ownerApproval });
  const shown = await call("memory.show", { id: rule.id });
  expect(shown.note.text.text).toBe("keep this text");
  expect(shown.note.proposal).toBeUndefined();
  expect(shown.note.rejectedProposals).toMatchObject([
    { text: { text: "worse text" } },
  ]);
  expect((await rules()).text.text).toContain("keep this text");
});

test("accept and reject take at most 25 ids and report ids that are not found", async () => {
  const { call } = setup();
  expect(
    await call("memory.accept", {
      ids: ["device/note-99"],
      approval: ownerApproval,
    }),
  ).toMatchObject({ results: [{ id: "device/note-99", status: "not_found" }] });
  harness = await openHarness(["memory"]);
  const ids = Array.from({ length: 26 }, (_, i) => `device/note-${i + 1}`);
  const overflow = await harness.call("memory.accept", {
    ids,
    approval: ownerApproval,
  });
  expect(overflow.ok).toBe(false);
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

test("the owner's approval of accept and reject binds the operation and the ids", async () => {
  harness = await openHarness(["memory"]);
  const h = harness;
  const added = async (text: string) =>
    (
      done(
        await h.call("memory.add", { level: "device", text, tags: ["rule"] }),
      ) as { id: string }
    ).id;
  const first = await added("first proposed rule");
  const second = await added("second proposed rule");
  const mcp = createMcpHandlers(h.assembly.catalog, {}, localCall(h.assembly));

  const claim = { by: "owner", quote: "Accept it." };
  const request = pending(
    await mcp.callTool("memory_accept", { ids: [first], approval: claim }),
  );
  expect(done(await h.call("memory.show", { id: first }))).toMatchObject({
    note: { status: "proposed" },
  });
  // The reply is bound to these ids and to accept: other ids and reject do not use it.
  for (const [tool, ids] of [
    ["memory_accept", [second]],
    ["memory_accept", [first, second]],
    ["memory_reject", [first]],
  ] as const)
    expect(
      await mcp.callTool(tool, {
        ids,
        approval: { request, quote: claim.quote, source },
      }),
    ).toMatchObject({ ok: false, error: { code: "APPROVAL_REQUIRED" } });
  for (const id of [first, second])
    expect(done(await h.call("memory.show", { id }))).toMatchObject({
      note: { status: "proposed" },
    });
  expect(
    await mcp.callTool("memory_accept", {
      ids: [first],
      approval: { request, quote: claim.quote, source },
    }),
  ).toMatchObject({
    ok: true,
    result: { results: [{ id: first, status: "accepted" }] },
  });
  expect(
    await mcp.callTool("memory_accept", {
      ids: [first],
      approval: { request, quote: claim.quote, source },
    }),
  ).toMatchObject({ ok: false, error: { code: "APPROVAL_REQUIRED" } });

  const rejectRequest = pending(
    await mcp.callTool("memory_reject", {
      ids: [second],
      approval: { by: "owner", quote: "No." },
    }),
  );
  expect(
    await mcp.callTool("memory_reject", {
      ids: [second],
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
