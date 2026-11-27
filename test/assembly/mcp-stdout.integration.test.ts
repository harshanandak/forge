import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough, Readable, Writable } from "node:stream";
import { createMcpTransport } from "../../src/adapters/mcp-transport/index.ts";

function run(config: string, args: string[], input?: string, preload?: string) {
  const node = Bun.which("node");
  if (!node) throw new Error("Node runtime required");
  const root = mkdtempSync(join(tmpdir(), "forge-mcp-stdout-"));
  try {
    mkdirSync(join(root, ".forge"));
    writeFileSync(join(root, ".forge/config.yaml"), config);
    const nodeArgs = preload
      ? ["--import", `data:text/javascript,${encodeURIComponent(preload)}`]
      : [];
    const result = spawnSync(
      node,
      [...nodeArgs, resolve("dist/bin/forge.js"), ...args],
      {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
        timeout: 30_000,
        input,
        env: {
          ...process.env,
          FORGE_DEVICE_ROOT: join(root, "device"),
          FORGE_SESSION: "mcp-stdout",
        },
      },
    );
    expect(result.error).toBeUndefined();
    return result;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const mcp of [true, false])
  test(`bootstrap envelope in ${mcp ? "MCP stderr" : "CLI stdout"}`, () => {
    const result = run("{unclosed", mcp ? ["--mcp"] : ["issue", "list"]);
    expect(result.status).toBeGreaterThan(0);
    if (mcp) expect(result.stdout).toBe("");
    const output = mcp ? result.stderr : result.stdout;
    const envelope = JSON.parse(output) as { error?: { code?: unknown } };
    expect(envelope).toMatchObject({ ok: false });
    expect(typeof envelope.error?.code).toBe("string");
  }, 60_000);

const clientInfo = { name: "stdout", version: "1.0.0" };
const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo },
};

for (const era of ["2025-11-25", "2026-07-28"]) {
  test(`MCP ${era} rejects non-string list cursors as invalid params`, async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const opened = await createMcpTransport().open({
      handlers: {
        listTools: () => [],
        callTool: () => Promise.resolve(undefined),
      },
      serverName: "fixture",
      serverVersion: "1.0.0",
      input: Readable.toWeb(input),
      output: Writable.toWeb(output),
    });
    if (!opened.ok) throw new Error(opened.unavailable.reason);
    const lines = createInterface({ input: output });
    const replies = lines[Symbol.asyncIterator]();
    const routingParams =
      era === "2026-07-28"
        ? {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": era,
              "io.modelcontextprotocol/clientInfo": clientInfo,
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          }
        : {};
    const rpc = async (id: number, cursor: unknown) => {
      input.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/list",
          params: { ...routingParams, cursor },
        }) + "\n",
      );
      const next = await replies.next();
      if (next.done) throw new Error("MCP closed before answering tools/list");
      return JSON.parse(next.value) as unknown;
    };
    try {
      if (era === "2025-11-25") {
        input.write(JSON.stringify(initialize) + "\n");
        const next = await replies.next();
        if (next.done)
          throw new Error("MCP closed before answering initialize");
        expect(JSON.parse(next.value)).toMatchObject({ id: initialize.id });
        input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      }
      expect(await rpc(2, "")).toMatchObject({ id: 2, result: { tools: [] } });
      const failures = [await rpc(3, 7), await rpc(4, null), await rpc(5, {})];
      expect(failures).toMatchObject(
        [3, 4, 5].map((id) => ({
          jsonrpc: "2.0",
          id,
          error: { code: -32602 },
        })),
      );
    } finally {
      lines.close();
      await opened.handle.close();
    }
  }, 30_000);
}

test("valid MCP session answers initialize and exits cleanly", () => {
  const result = run(
    "blocks: {}\n",
    ["--mcp"],
    JSON.stringify(initialize) + "\n",
  );
  expect(result.status).toBe(0);
  for (const line of result.stdout.replace(/\r?\n$/, "").split("\n"))
    expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
}, 60_000);

test("MCP exits nonzero after an asynchronous stdout write failure", () => {
  const preload = `
    import { PassThrough, Writable } from "node:stream";
    const input = new PassThrough();
    const stdout = process.stdout;
    let writes = 0;
    let failed = false;
    const output = new Writable({
      write(chunk, encoding, callback) {
        writes++;
        if (writes === 1) {
          stdout.write(chunk, encoding, callback);
          input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\\n');
          input.write('{"jsonrpc":"2.0","id":2,"method":"ping"}\\n');
          input.write('{"jsonrpc":"2.0","id":3,"method":"ping"}\\n');
        } else {
          setImmediate(() => {
            failed = true;
            callback(new Error("private stdout fixture payload"));
            setImmediate(() => {
              if (!input.destroyed) input.end('{"jsonrpc":"2.0","id":4,"method":"ping"}\\n');
            });
          });
        }
      },
    });
    const write = output.write.bind(output);
    output.write = (...args) => {
      if (failed) process.stderr.write("extra stdout write\\n");
      return write(...args);
    };
    Object.defineProperty(process, "stdin", { value: input });
    Object.defineProperty(process, "stdout", { value: output });
    input.write(${JSON.stringify(JSON.stringify(initialize) + "\n")});
  `;
  const result = run("blocks: {}\n", ["--mcp"], undefined, preload);
  expect(JSON.parse(result.stdout)).toMatchObject({
    jsonrpc: "2.0",
    id: initialize.id,
    result: { protocolVersion: initialize.params.protocolVersion },
  });
  expect(result.status).toBeGreaterThan(0);
  const lines = result.stderr.trimEnd().split(/\r?\n/);
  expect(lines).toHaveLength(1);
  expect(result.stderr).toContain("MCP stdout write failed.");
  expect(result.stderr).not.toContain("private stdout fixture payload");
  expect(result.stderr.length).toBeLessThan(256);
}, 60_000);
