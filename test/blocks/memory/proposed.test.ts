import { afterEach, expect, mock, setDefaultTimeout, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeBinding } from "../../../src/assembly/cloud-profile.ts";
import { bindingFor, PROJECT_ID } from "../../assembly/cloud-fixture.ts";
import { memoryOwnerAsk } from "../../../src/assembly/approval.ts";
import { localCall } from "../../../src/assembly/index.ts";
import { LocalState } from "../../../src/assembly/state.ts";
import memoryDocs from "../../../src/blocks/memory/docs/records.json" with { type: "json" };
import type { ResultEnvelope } from "../../../src/generated/types.ts";
import { record } from "../../../src/surface/dispatch.ts";
import { createMcpHandlers } from "../../../src/surface/mcp.ts";
import { exitCode } from "../../../src/surface/result.ts";
import {
  approvalRows,
  blockSchema,
  decisionItem,
  decisionItems,
  done,
  loadEntry,
  memoryState,
  openHarness,
  ownerApproval,
  pendingItem,
  stateRows,
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
function setup(state = memoryState()) {
  const entry = loadEntry("memory");
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

const absent = { id: "device/note-999", revision: 1, text: "unseen text" };
const peerIdentity = { id: "0123456789abcdef", name: "peer" };
const peerItem = { ...absent, id: `project/${peerIdentity.id}/note-1` };
type DecisionReply = Pick<Reply, "results">;
const dryDecision = { results: [] };
const unusedApproval = "nothing was written and no owner approval was used";
async function proposalChange(result: Promise<unknown>, message: unknown) {
  await expect(result).rejects.toMatchObject({
    error: { code: "PROPOSAL_CHANGED", message },
  });
}
const writes = (state: ReturnType<typeof memoryState>) => {
  const { put, putMany } = state.counts;
  return { put, putMany };
};

test("the private accept check reports every skipped id without writing", async () => {
  const { call, state } = setup();
  const pending = await propose(call, "pending rule");
  const accepted = await activeRule(call, "accepted rule");
  const [item, served] = await decisionItems(call, [pending.id, accepted.id]);
  const before = writes(state);
  await proposalChange(
    call("memory.accept#check", { items: [item, absent, served, peerItem] }),
    `${absent.id} is not found; ${accepted.id} is not proposed; ${peerItem.id} is not found; ${unusedApproval}. Only pending proposals can be accepted or rejected. Read these items again, ask the owner about what is pending now, and retry without the others.`,
  );
  expect(writes(state)).toEqual(before);
  const shown = await call("memory.show", { id: pending.id });
  expect(shown.note.status).toBe("proposed");
}, 30_000);

test("private decision checks validate current text, revisions, removals and repeated ids", async () => {
  const { call, state } = setup();
  const pending = await propose(call, "pending rule");
  const item = decisionItem(pending.id, pending);
  const { id, revision } = item;
  const stale = { ...item, revision: revision + 1 };
  const alias = { ...item, id: id.replace("note-", "note-0") };
  const { id: active } = await activeRule(call, "active rule");
  const edited = await call("memory.add", {
    id: active,
    text: "revised rule",
    tags: [],
    approval: ownerApproval,
  });
  const { removedOwnerTags, ...unnamed } = decisionItem(active, edited);
  expect(removedOwnerTags).toEqual(["rule"]);
  const before = writes(state);
  const message = (requested: number, approval: string, outcome: string) =>
    `${id} is at revision ${revision}, not the revision ${requested}${approval}, or its proposed text differs; ${outcome}. Show it again, ask the owner about what it says now, and retry with that revision and text.`;
  const removal = (outcome: string) =>
    `${active} removes the owner tags [rule]; ${outcome}. Retry with removedOwnerTags set to that list.`;
  const accept = (items: readonly unknown[]) =>
    call<DecisionReply>("memory.accept#check", { items });
  const write = (item: unknown) =>
    call("memory.accept", { items: [item], approval: ownerApproval });
  const writeMessage = message(
    stale.revision,
    " the owner approved",
    "nothing was written",
  );
  await proposalChange(write(stale), writeMessage);
  await proposalChange(write(unnamed), removal("nothing was written"));
  for (const [items, requested] of [
    [[stale], stale.revision],
    [[{ ...item, text: "other text" }], revision],
    [[{ id, revision }], revision],
    [[absent, stale], stale.revision],
    [[item, { ...alias, revision: stale.revision }], stale.revision],
  ] as const)
    await proposalChange(accept(items), message(requested, "", unusedApproval));
  await proposalChange(accept([unnamed]), removal(unusedApproval));
  const rejected = await call<DecisionReply>("memory.reject#check", {
    items: [{ id, revision }],
  });
  expect(rejected).toEqual(dryDecision);
  expect(await accept([item, alias])).toEqual(dryDecision);
  expect(writes(state)).toEqual(before);
}, 30_000);

test("the private accept check refuses an existing read-only peer proposal", async () => {
  const peer = setup();
  const added = await propose(peer.call, "peer rule");
  const { state: peerState } = peer;
  const found = {
    status: "found" as const,
    identity: peerIdentity,
    state: peerState,
  };
  const state = memoryState(undefined, { peer: () => Promise.resolve(found) });
  const before = writes(peer.state);
  const item = decisionItem(peerItem.id, added);
  await proposalChange(
    setup(state).call("memory.accept#check", { items: [item] }),
    expect.stringContaining(`${item.id} is read only; ${unusedApproval}.`),
  );
  expect(writes(peer.state)).toEqual(before);
}, 30_000);

test("honest private accept and reject checks write neither device nor own-project notes", async () => {
  const project = memoryState();
  const identity = peerIdentity;
  const ownStore = { identity, projectId: identity.id, state: project };
  const state = memoryState(undefined, {
    inProject: true,
    project: () => Promise.resolve(ownStore),
  });
  const { call } = setup(state);
  const first = await propose(call, "first device rule");
  const second = await propose(call, "second device rule");
  const own = await call("memory.add", {
    level: "project",
    tags: ["rule"],
    text: "own project rule",
  });
  const items = await decisionItems(call, [first.id, second.id, own.id]);
  const before = [writes(state), writes(project)];
  for (const op of ["memory.accept#check", "memory.reject#check"])
    expect(await call<DecisionReply>(op, { items })).toEqual(dryDecision);
  expect([writes(state), writes(project)]).toEqual(before);
}, 30_000);

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
    message: "1 proposed note awaits owner review",
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
  const raw = decision(harness);
  const before = await approvalRows(harness);
  const items = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: `device/note-${i + 1}`,
      revision: 1,
      text: "x",
    }));
  for (const op of ["memory.accept", "memory.reject"]) {
    const overflow = await raw(op, items(11));
    expect(overflow.ok).toBe(false);
    refusal(overflow, "INPUT_INVALID");
    expect(JSON.stringify(overflow)).toContain("at most 10 items");
  }
  const ten = await raw("memory.accept", items(10));
  expect(JSON.stringify(ten)).not.toContain("at most 10 items");
  refusal(ten, "PROPOSAL_CHANGED");
  for (const item of items(10))
    expect(JSON.stringify(ten)).toContain(item.id + " is not found");
  expect(await approvalRows(harness)).toEqual(before);
}, 30_000);

function pending(result: ResultEnvelope | undefined): string {
  expect(result).toMatchObject({
    ok: false,
    error: { code: "APPROVAL_REQUIRED" },
  });
  const request = record(record(result?.result)?.request);
  expect(request?.id).toMatch(/^[a-f0-9-]{36}$/);
  return String(request?.id);
}

const registry = "forge/core-projects";
const devicePath = (h: Harness) => join(h.deviceRoot, "records.sqlite");
const projectPath = (h: Harness) => join(h.root, ".forge", "state.sqlite");
const manifestPath = (h: Harness) => join(h.root, ".forge", "project.json");
const mcpFor = (h: Harness, readOnly = false) =>
  createMcpHandlers(h.assembly.catalog, { readOnly }, localCall(h.assembly));
const harnessCall =
  (h: Harness): Call =>
  async <T>(op: string, input: unknown) =>
    done(await h.call(op, input)) as T;
const claim = ownerApproval;

const failureExits: Record<string, number> = {
  GRANT_REQUIRED: 2,
  UNKNOWN_COMMAND: 3,
  INPUT_CONFLICT: 4,
  INPUT_INVALID: 6,
};
function refusal(
  result: ResultEnvelope | undefined,
  code: string,
  message?: RegExp,
) {
  const exit = failureExits[code] ?? 1;
  expect(result).toMatchObject({
    ok: false,
    status: exit === 2 ? "INCOMPLETE" : "FAIL",
    error: { code },
  });
  if (message && result?.ok === false)
    expect(result.error.message).toMatch(message);
  expect(exitCode(result!)).toBe(exit);
}

async function unspent(
  h: Harness,
  answer: () => Promise<ResultEnvelope | undefined>,
  code: string,
  message?: RegExp,
) {
  const before = await approvalRows(h);
  const result = await answer();
  refusal(result, code, message);
  expect(await approvalRows(h)).toEqual(before);
  return JSON.stringify(result);
}

const decision =
  (h: Harness) =>
  (op: string, items: unknown[], approval: unknown = claim) =>
    h.invoke(op, { items, approval }, { caller: "agent" });
const relay = (request: string) => ({ request, quote: claim.quote, source });

async function storedReply(h: Harness, result: ResultEnvelope) {
  const request = pending(result);
  const row = (await approvalRows(h)).find((row) => row.key === request);
  expect(row?.value).toMatchObject({ status: "pending" });
  return relay(request);
}

async function ruleRemoval(call: Call) {
  const { id } = await activeRule(call, "Keep the accepted rule");
  const { note } = await call("memory.show", { id });
  const edit = await call("memory.add", {
    id,
    expectRevision: note.revision,
    text: "Change the accepted rule",
    tags: [],
  });
  return { ...decisionItem(id, edit), removedOwnerTags: [] };
}

const unseen = "Keep all existing owner decisions.";
const invalidBatches = [
  ["accept", "absent", /device\/note-999 is not found/],
  ["reject", "absent", /device\/note-999 is not found/],
  ["accept", "served", /is not proposed/],
  ["accept", "revision", /is at revision/],
  ["reject", "revision", /is at revision/],
  ["accept", "text", /proposed text differs/],
  ["reject", "text", /proposed text differs/],
  ["accept", "tags", /removes the owner tags \[rule\]/],
  ["accept", "noText", /memory\.accept/],
  ["reject", "extraTags", /memory\.reject/],
] as const;
for (const [verb, kind, message] of invalidBatches)
  test(`${verb} checks ${kind} before asking`, async () => {
    const h = (harness = await openHarness(["memory"]));
    const call = harnessCall(h);
    const real = await pendingItem(h);
    const id =
      kind === "served"
        ? (await activeRule(call, "Keep this served rule")).id
        : real.id;
    const shows = () =>
      Promise.all([id, real.id].map((id) => call("memory.show", { id })));
    const before = await shows();
    const { text: _text, ...noText } = real;
    const overrides = {
      absent: { ...absent, text: unseen },
      served: { id, revision: before[0]!.note.revision + 1, text: unseen },
      revision: { ...real, revision: real.revision + 1 },
      text: { ...real, text: unseen },
      tags: kind === "tags" ? await ruleRemoval(call) : real,
      noText,
      extraTags: { ...real, removedOwnerTags: ["rule"] },
    };
    const input = { items: [real, overrides[kind]], approval: claim };
    const answer = () => mcpFor(h).callTool("memory_" + verb, input);
    const code =
      kind === "noText" || kind === "extraTags"
        ? "INPUT_INVALID"
        : "PROPOSAL_CHANGED";
    const text = await unspent(h, answer, code, message);
    if (kind === "absent") expect(text).not.toContain(unseen);
    expect(await shows()).toEqual(before);
  }, 30_000);

test("check uses the resolved memory instance", async () => {
  const h = (harness = await openHarness(["memory"], {
    "/blocks/memory-b": {
      source: { path: "./blocks/memory" },
      rename: { memory: "memb", decision: "decb" },
      config: { approval: { ownerTags: ["custom"] } },
    },
  }));
  const input = { items: [await ruleRemoval(harnessCall(h))], approval: claim };
  const before = await approvalRows(h);
  pending(await mcpFor(h).callTool("memb_accept", input));
  expect(await approvalRows(h)).toHaveLength(before.length + 1);
  const answer = () => mcpFor(h).callTool("memory_accept", input);
  await unspent(h, answer, "PROPOSAL_CHANGED");
}, 30_000);

for (const phase of ["ask", "reply"] as const)
  test(`checks grant on ${phase}`, async () => {
    const effects = ["decision:write"];
    const h = (harness = await openHarness(
      ["memory"],
      {},
      phase === "ask" ? { grants: effects } : {},
    ));
    const decide = decision(h);
    const op = "memory.accept";
    let items = [absent];
    let approval: unknown = claim;
    if (phase === "reply") {
      items = [await pendingItem(h)];
      approval = await storedReply(h, await decide(op, items));
      const trust = new LocalState(join(h.deviceRoot, "trust.sqlite"));
      try {
        const owner = (await trust.open(true))!;
        const namespace = "forge/core-trust";
        const [row] = owner.list(namespace);
        owner.put(
          namespace,
          row!.key,
          { admitted: true, effects },
          row!.updatedBy,
          {
            expectRevision: row!.revision,
          },
        );
      } finally {
        await trust.close();
      }
    }
    await unspent(h, () => decide(op, items, approval), "GRANT_REQUIRED");
  }, 30_000);

for (const level of ["project", "device"] as const)
  test(`checks missing ${level} store`, async () => {
    const h = (harness = await openHarness(["memory"]));
    const project = level === "project";
    const path = project ? projectPath(h) : devicePath(h);
    const files = () => [existsSync(path), existsSync(manifestPath(h))];
    const items = project ? [await pendingItem(h), peerItem] : [absent];
    const entries = await stateRows(devicePath(h), registry);
    expect(files()).toEqual([false, false]);
    const answer = () => decision(h)("memory.accept", items);
    await unspent(h, answer, "PROPOSAL_CHANGED", /is not found/);
    expect(files()).toEqual([false, false]);
    expect(await stateRows(devicePath(h), registry)).toEqual(entries);
  }, 30_000);

const projectChecks = [
  "mismatch",
  "accept ask",
  "reject ask",
  "accept reply",
  "reject reply",
  "peer",
  "attended",
  "device",
] as const;
for (const mode of projectChecks)
  test(`checks project ${mode}`, async () => {
    const confirm = mock(() => Promise.resolve(true));
    let stdin = false;
    const terminal = { tty: () => ({ stdin, stderr: true }), confirm };
    const h = (harness = await openHarness(["memory"], {}, { terminal }));
    const manifest = (id: string) =>
      writeFileSync(manifestPath(h), JSON.stringify({ schema: 1, id }));
    manifest(PROJECT_ID);
    const project = await pendingItem(h, "Keep this project rule", "project");
    const items = [mode === "peer" ? peerItem : project];
    const op = mode.startsWith("reject") ? "memory.reject" : "memory.accept";
    const decide = decision(h);
    const approval = mode.endsWith("reply")
      ? await storedReply(h, await decide(op, items))
      : claim;
    if (mode === "mismatch") manifest("a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d");
    else writeBinding(h.root, bindingFor());
    if (mode === "device") {
      const device = [await pendingItem(h)];
      const before = await approvalRows(h);
      const request = pending(await decide(op, device));
      expect(await approvalRows(h)).toHaveLength(before.length + 1);
      expect(exitCode(await decide(op, device, relay(request)))).toBe(0);
      return;
    }
    const snapshot = () =>
      Promise.all([
        stateRows(projectPath(h), "forge/core-project"),
        stateRows(projectPath(h), "forge/memory"),
        stateRows(devicePath(h), registry),
        stateRows(devicePath(h), "forge/memory"),
      ]);
    const before = await snapshot();
    stdin = mode === "attended";
    const answer = () =>
      stdin ? h.invoke(op, { items }) : decide(op, items, approval);
    const code = mode === "mismatch" ? "PROJECT_ID_CONFLICT" : "UNAVAILABLE";
    await unspent(h, answer, code);
    expect(confirm).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  }, 30_000);

const replies = [
  ["accept", "withdraw"],
  ["reject", "withdraw"],
  ["accept", "edit"],
  ["reject", "edit"],
  ["accept", "rebind"],
  ["accept", "device"],
  ["accept", "project"],
] as const;
for (const [verb, mode] of replies)
  test(`${verb} checks reply after ${mode}`, async () => {
    const h = (harness = await openHarness(["memory"]));
    const call = harnessCall(h);
    const item = await pendingItem(h);
    const second =
      mode === "withdraw"
        ? await pendingItem(h, "Keep a second rule")
        : undefined;
    const items = second ? [item, second] : [item];
    const op = "memory." + verb;
    const approval = await storedReply(h, await decision(h)(op, items));
    let message = /is at revision/;
    if (second) {
      const { id, revision } = second;
      await call("memory.withdraw", {
        items: [{ id, revision }],
        reason: "Superseded",
      });
      message = new RegExp(id + " is not proposed");
    } else if (mode === "edit" || mode === "rebind") {
      const edit = await call("memory.add", {
        id: item.id,
        expectRevision: item.revision,
        text: "Replacement rule",
      });
      if (mode === "rebind") items[0] = decisionItem(item.id, edit);
    }
    const id = join(h.work, "other");
    const foreign =
      mode === "project"
        ? { project: { id, root: id } }
        : { device: { id: mode === "device" ? id : h.deviceRoot } };
    const options = {
      caller: "agent",
      context: { ...h.deviceOnly(), ...foreign },
    } as const;
    const answer = () => h.invoke(op, { items, approval }, options);
    if (mode === "project") {
      expect(exitCode(await answer())).toBe(0);
      return;
    }
    const before = await call("memory.show", { id: item.id });
    const codes: Record<string, string> = {
      device: "INPUT_CONFLICT",
      rebind: "APPROVAL_REQUIRED",
    };
    const code = codes[mode] ?? "PROPOSAL_CHANGED";
    if (mode === "rebind") message = /bound to different arguments/;
    await unspent(h, answer, code, mode === "device" ? undefined : message);
    expect(await call("memory.show", { id: item.id })).toEqual(before);
  }, 30_000);

test("decision help describes changes after approval checking", () => {
  for (const op of ["memory.accept", "memory.reject"] as const)
    expect(memoryDocs.operations[op].description).toContain(
      "If a note changes afterwards, the call itself fails with PROPOSAL_CHANGED when the revision or text of a still-pending proposal differs. It reports and leaves alone items that are not proposed, not found or read-only. By then, the owner's approval has been used.",
    );
}, 30_000);

test("dry run and read-only MCP refuse before asking", async () => {
  const h = (harness = await openHarness(["memory"]));
  const input = { items: [absent], approval: claim };
  const dry = () => h.invoke("memory.accept", input, { dryRun: true });
  const readOnly = () => mcpFor(h, true).callTool("memory_accept", input);
  await unspent(h, dry, "UNAVAILABLE");
  await unspent(h, readOnly, "UNKNOWN_COMMAND");
}, 30_000);

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
  for (const [tool, items] of [
    ["memory_accept", [secondItem]],
    ["memory_accept", [firstItem, secondItem]],
    ["memory_reject", [firstItem]],
  ] as const)
    expect(await mcp.callTool(tool, { items, approval: reply })).toMatchObject({
      ok: false,
      error: { code: "APPROVAL_REQUIRED" },
    });
  for (const items of [
    [{ ...firstItem, revision: firstItem.revision + 1 }],
    [{ ...firstItem, text: "something else" }],
  ])
    refusal(
      await mcp.callTool("memory_accept", { items, approval: reply }),
      "PROPOSAL_CHANGED",
    );
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
  ).toMatchObject({ ok: false, error: { code: "PROPOSAL_CHANGED" } });

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

test("the owner's question shows the whole proposed text of every item", async () => {
  const h = await openHarness(["memory"]);
  harness = h;
  const call: Call = async <T>(op: string, input: unknown) =>
    done(await h.call(op, input)) as T;
  const first =
    'Use safe defaults.\nremoves owner tags: none\r\nThird line stays too. "\\u0009\t\u2028\u2029\u202e\u200d';
  const second = `${"long ".repeat(60)}ends with the secret tail`;
  const { id } = await activeRule(call, "Original rule");
  const { note } = await call("memory.show", { id });
  const edit = await call("memory.add", {
    id,
    expectRevision: note.revision,
    text: first,
    tags: [],
    approval: ownerApproval,
  });
  const revised = decisionItem(id, edit);
  const long = await propose(call, second);
  const secondItem = decisionItem(long.id, long);
  expect(revised).toMatchObject({ text: first, removedOwnerTags: ["rule"] });
  expect(secondItem.text).toBe(second);
  const pendingOther = await propose(call, "A separate proposal for rejection");
  const other = await call("memory.add", {
    id: pendingOther.id,
    expectRevision: pendingOther.note.revision,
    text: `${second}\u{e0020}`,
  });
  const otherItem = decisionItem(pendingOther.id, other);
  const { removedOwnerTags: _tags, ...withoutTags } = revised;
  const mcp = createMcpHandlers(h.assembly.catalog, {}, localCall(h.assembly));
  const trust = new LocalState(join(h.deviceRoot, "trust.sqlite"));
  const asks = [];
  try {
    for (const [op, items] of [
      ["memory.accept", [revised, secondItem]],
      ["memory.reject", [withoutTags, otherItem]],
    ] as const) {
      const tool = op.replace(".", "_");
      const earliestExpiry = Date.now() + 86_400_000;
      const response = await mcp.callTool(tool, {
        items,
        approval: { by: "owner", quote: "Reviewed." },
      });
      const requestId = pending(response);
      expect(exitCode(response!)).toBe(1);
      const request = record(record(response?.result)?.request);
      const owner = await trust.open(false);
      const stored = record(
        owner?.get("forge/core-approvals", requestId)?.value,
      );
      expect(stored).toMatchObject({
        id: requestId,
        ask: memoryOwnerAsk(op, { items }),
        binding: request?.binding,
        status: "pending",
      });
      const expiresAt = Number(stored?.expiresAt);
      expect(expiresAt).toBeGreaterThanOrEqual(earliestExpiry);
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + 86_400_000);
      asks.push(request?.ask);
      if (op === "memory.reject") {
        const approval = { request: requestId, quote: "Reject those.", source };
        const text = first.replace("\r\n", "\n");
        const changed = await mcp.callTool(tool, {
          items: [{ ...withoutTags, text }, otherItem],
          approval,
        });
        expect(changed).toMatchObject({
          ok: false,
          error: { code: "PROPOSAL_CHANGED" },
        });
        const reply = await mcp.callTool(tool, { items, approval });
        expect(exitCode(reply!)).toBe(0);
        expect(reply?.result).toMatchObject({
          results: [
            { id: revised.id, status: "rejected" },
            { id: otherItem.id, status: "rejected" },
          ],
        });
      }
    }
  } finally {
    await trust.close();
  }
  const displayedFirst = `- "${revised.id}" (revision "${revised.revision}"):\n    "Use safe defaults.\\u000aremoves owner tags: none\\u000d\\u000aThird line stays too. \\"\\\\u0009\\u0009\\u2028\\u2029\\u202e\\u200d"`;
  expect(asks).toEqual([
    `Accept these proposed notes so they are served to every session:\n${displayedFirst}\nremoves owner tags: "rule"\n- "${secondItem.id}" (revision "${secondItem.revision}"):\n    "${second}"`,
    `Reject these proposed notes; they stay in history and are never served:\n${displayedFirst}\n- "${otherItem.id}" (revision "${otherItem.revision}"):\n    "${second}\\udb40\\udc20"`,
  ]);
}, 30_000);

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
      expectRevision: shown.note.revision,
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

test("export and restore keep proposed and rejected state and never accept a new owner-tagged note", async () => {
  const from = setup();
  const proposed = await propose(from.call, "proposed stays proposed");
  const rejected = await propose(from.call, "rejected stays rejected");
  await decide(from.call, "memory.reject", [rejected.id]);
  const edited = await activeRule(from.call, "accepted text");
  await from.call("memory.add", { id: edited.id, text: "pending edit text" });
  const history = await activeRule(from.call, "history text");
  await from.call("memory.add", { id: history.id, text: "rejected edit text" });
  await decide(from.call, "memory.reject", [history.id]);
  const plain = await from.call("memory.add", {
    level: "device",
    text: "plain note text",
    tags: ["fact"],
  });
  await from.call("memory.add", {
    id: plain.id,
    text: "plain note text",
    tags: ["fact", "rule"],
  });

  // A real export crosses the wire as JSON; the block's own objects are not plain objects here.
  const bundle = JSON.parse(
    JSON.stringify(await from.call("memory.export", { level: "device" })),
  ) as { format: string; notes: unknown[] };
  expect(bundle.format).toBe("forge.memory.export/3");
  const restoreInput = {
    ...bundle,
    approval: ownerApproval,
  };
  expect(blockSchema("memory", "restore.input.json")(restoreInput)).toEqual([]);

  const into = setup();
  expect(
    await into.call<{ added: number; conflicts: string[]; notice?: string }>(
      "memory.restore",
      restoreInput,
    ),
  ).toMatchObject({
    added: 5,
    conflicts: [],
    notice:
      "4 owner-tagged notes restored as proposals; accept them with memory.accept.",
  });
  // A bundle is never proof of acceptance: every owner-tagged note comes back waiting.
  const served = await into.rules();
  expect(served.text.text).not.toMatch(
    /proposed stays|rejected stays|accepted text|history text|pending edit|rejected edit/,
  );
  expect(served.receipt.selected).toEqual([]);
  expect(served.receipt.proposed?.count).toBe(5);
  expect(await into.call("memory.show", { id: proposed.id })).toMatchObject({
    note: { status: "proposed", text: { text: "proposed stays proposed" } },
  });
  const restoredRejected = await into.call("memory.show", {
    id: rejected.id,
  });
  // A new owner-tagged note always restores as a proposal, even one that was rejected where it was exported.
  expect(restoredRejected.note.status).toBe("proposed");
  expect(restoredRejected.note.approval).toBeUndefined();
  // A rule that was accepted where it was exported comes back as a proposal of its served text.
  const restoredEdited = await into.call("memory.show", { id: edited.id });
  expect(restoredEdited.note).toMatchObject({
    status: "proposed",
    text: { text: "accepted text" },
  });
  expect(restoredEdited.note.proposal).toBeUndefined();
  // Rejection history survives; so does a pending revision on a note that is not owner-tagged.
  expect(await into.call("memory.show", { id: history.id })).toMatchObject({
    note: {
      status: "proposed",
      text: { text: "history text" },
      rejectedProposals: [{ text: { text: "rejected edit text" } }],
    },
  });
  expect(await into.call("memory.show", { id: plain.id })).toMatchObject({
    note: {
      text: { text: "plain note text" },
      proposal: { tags: ["fact", "rule"] },
    },
  });
  // Only an accept serves them.
  await decide(into.call, "memory.accept", [edited.id, history.id]);
  const after = (await into.rules()).text.text;
  expect(after).toContain("accepted text");
  expect(after).toContain("history text");
  expect(after).not.toMatch(/proposed stays|rejected stays/);
});

test("restore stores a new owner-tagged note as a proposal whatever status the bundle claims", async () => {
  const { call, rules } = setup();
  const notes = [
    {
      id: "device/note-1",
      tags: ["rule"],
      links: [],
      text: { text: "rule with no status" },
    },
    {
      id: "device/note-2",
      tags: ["rule", "preference"],
      links: [],
      text: { text: "rule claiming to be active" },
      status: "active",
    },
  ];
  const result = await call<{ added: number; notice?: string }>(
    "memory.restore",
    {
      format: "forge.memory.export/3",
      level: "device",
      notes,
      approval: ownerApproval,
    },
  );
  expect(result).toMatchObject({
    added: 2,
    notice:
      "2 owner-tagged notes restored as proposals; accept them with memory.accept.",
  });
  const served = await rules();
  expect(served.text.text).not.toMatch(/no status|claiming to be active/);
  expect(served.receipt.selected).toEqual([]);
  expect(served.receipt.proposed?.count).toBe(2);
  for (const id of ["device/note-1", "device/note-2"]) {
    const shown = await call("memory.show", { id });
    expect(shown.note.status).toBe("proposed");
    expect(shown.note.approval).toBeUndefined();
  }
  await decide(call, "memory.accept", ["device/note-1", "device/note-2"]);
  const after = (await rules()).text.text;
  expect(after).toContain("rule with no status");
  expect(after).toContain("rule claiming to be active");
});

test("restore brings a rejected owner-tagged note back as a proposal the owner can accept", async () => {
  const { call, rules } = setup();
  await call("memory.restore", {
    format: "forge.memory.export/3",
    level: "device",
    notes: [
      {
        id: "device/note-1",
        tags: ["rule"],
        links: [],
        text: { text: "rule that was rejected" },
        status: "rejected",
      },
    ],
    approval: ownerApproval,
  });
  expect((await call("memory.show", { id: "device/note-1" })).note.status).toBe(
    "proposed",
  );
  expect((await rules()).text.text).not.toContain("rule that was rejected");
  await decide(call, "memory.accept", ["device/note-1"]);
  expect((await rules()).text.text).toContain("rule that was rejected");
});

const restoreLimit = 8000;
const restoreShapes = {
  "an owner-tagged note": (text: string) => ({
    tags: ["rule"],
    text: { text },
  }),
  "a rejected owner-tagged note": (text: string) => ({
    tags: ["rule"],
    text: { text },
    status: "rejected",
  }),
  "a pending proposal": (text: string) => ({
    tags: ["fact"],
    text: { text: "short" },
    proposal: {
      text: { kind: "untrusted", source: "export", text },
      tags: ["fact"],
      links: [],
      at: "2026-01-01T00:00:00Z",
    },
  }),
} as const;

for (const [name, shape] of Object.entries(restoreShapes)) {
  test(`restore refuses ${name} over the accept limit before writing anything`, async () => {
    const { call, state } = setup();
    const writes = state.counts.put + state.counts.putMany;
    await refused(
      () =>
        call("memory.restore", {
          format: "forge.memory.export/3",
          level: "device",
          notes: [
            {
              id: "device/note-1",
              links: [],
              ...shape("x".repeat(restoreLimit + 1)),
            },
            {
              id: "device/note-2",
              tags: ["fact"],
              links: [],
              text: { text: "a fine note" },
            },
          ],
          approval: ownerApproval,
        }),
      "RESTORE_TEXT_TOO_LONG",
    );
    expect(state.counts.put + state.counts.putMany).toBe(writes);
    expect(
      await call<{ hits: unknown[] }>("memory.search", {
        level: "device",
        query: "fine",
      }),
    ).toMatchObject({ hits: [] });
  });
}

test("restore accepts text of exactly the accept limit, and the owner can accept it unchanged", async () => {
  const { call } = setup();
  const text = "y".repeat(restoreLimit);
  const result = await call<{ added: number }>("memory.restore", {
    format: "forge.memory.export/3",
    level: "device",
    notes: [
      {
        id: "device/note-1",
        tags: ["rule"],
        links: [],
        text: { text },
      },
    ],
    approval: ownerApproval,
  });
  expect(result.added).toBe(1);
  await decide(call, "memory.accept", ["device/note-1"]);
  expect(
    (await call("memory.show", { id: "device/note-1" })).note.status,
  ).toBeUndefined();
});

test("a bundle with no proposal state stays the format older restorers read", async () => {
  const { call } = setup();
  await call("memory.add", { level: "device", text: "plain note" });
  expect(
    await call<{ format: string }>("memory.export", { level: "device" }),
  ).toMatchObject({ format: "forge.memory.export/2" });
});

test("accept checks every item before writing and treats note ids that resolve to one note as one", async () => {
  const { call, rules, state } = setup();
  const added = await propose(call, "alias rule");
  const [item] = await decisionItems(call, [added.id]);
  const alias = { ...item!, id: added.id.replace("note-", "note-0") };
  const writes = state.counts.put + state.counts.putMany;
  // A repeated id with a stale revision is still checked: nothing is written.
  await refused(
    () =>
      call("memory.accept", {
        items: [item, { ...item!, revision: item!.revision + 1 }],
        approval: ownerApproval,
      }),
    "PROPOSAL_CHANGED",
  );
  expect(state.counts.put + state.counts.putMany).toBe(writes);
  expect((await rules()).text.text).not.toContain("alias rule");
  // note-1 and note-01 are the same note: written once, reported once.
  const accepted = await call("memory.accept", {
    items: [item, alias],
    approval: ownerApproval,
  });
  expect(accepted.results).toEqual([{ id: added.id, status: "accepted" }]);
  expect((await rules()).text.text).toContain("alias rule");
});

test("removing one owner tag while another stays never lets changed text skip the owner", async () => {
  const { call, rules } = setup();
  const added = await propose(call, "keep both tags", ["rule", "preference"]);
  await decide(call, "memory.accept", [added.id]);
  const edited = await call("memory.add", {
    id: added.id,
    text: "text changed with a tag removal",
    tags: ["rule"],
    approval: ownerApproval,
  });
  expect(edited.note.text.text).toBe("keep both tags");
  expect(edited.note.tags).toEqual(["rule", "preference"]);
  expect(edited.note.proposal?.text.text).toBe(
    "text changed with a tag removal",
  );
  const served = await rules();
  expect(served.text.text).toContain("keep both tags");
  expect(served.text.text).not.toContain("text changed with a tag removal");
  await decide(call, "memory.accept", [added.id]);
  const shown = await call("memory.show", { id: added.id });
  expect(shown.note.tags).toEqual(["rule"]);
  expect(shown.note.text.text).toBe("text changed with a tag removal");
});

test("editing a rejected owner-tagged note proposes it again for the owner", async () => {
  const { call, rules } = setup();
  const added = await propose(call, "first try");
  await decide(call, "memory.reject", [added.id]);
  const edited = await call("memory.add", {
    id: added.id,
    text: "better try",
  });
  expect(edited.note.status).toBe("proposed");
  expect(edited.notice).toContain("proposed again");
  expect((await rules()).text.text).not.toContain("better try");
  expect(await decide(call, "memory.accept", [added.id])).toMatchObject({
    results: [{ id: added.id, status: "accepted" }],
  });
  expect((await rules()).text.text).toContain("better try");
});

test("search finds a pending revision by the tag it proposes", async () => {
  const { call } = setup();
  const plain = await call("memory.add", {
    level: "device",
    text: "release checklist",
    tags: ["fact"],
  });
  await call("memory.add", {
    id: plain.id,
    text: "release checklist",
    tags: ["fact", "rule"],
  });
  const found = await call<{ hits: { id: string }[] }>("memory.search", {
    query: "release checklist",
    tag: "rule",
  });
  expect(found.hits.map((hit) => hit.id)).toEqual([plain.id]);
});

test("restore leaves alone a note that is both never accepted and carrying a pending revision", async () => {
  const { call, rules } = setup();
  const proposal = {
    text: { text: "pending text" },
    tags: ["rule"],
    links: [] as string[],
    at: "2026-11-01T00:00:00Z",
  };
  const result = await call<{ added: number; conflicts: string[] }>(
    "memory.restore",
    {
      format: "forge.memory.export/3",
      level: "device",
      notes: [
        {
          id: "device/note-5",
          tags: ["rule"],
          links: [],
          text: { text: "unaccepted base text" },
          status: "proposed",
          proposal,
        },
      ],
      approval: ownerApproval,
    },
  );
  expect(result.added).toBe(0);
  expect(result.conflicts).toEqual(["device/note-5"]);
  expect((await rules()).text.text).not.toContain("unaccepted base text");
});
