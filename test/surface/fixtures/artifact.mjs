// Run against an installed tarball root; no source-tree imports or test framework.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const root = process.argv[2];
if (!root) throw new Error("Expected installed package root.");
const load = (path) =>
  import(pathToFileURL(resolve(root, `dist/src/${path}.js`)).href);
const { runCli } = await load("surface/cli");
const { runHook } = await load("surface/hook");
const { createMcpHandlers } = await load("surface/mcp");
const { createMcpTransport } = await load("adapters/mcp-transport/index");
const entry = {
  op: "fresh.inspect",
  admitted: true,
  declaration: {
    input: "input.json",
    output: "output.json",
    context: "stateless",
    effects: [],
    idempotent: true,
    callers: ["human", "agent"],
    stability: "stable",
    args: ["value"],
  },
  docs: { title: "Fresh inspect", summary: "Inspect the fixture." },
  inputSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
  },
};
const refusal = {
  ok: false,
  status: "FAIL",
  error: { code: "NOT_FOUND", message: "Missing fixture.", retry: "never" },
  warnings: [],
};
const catalog = {
  list: () => [entry],
  invoke: async (request) =>
    request.input.value === "missing"
      ? refusal
      : {
          ok: true,
          op: request.op,
          status: "OK",
          result: request.input,
          warnings: [],
        },
};
assert.match(
  (await runCli(catalog, ["fresh", "--help"])).stdout,
  /fresh inspect/,
);
for (const argv of [
  ["catalog", "--help"],
  ["catalog", "list", "--help"],
]) {
  const help = JSON.parse((await runCli(catalog, [...argv, "--json"])).stdout);
  assert.ok(
    help.result.operations.some((operation) => operation.op === "catalog.list"),
  );
}
assert.equal(
  (await runCli(catalog, ["catalog", "describe", "fresh.inspect"])).envelope
    .result.op,
  "fresh.inspect",
);
const cli = await runCli(catalog, ["fresh", "inspect", "missing"]);
assert.equal(cli.exitCode, 3);
assert.deepEqual(JSON.parse(cli.stdout), refusal);
const hook = await runHook(
  catalog,
  "fresh.inspect",
  (async function* () {
    yield new TextEncoder().encode('{"value":"missing"}');
  })(),
);
assert.deepEqual(hook.envelope, refusal);
assert.equal(hook.exitCode, 3);

for (const [era, budget] of [
  ["2025-11-25", 40],
  ["2025-11-25", 0],
  ["2026-07-28", 40],
  ["2026-07-28", 0],
]) {
  const input = new TransformStream();
  const output = new TransformStream();
  const writer = input.writable.getWriter();
  const reader = output.readable.getReader();
  const opened = await createMcpTransport().open({
    handlers: createMcpHandlers(catalog, { budget }),
    serverName: "fixture",
    serverVersion: "1.0.0",
    input: input.readable,
    output: output.writable,
  });
  assert.equal(opened.ok, true);
  let buffer = "";
  let id = 0;
  const decoder = new TextDecoder();
  const rpc = async (method, params = {}) => {
    const requestId = ++id;
    if (era === "2026-07-28")
      params._meta = {
        "io.modelcontextprotocol/protocolVersion": era,
        "io.modelcontextprotocol/clientInfo": {
          name: "fixture",
          version: "1.0.0",
        },
        "io.modelcontextprotocol/clientCapabilities": {},
      };
    await writer.write(
      new TextEncoder().encode(
        `${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`,
      ),
    );
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        const reply = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (reply.id === requestId) return reply;
      } else {
        const next = await reader.read();
        assert.equal(next.done, false);
        buffer += decoder.decode(next.value, { stream: true });
      }
    }
  };
  try {
    if (era === "2025-11-25") {
      assert.equal(
        (
          await rpc("initialize", {
            protocolVersion: era,
            capabilities: {},
            clientInfo: { name: "fixture", version: "1.0.0" },
          })
        ).result.protocolVersion,
        era,
      );
      await writer.write(
        new TextEncoder().encode(
          '{"jsonrpc":"2.0","method":"notifications/initialized"}\n',
        ),
      );
    } else
      assert.deepEqual(
        (await rpc("server/discover")).result.supportedVersions,
        [era],
      );
    const list = await rpc("tools/list");
    assert.equal(
      list.result.tools.some((tool) => tool.name === "fresh_inspect"),
      budget > 0,
    );
    const discovered = (await rpc("tools/call", { name: "catalog_list" }))
      .result.structuredContent;
    assert.ok(discovered.result.some((operation) => operation.op === entry.op));
    const described = (
      await rpc("tools/call", {
        name: "catalog_describe",
        arguments: { op: entry.op },
      })
    ).result.structuredContent;
    assert.equal(described.result.op, entry.op);
    const callName = budget === 0 ? "catalog_call" : "fresh_inspect";
    const callArgs = (value) =>
      budget === 0 ? { op: entry.op, input: { value } } : { value };
    assert.deepEqual(
      (
        await rpc("tools/call", {
          name: callName,
          arguments: callArgs("hello"),
        })
      ).result.structuredContent.result,
      { value: "hello" },
    );
    const failed = (
      await rpc("tools/call", {
        name: callName,
        arguments: callArgs("missing"),
      })
    ).result;
    assert.equal(failed.isError, true);
    assert.deepEqual(failed.structuredContent, refusal);
    assert.deepEqual(JSON.parse(failed.content[0].text), refusal);
    assert.equal(
      (await rpc("tools/call", { name: "missing" })).error.code,
      -32602,
    );
    console.log(
      `${process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.version}`} installed artifact: ${era}, budget ${budget} PASS`,
    );
  } finally {
    await reader.cancel();
    await opened.handle.close();
    await opened.handle.close();
  }
}
