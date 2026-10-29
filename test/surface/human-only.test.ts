import { afterEach, expect, spyOn, test } from "bun:test";
import { PassThrough } from "node:stream";
import { localCall } from "../../src/assembly/index.ts";
import { dispatch } from "../../src/surface/dispatch.ts";
import { createMcpHandlers } from "../../src/surface/mcp.ts";
import { done, openHarness, type Harness } from "../blocks/memory/lib.ts";
import { candidate, fakeCatalog } from "./fixtures/catalog.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

test("noninteractive local calls need conversation approval and preserve notes and decisions", async () => {
  h = await openHarness(["memory"], {
    "memory.decisions": { idPattern: "ADR-NNN" },
  });
  done(await h.call("memory.add", { level: "device", text: "owner rule" }));
  done(
    await h.call("decision.propose", {
      title: "Owner choice",
      text: "keep it",
    }),
  );
  const options = localCall(h.assembly);
  const before = done(await h.call("memory.show", { id: "device/note-1" }));
  const mcp = createMcpHandlers(h.assembly.catalog, {}, options);
  const cases = [
    ["memory.forget", { id: "device/note-1" }],
    [
      "memory.restore",
      { format: "forge.memory.export/2", level: "device", notes: [] },
    ],
    ["decision.adopt", { id: "ADR-001" }],
  ] as const;
  for (const [op, input] of cases) {
    const result = await dispatch(h.assembly.catalog, op, input, options);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "HUMAN_REQUIRED" },
    });
    expect(!result.ok && result.error.repair).toContain(
      "Ask the owner in the conversation",
    );
    expect(await mcp.callTool("catalog_call", { op, input })).toMatchObject({
      ok: false,
      error: { code: "HUMAN_REQUIRED" },
    });
    expect(await mcp.callTool(op.replace(".", "_"), input)).toMatchObject({
      ok: false,
      error: { code: "HUMAN_REQUIRED" },
    });
  }
  expect(done(await h.call("memory.show", { id: "device/note-1" }))).toEqual(
    before,
  );
  expect(done(await h.call("decision.list", {}))).toMatchObject({
    decisions: [{ status: "proposed" }],
  });
  const overflow = await dispatch(
    h.assembly.catalog,
    "catalog.call",
    {
      op: "memory.forget",
      input: { id: "device/note-1" },
      context: {
        actor: { kind: "human", id: "owner" },
        device: { id: h.deviceRoot },
      },
    },
    options,
  );
  expect(overflow).toMatchObject({
    ok: false,
    error: { code: "HUMAN_REQUIRED" },
  });
}, 30_000);

test("failed terminal confirmation preserves the operation refusal", async () => {
  const catalog = fakeCatalog(
    [
      {
        ...candidate("memory.forget"),
        blockId: "forge/memory",
        declaredOp: "memory.forget",
      },
    ],
    {
      ok: false,
      op: "memory.forget",
      status: "FAIL",
      warnings: [],
      error: {
        code: "HUMAN_REQUIRED",
        message: "Approval needed",
        retry: "never",
      },
    },
  );
  const result = await dispatch(
    catalog,
    "memory.forget",
    {},
    {
      caller: "human",
      confirmHuman: () => Promise.reject(new Error("terminal closed")),
    },
  );
  expect(result).toMatchObject({
    ok: false,
    error: { code: "HUMAN_REQUIRED" },
  });
  expect(catalog.calls).toHaveLength(1);
  expect(catalog.calls[0]?.input).toEqual({});
}, 30_000);

test("local owner confirmation requires a terminal, an exact answer and no agent harness", async () => {
  h = await openHarness(["memory"]);
  const stdin = Object.getOwnPropertyDescriptor(process, "stdin")!;
  const keys = [
    "FORGE_HARNESS",
    "FORGE_AGENT",
    "CODEX_SESSION_ID",
    "CODEX_THREAD_ID",
    "CLAUDE_CODE_SESSION_ID",
  ] as const;
  const previous = keys.map((key) => [key, process.env[key]] as const);
  const output = spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    for (const key of keys) delete process.env[key];
    const input = new PassThrough();
    Object.defineProperty(process, "stdin", {
      configurable: true,
      value: input,
    });
    const confirm = localCall(h.assembly).confirmHuman!;
    input.write("confirm memory.forget\n");
    expect(await confirm("memory.forget", {})).toBe(false);
    input.read();
    Object.assign(input, { isTTY: true });
    const yes = confirm("memory.forget", {});
    input.write("confirm memory.forget\n");
    expect(await yes).toBe(true);
    const no = confirm("memory.forget", {});
    input.write("yes\n");
    expect(await no).toBe(false);
    const closed = confirm("memory.forget", {});
    input.emit("end");
    expect(await closed).toBe(false);
    process.env.FORGE_HARNESS = "codex";
    expect(await confirm("memory.forget", {})).toBe(false);
    expect(input.listenerCount("data")).toBe(0);
    input.destroy();
  } finally {
    output.mockRestore();
    Object.defineProperty(process, "stdin", stdin);
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}, 30_000);

test("an agent cannot use the terminal callback, including through catalog.call", async () => {
  h = await openHarness(["memory"]);
  done(
    await h.call("memory.add", {
      level: "device",
      text: "owner rule",
      tags: ["rule"],
    }),
  );
  for (const [op, input] of [
    ["memory.forget", { id: "device/note-1" }],
    ["catalog.call", { op: "memory.forget", input: { id: "device/note-1" } }],
  ] as const) {
    const result = await dispatch(h.assembly.catalog, op, input, {
      ...localCall(h.assembly),
      caller: "agent",
      confirmHuman: () => Promise.resolve(true),
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "HUMAN_REQUIRED" },
    });
  }
}, 30_000);

test("human approval is required on each call and is carried to the catalog target", async () => {
  h = await openHarness(["memory"]);
  done(await h.call("memory.add", { level: "device", text: "owner rule" }));
  const options = localCall(h.assembly);
  expect(
    await dispatch(
      h.assembly.catalog,
      "memory.forget",
      { id: "device/note-1" },
      {
        ...options,
        confirmHuman: () => Promise.resolve(false),
      },
    ),
  ).toMatchObject({ ok: false, error: { code: "HUMAN_REQUIRED" } });
  expect(
    await dispatch(
      h.assembly.catalog,
      "catalog.call",
      {
        op: "memory.forget",
        input: { id: "device/note-1" },
      },
      { ...options, confirmHuman: () => Promise.resolve(true) },
    ),
  ).toMatchObject({ ok: true, result: { status: "forgotten" } });
  expect(
    done(await h.call("memory.show", { id: "device/note-1" })),
  ).toMatchObject({
    status: "forgotten",
    approval: {
      by: "owner",
      quote: { text: "confirmed in terminal" },
      at: expect.any(String) as unknown,
    },
  });
}, 30_000);

test("the memory confirmation guard leaves core admission, grants and recovery unchanged", async () => {
  for (const op of ["block.admit", "config.grant", "store.reinit"]) {
    const catalog = fakeCatalog([candidate(op, { callers: ["human"] })]);
    expect(await dispatch(catalog, op, {}, { caller: "human" })).toMatchObject({
      ok: true,
    });
    expect(catalog.calls).toHaveLength(1);
  }
}, 30_000);
