import { expect, spyOn, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough, Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import * as fsAdapter from "../../../src/adapters/fs/index.ts";
import { blockCapture } from "../../../src/assembly/capture.ts";
import { firstPartyBlocks } from "../../../src/assembly/first-party.ts";
import { createAssembly, type Assembly } from "../../../src/assembly/index.ts";
import { assemblyMcp } from "../../../src/assembly/mcp.ts";
import { LOCK_FILE } from "../../../src/core/config/index.ts";
import { stageBlock } from "../../blocks/memory/lib.ts";

test("MCP open returns unavailable with the trust store path and remedy", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-mcp-trust-"));
  const deviceRoot = join(root, "device");
  const storePath = join(deviceRoot, "trust.sqlite");
  mkdirSync(storePath, { recursive: true });
  const assembly = await createAssembly({ root, deviceRoot });
  try {
    const result = await assemblyMcp(assembly).open({
      serverName: "test",
      serverVersion: "1.0.0",
      handlers: {
        listTools: () => [],
        callTool: () => Promise.resolve(undefined),
      },
      input: new ReadableStream<Uint8Array>(),
      output: new WritableStream<Uint8Array>(),
    });
    if (result.ok) await result.handle.close();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.unavailable.kind).toBe("unavailable");
      expect(result.unavailable.reason).toContain(storePath);
      expect(result.unavailable.reason).toContain("move or delete it");
      expect(result.unavailable.remedy).toBe(
        "Use a supported runtime and a readable local store path",
      );
    }
  } finally {
    await assembly.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

const invalidExposure = {
  blocks: { memory: { source: { builtin: "forge/memory" } } },
  mcp: { readOnly: true, toolPrefix: "a".repeat(65) },
};
const configRefusal = /INPUT_INVALID.*mcp\.toolPrefix/;
const testServer = {
  serverName: "test",
  serverVersion: "1.0.0",
  handlers: { listTools: () => [], callTool: () => Promise.resolve(undefined) },
};

async function withProject(
  config: object,
  run: (assembly: Assembly, file: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "forge-mcp-config-"));
  const file = join(root, ".forge/config.yaml");
  mkdirSync(join(root, ".forge"));
  writeFileSync(file, JSON.stringify(config));
  const assembly = await createAssembly({
    root,
    deviceRoot: join(root, "device"),
    providers: { env: {} },
  });
  try {
    await run(assembly, file);
  } finally {
    await assembly.close();
    rmSync(root, { recursive: true, force: true });
  }
}

interface Reply {
  id: number;
  result?: { tools?: { name: string }[]; structuredContent?: unknown };
  error?: { message: string };
}

async function withConnection(
  assembly: Assembly,
  run: (
    rpc: (method: string, params?: object) => Promise<Reply>,
  ) => Promise<void>,
): Promise<void> {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = createInterface({ input: output });
  const replies = lines[Symbol.asyncIterator]();
  let id = 0;
  const rpc = async (method: string, params: object = {}) => {
    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params })}\n`,
    );
    const reply = await replies.next();
    if (reply.done) throw new Error(`MCP closed before answering ${method}`);
    const message = JSON.parse(reply.value) as Reply;
    expect(message.id).toBe(id);
    return message;
  };
  try {
    const opened = await assemblyMcp(assembly).open({
      ...testServer,
      input: Readable.toWeb(input),
      output: Writable.toWeb(output),
    });
    if (!opened.ok) throw new Error(opened.unavailable.reason);
    try {
      const initialized = await rpc("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      });
      expect(initialized).toHaveProperty(
        "result.protocolVersion",
        "2025-11-25",
      );
      input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      await run(rpc);
    } finally {
      await opened.handle.close();
    }
  } finally {
    lines.close();
    input.end();
    output.end();
  }
}

test("MCP refuses a read-only project with an invalid tool prefix", async () => {
  await withProject(invalidExposure, async (assembly) => {
    const result = await assemblyMcp(assembly).open({
      ...testServer,
      input: new ReadableStream<Uint8Array>(),
      output: new WritableStream<Uint8Array>(),
    });
    if (result.ok) {
      await result.handle.close();
      throw new Error("MCP started with invalid read-only configuration");
    }
    expect(result.unavailable.reason).toMatch(configRefusal);
  });
}, 30_000);

test("MCP refuses tool requests after the config becomes invalid on an open connection", async () => {
  await withProject({ blocks: {}, mcp: {} }, async (assembly, file) => {
    await withConnection(assembly, async (rpc) => {
      expect(await rpc("tools/list")).toHaveProperty("result.tools");
      writeFileSync(file, JSON.stringify(invalidExposure));
      const input = { text: "MCP policy check", level: "device" };
      const replies = [await rpc("tools/list")];
      for (const [name, args] of [
        ["memory_add", input],
        ["catalog_list", {}],
        ["catalog_describe", { op: "memory.add" }],
        ["catalog_call", { op: "memory.add", input }],
      ] as const)
        replies.push(await rpc("tools/call", { name, arguments: args }));
      for (const reply of replies) {
        expect(reply.result).toBeUndefined();
        expect(reply.error?.message).toMatch(configRefusal);
      }
    });
  });
}, 30_000);

test("MCP excludes device-memory fallback tools when a project config section is excluded", async () => {
  await withProject(
    { blocks: {}, runtime: { timeoutMs: "invalid" } },
    async (assembly) => {
      const staged = stageBlock("memory", join(assembly.root, "builtins"));
      const source = fileURLToPath(firstPartyBlocks["forge/memory"]!);
      const open = blockCapture.open.bind(blockCapture);
      const capture = spyOn(blockCapture, "open").mockImplementation((path) =>
        open(path === source ? staged : path),
      );
      try {
        expect(assembly.catalog.list().map(({ op }) => op)).toContain(
          "memory.add",
        );
        await withConnection(assembly, async (rpc) => {
          const tools = (await rpc("tools/list")).result?.tools?.map(
            ({ name }) => name,
          );
          expect(tools).toContain("catalog_list");
          expect(tools?.filter((name) => name.startsWith("memory_"))).toEqual(
            [],
          );
        });
      } finally {
        capture.mockRestore();
      }
    },
  );
}, 30_000);

test("MCP block_add verifies its write and refuses a concurrent read-only config edit", async () => {
  await withProject({ blocks: {}, mcp: {} }, async (assembly, file) => {
    const example = new URL("../../../examples/hello-block", import.meta.url);
    for (const dir of ["hello", "replacement"])
      cpSync(example, join(assembly.root, dir), { recursive: true });
    await withConnection(assembly, async (rpc) => {
      const add = (path: string) =>
        rpc("tools/call", { name: "block_add", arguments: { path } });
      expect((await add("./hello")).result?.structuredContent).toMatchObject({
        ok: true,
        result: { blockId: "example.org/hello" },
      });
      expect(readFileSync(file, "utf8")).toContain("./hello");

      const restricted = JSON.stringify({
        schemaVersion: "forge.config/1",
        blocks: { hello: { source: { path: "./hello" } } },
        mcp: { readOnly: true },
      });
      let edited = false;
      const nodeConfigFiles = fsAdapter.nodeConfigFiles;
      const concurrentEdit = spyOn(
        fsAdapter,
        "nodeConfigFiles",
      ).mockImplementation((root, options) => {
        const files = nodeConfigFiles(root, options);
        return {
          ...files,
          createExclusive(path, bytes) {
            if (!edited && root === assembly.root && path === LOCK_FILE) {
              writeFileSync(file, restricted);
              edited = true;
            }
            return files.createExclusive(path, bytes);
          },
        };
      });
      try {
        expect(
          (await add("./replacement")).result?.structuredContent,
        ).toMatchObject({
          ok: false,
          error: { code: "REVISION_CONFLICT" },
        });
        expect(edited).toBe(true);
        expect(readFileSync(file, "utf8")).toBe(restricted);
      } finally {
        concurrentEdit.mockRestore();
      }
    });
  });
}, 30_000);
