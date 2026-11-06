import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { localCall } from "../../src/assembly/index.ts";
import { LocalState } from "../../src/assembly/state.ts";
import type { ResultEnvelope } from "../../src/generated/types.ts";
import { dispatch, record } from "../../src/surface/dispatch.ts";
import { createMcpHandlers } from "../../src/surface/mcp.ts";
import { done, openHarness, type Harness } from "../blocks/memory/lib.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const source = { harness: "codex", thread: "owner-chat", message: "reply-1" };

function pending(result: ResultEnvelope | undefined): string {
  expect(result).toMatchObject({
    ok: false,
    error: { code: "APPROVAL_REQUIRED" },
  });
  const request = record(record(result?.result)?.request);
  expect(request?.id).toMatch(/^[a-f0-9-]{36}$/);
  expect(typeof request?.ask).toBe("string");
  return String(request?.id);
}

test("an MCP memory_forget needs a relayed single-use owner reply, not a bare quote", async () => {
  h = await openHarness(["memory"]);
  const note = done(
    await h.call("memory.add", {
      level: "device",
      text: "keep me",
      scope: "general",
    }),
  ) as { id: string };
  const mcp = createMcpHandlers(h.assembly.catalog, {}, localCall(h.assembly));
  const bare = { id: note.id, approval: { by: "owner", quote: "yes" } };
  const request = pending(await mcp.callTool("memory_forget", bare));
  expect(done(await h.call("memory.show", { id: note.id }))).toMatchObject({
    status: "found",
    note: { text: { text: "keep me" } },
  });
  for (const approval of [
    { request, quote: "yes" },
    { request, quote: " ", source },
    { by: "owner", request, quote: "yes", source: { harness: "codex" } },
  ])
    expect(
      await mcp.callTool("memory_forget", { id: note.id, approval }),
    ).toMatchObject({ ok: false, error: { code: "APPROVAL_REQUIRED" } });
  expect(done(await h.call("memory.show", { id: note.id }))).toMatchObject({
    status: "found",
  });
  const approval = { request, quote: "yes", source };
  expect(
    await mcp.callTool("memory_forget", { id: note.id, approval }),
  ).toMatchObject({ ok: true, result: { status: "forgotten" } });
  expect(done(await h.call("memory.show", { id: note.id }))).toMatchObject({
    status: "forgotten",
    approval: { by: "owner", quote: { text: "yes" } },
  });
  expect(
    await mcp.callTool("memory_forget", {
      id: note.id,
      undo: true,
      approval,
    }),
  ).toMatchObject({ ok: false, error: { code: "APPROVAL_REQUIRED" } });
  expect(done(await h.call("memory.show", { id: note.id }))).toMatchObject({
    status: "forgotten",
  });
  await h.assembly.close();
  const trust = new LocalState(join(h.deviceRoot, "trust.sqlite"));
  try {
    const owner = await trust.open(false);
    expect(owner?.get("forge/core-approvals", request)?.value).toMatchObject({
      status: "used",
      method: "relayed",
      quote: { kind: "untrusted", text: "yes" },
      source,
    });
  } finally {
    await trust.close();
  }
}, 30_000);

test("memory restore and decision adopt each need a relayed owner reply and then succeed", async () => {
  h = await openHarness(["memory"], {
    "memory.decisions": { idPattern: "ADR-NNN" },
  });
  done(
    await h.call("decision.propose", { title: "Choice", text: "adopt this" }),
  );
  const mcp = createMcpHandlers(h.assembly.catalog, {}, localCall(h.assembly));
  const restore = {
    format: "forge.memory.export/2",
    level: "device",
    notes: [
      {
        id: "device/note-5",
        tags: [],
        links: [],
        text: { kind: "untrusted", source: "test", text: "imported" },
      },
    ],
  };
  const claim = { by: "owner", quote: "Restore the note." };
  const restoreRequest = pending(
    await mcp.callTool("memory_restore", { ...restore, approval: claim }),
  );
  expect(
    done(await h.call("memory.show", { id: "device/note-5" })),
  ).toMatchObject({ status: "not_found" });
  expect(
    await mcp.callTool("memory_restore", {
      ...restore,
      approval: { request: restoreRequest, quote: claim.quote, source },
    }),
  ).toMatchObject({ ok: true, result: { added: 1 } });
  expect(
    await mcp.callTool("memory_restore", {
      ...restore,
      approval: { request: restoreRequest, quote: claim.quote, source },
    }),
  ).toMatchObject({ ok: false, error: { code: "APPROVAL_REQUIRED" } });

  const adoptRequest = pending(
    await mcp.callTool("decision_adopt", {
      id: "ADR-001",
      approval: { by: "owner", quote: "Adopt it." },
    }),
  );
  expect(done(await h.call("decision.list", {}))).toMatchObject({
    decisions: [{ status: "proposed" }],
  });
  expect(
    await mcp.callTool("decision_adopt", {
      id: "ADR-001",
      approval: { request: adoptRequest, quote: "Adopt it.", source },
    }),
  ).toMatchObject({ ok: true, result: { status: "adopted" } });
  expect(done(await h.call("decision.list", {}))).toMatchObject({
    decisions: [{ status: "adopted", approval: { by: "owner" } }],
  });
}, 30_000);

test("a dry run neither burns a valid relayed approval nor writes a request", async () => {
  h = await openHarness(["memory"]);
  const note = done(
    await h.call("memory.add", {
      level: "device",
      text: "keep me",
      scope: "general",
    }),
  ) as { id: string };
  const options = localCall(h.assembly);
  const run = (input: Record<string, unknown>, dryRun = false) =>
    dispatch(h!.assembly.catalog, "memory.forget", input, {
      ...options,
      ...(dryRun ? { dryRun } : {}),
    });
  const claim = { by: "owner", quote: "yes" };
  const request = pending(await run({ id: note.id, approval: claim }));
  // A bare claim with dryRun is refused without creating a pending request.
  expect(await run({ id: note.id, approval: claim }, true)).toMatchObject({
    ok: false,
    error: { code: "UNAVAILABLE" },
  });
  const approval = { request, quote: "yes", source };
  expect(await run({ id: note.id, approval }, true)).toMatchObject({
    ok: false,
    error: { code: "UNAVAILABLE" },
  });
  expect(done(await h.call("memory.show", { id: note.id }))).toMatchObject({
    status: "found",
  });
  expect(await run({ id: note.id, approval })).toMatchObject({
    ok: true,
    result: { status: "forgotten" },
  });
  await h.assembly.close();
  const trust = new LocalState(join(h.deviceRoot, "trust.sqlite"));
  try {
    const owner = await trust.open(false);
    expect(owner?.list("forge/core-approvals")).toHaveLength(1);
  } finally {
    await trust.close();
  }
}, 30_000);
