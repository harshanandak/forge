"use strict";

const { describe, expect, test } = require("bun:test");
const { SkillRuntime } = require("../src/skill-runtime.js");

function metadata(nodes) {
  return { id: "plan", nodes };
}

function passingHandler(id, calls) {
  return async (request) => {
    calls.push({ id, request });
    return { status: "PASS", evidence: [{ kind: "node", nodeId: id }] };
  };
}

describe("SkillRuntime", () => {
  test("fails closed when constructed with null options", async () => {
    const runtime = new SkillRuntime(null);

    expect(await runtime.invoke({ nodes: ["intent"] })).toMatchObject({
      status: "INCOMPLETE",
      invoked: [],
      error: { code: "INVALID_OPTIONS" },
    });
  });

  test.each([null, "not-a-request", 42, []])(
    "fails safely for a non-object invocation request (%j)",
    async (request) => {
      const runtime = new SkillRuntime({
        metadata: metadata([{ id: "intent" }]),
        handlers: {},
      });

      expect(await runtime.invoke(request)).toMatchObject({
        status: "INCOMPLETE",
        invoked: [],
        error: { code: "INVALID_REQUEST" },
      });
    },
  );

  test.each([
    ["infinite", Infinity],
    ["NaN", Number.NaN],
    ["zero", 0],
    ["negative", -1],
    ["oversized", Number.MAX_SAFE_INTEGER],
  ])("fails safely for an %s limit override", async (_label, maxBytes) => {
    const runtime = new SkillRuntime({
      metadata: metadata([{ id: "intent" }]),
      handlers: {},
      limits: { maxBytes },
    });

    expect(await runtime.invoke({ nodes: ["intent"] })).toMatchObject({
      status: "INCOMPLETE",
      invoked: [],
      error: { code: "INVALID_LIMITS", limit: "maxBytes" },
    });
  });

  test("invokes only required nodes in dependency order and records skipped nodes", async () => {
    const calls = [];
    const runtime = new SkillRuntime({
      metadata: metadata([
        { id: "intent", inputKeys: ["objective"], contextKeys: ["issueId"] },
        { id: "research", dependsOn: ["intent"], capabilities: ["web"] },
        { id: "critics", dependsOn: ["research"] },
        { id: "lock", dependsOn: ["critics"] },
      ]),
      capabilities: ["web"],
      handlers: {
        intent: passingHandler("intent", calls),
        research: passingHandler("research", calls),
        critics: passingHandler("critics", calls),
        lock: passingHandler("lock", calls),
      },
    });

    const result = await runtime.invoke({
      nodes: ["research"],
      inputs: { objective: "bounded plan", secret: "do not forward" },
      context: { issueId: "issue-1", transcript: "do not forward" },
    });

    expect(result.status).toBe("PASS");
    expect(result.invoked.map((entry) => entry.nodeId)).toEqual(["intent", "research"]);
    expect(result.skipped).toEqual([
      { nodeId: "critics", reason: "NOT_REQUIRED" },
      { nodeId: "lock", reason: "NOT_REQUIRED" },
    ]);
    expect(calls[0].request).toEqual({
      nodeId: "intent",
      inputs: { objective: "bounded plan" },
      context: { issueId: "issue-1" },
      dependencyEvidence: [],
    });
    expect(calls[1].request.inputs).toEqual({});
    expect(calls[1].request.context).toEqual({});
    expect(calls[1].request.dependencyEvidence).toEqual([
      { nodeId: "intent", status: "PASS", evidence: [{ kind: "node", nodeId: "intent" }] },
    ]);
  });

  test("preserves declared dependency order when multiple nodes are required", async () => {
    const calls = [];
    const runtime = new SkillRuntime({
      metadata: metadata([
        { id: "intent" },
        { id: "research" },
        { id: "synthesis", dependsOn: ["research", "intent"] },
      ]),
      handlers: Object.fromEntries(
        ["intent", "research", "synthesis"].map((id) => [id, passingHandler(id, calls)]),
      ),
    });

    const result = await runtime.invoke({ nodes: ["synthesis"] });

    expect(result.invoked.map((entry) => entry.nodeId)).toEqual([
      "research",
      "intent",
      "synthesis",
    ]);
  });

  test("fails safely before invocation when a required capability is unavailable", async () => {
    const calls = [];
    const runtime = new SkillRuntime({
      metadata: metadata([{ id: "research", capabilities: ["web"] }]),
      capabilities: [],
      handlers: { research: passingHandler("research", calls) },
    });

    expect(await runtime.invoke({ nodes: ["research"] })).toMatchObject({
      status: "INCOMPLETE",
      invoked: [],
      error: { code: "MISSING_CAPABILITY", nodeId: "research", capability: "web" },
    });
    expect(calls).toEqual([]);
  });

  test("fails safely for an unknown requested node", async () => {
    const runtime = new SkillRuntime({ metadata: metadata([{ id: "intent" }]), handlers: {} });

    expect(await runtime.invoke({ nodes: ["unknown"] })).toMatchObject({
      status: "INCOMPLETE",
      invoked: [],
      error: { code: "UNKNOWN_NODE", nodeId: "unknown" },
    });
  });

  test("bounds and sanitizes attacker-controlled early failure output", async () => {
    const runtime = new SkillRuntime({ metadata: metadata([{ id: "intent" }]), handlers: {} });
    const hostileNodeId = "x".repeat(10_000);

    const result = await runtime.invoke({ nodes: [hostileNodeId] });

    expect(result).toMatchObject({
      status: "INCOMPLETE",
      invoked: [],
      error: { code: "UNKNOWN_NODE" },
    });
    expect(result.error).not.toHaveProperty("nodeId");
    expect(JSON.stringify(result)).not.toContain(hostileNodeId);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(8_192);
  });

  test("fails safely for a dependency cycle without invoking handlers", async () => {
    const calls = [];
    const runtime = new SkillRuntime({
      metadata: metadata([
        { id: "a", dependsOn: ["b"] },
        { id: "b", dependsOn: ["a"] },
      ]),
      handlers: { a: passingHandler("a", calls), b: passingHandler("b", calls) },
    });

    expect(await runtime.invoke({ nodes: ["a"] })).toMatchObject({
      status: "INCOMPLETE",
      invoked: [],
      error: { code: "CYCLE", nodeId: "a" },
    });
    expect(calls).toEqual([]);
  });

  test("fails safely for duplicate requested invocation", async () => {
    const calls = [];
    const runtime = new SkillRuntime({
      metadata: metadata([{ id: "intent" }]),
      handlers: { intent: passingHandler("intent", calls) },
    });

    expect(await runtime.invoke({ nodes: ["intent", "intent"] })).toMatchObject({
      status: "INCOMPLETE",
      invoked: [],
      error: { code: "DUPLICATE_INVOCATION", nodeId: "intent" },
    });
    expect(calls).toEqual([]);
  });

  test("fails safely on recursive runtime invocation", async () => {
    let runtime;
    runtime = new SkillRuntime({
      metadata: metadata([{ id: "intent" }]),
      handlers: {
        intent: async () => runtime.invoke({ nodes: ["intent"] }),
      },
    });

    expect(await runtime.invoke({ nodes: ["intent"] })).toMatchObject({
      status: "INCOMPLETE",
      error: { code: "RECURSIVE_INVOCATION", nodeId: "intent" },
    });
  });

  test("rejects oversized bounded input before invoking handlers", async () => {
    const calls = [];
    const runtime = new SkillRuntime({
      metadata: metadata([{ id: "intent", inputKeys: ["objective"] }]),
      handlers: { intent: passingHandler("intent", calls) },
      limits: { maxBytes: 32, maxDepth: 4, maxNodes: 16 },
    });

    expect(await runtime.invoke({
      nodes: ["intent"],
      inputs: { objective: "x".repeat(100) },
    })).toMatchObject({
      status: "INCOMPLETE",
      invoked: [],
      error: { code: "BOUNDED_INPUT_EXCEEDED" },
    });
    expect(calls).toEqual([]);
  });

  test("requires every handler result to contain structured evidence", async () => {
    const runtime = new SkillRuntime({
      metadata: metadata([{ id: "intent" }]),
      handlers: { intent: async () => "done" },
    });

    expect(await runtime.invoke({ nodes: ["intent"] })).toMatchObject({
      status: "INCOMPLETE",
      invoked: [],
      error: { code: "INVALID_EVIDENCE", nodeId: "intent" },
    });
  });

  test("fails closed when reading a hostile handler result", async () => {
    const runtime = new SkillRuntime({
      metadata: metadata([{ id: "intent" }]),
      handlers: {
        intent: async () => ({
          get status() { throw new Error("hostile getter"); },
          evidence: [],
        }),
      },
    });

    expect(await runtime.invoke({ nodes: ["intent"] })).toMatchObject({
      status: "INCOMPLETE",
      invoked: [],
      error: { code: "INVALID_EVIDENCE", nodeId: "intent" },
    });
  });

  test("fails closed when aggregate returned evidence exceeds maxNodes", async () => {
    const nodes = Array.from({ length: 129 }, (_value, index) => ({ id: `node-${index}` }));
    const runtime = new SkillRuntime({
      metadata: metadata(nodes),
      handlers: Object.fromEntries(nodes.map((node) => [
        node.id,
        async () => ({ status: "PASS", evidence: [] }),
      ])),
    });

    const result = await runtime.invoke({ nodes: nodes.map((node) => node.id) });

    expect(result).toMatchObject({
      status: "INCOMPLETE",
      error: { code: "BOUNDED_OUTPUT_EXCEEDED" },
    });
    expect(result.invoked).toEqual([]);
  });

  test("fails closed when aggregate returned evidence exceeds maxBytes", async () => {
    const nodes = [{ id: "one" }, { id: "two" }];
    const runtime = new SkillRuntime({
      metadata: metadata(nodes),
      limits: { maxBytes: 1_000 },
      handlers: Object.fromEntries(nodes.map((node) => [
        node.id,
        async () => ({ status: "PASS", evidence: [{ summary: "x".repeat(300) }] }),
      ])),
    });

    const result = await runtime.invoke({ nodes: ["one", "two"] });

    expect(result).toMatchObject({
      status: "INCOMPLETE",
      error: { code: "BOUNDED_OUTPUT_EXCEEDED" },
    });
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(1_000);
  });
});
