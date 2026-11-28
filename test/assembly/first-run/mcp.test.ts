import { expect, spyOn, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
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
import { renderSkillCatalog } from "../../../src/assembly/skills.ts";
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
  result?: {
    contents?: { text?: string }[];
    tools?: { name: string }[];
    structuredContent?: unknown;
  };
  error?: { message: string };
}

async function withConnection(
  assembly: Assembly,
  run: (
    rpc: (method: string, params?: object) => Promise<Reply>,
    discovery: Reply,
  ) => Promise<void>,
  era = "2025-11-25",
): Promise<void> {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = createInterface({ input: output });
  const replies = lines[Symbol.asyncIterator]();
  let id = 0;
  const metadata = {
    "io.modelcontextprotocol/protocolVersion": era,
    "io.modelcontextprotocol/clientInfo": { name: "test", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
  const rpc = async (method: string, inputParams: object = {}) => {
    const params =
      era === "2026-07-28" ? { ...inputParams, _meta: metadata } : inputParams;
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
      const discovery =
        era === "2026-07-28"
          ? await rpc("server/discover")
          : await rpc("initialize", {
              protocolVersion: era,
              capabilities: {},
              clientInfo: { name: "test", version: "1.0.0" },
            });
      if (era === "2025-11-25") {
        expect(discovery).toHaveProperty("result.protocolVersion", era);
        input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      }
      await run(rpc, discovery);
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

const resourceTemplate = "template/forge.template.json";
const resourceConfig = {
  schemaVersion: "forge.config/1",
  blocks: {},
  templates: [
    {
      template: "acme/review@1.0.0",
      digest: `sha256:${"0".repeat(64)}`,
      source: resourceTemplate,
    },
  ],
};
const skillUri = "skill://review/SKILL.md";
const notesUri = "skill://review/notes/check.bin";
const noCache = { resultType: "complete", ttlMs: 0, cacheScope: "private" };
const skillSource = '---\nname: review\ndescription: "Review changes."\n---\n';
const modern = "2026-07-28";

function resourceFixture(root: string): string {
  const folder = join(root, "template", "skills", "review");
  mkdirSync(join(folder, "notes"), { recursive: true });
  writeFileSync(join(folder, "SKILL.md"), skillSource);
  writeFileSync(join(folder, "notes", "check.bin"), Buffer.of(0, 13, 10, 255));
  writeFileSync(join(root, "private.md"), "outside the catalog");
  return folder;
}

for (const era of ["2025-11-25", "2026-07-28"]) {
  test(`MCP ${era} reads only canonical skill resources, with tools available`, async () => {
    await withProject(resourceConfig, async (assembly) => {
      const { root } = assembly;
      const folder = resourceFixture(root);
      await withConnection(
        assembly,
        async (rpc, discovery) => {
          expect(discovery).toMatchObject({
            result: { capabilities: { resources: {}, tools: {} } },
          });
          const catalog = renderSkillCatalog([], undefined, {
            sources: [{ root, file: resourceTemplate }],
            values: undefined,
          });
          const main = catalog[0]!;
          expect(main.path).toBe("review/SKILL.md");
          const cache = era === modern ? noCache : {};
          const read = (uri: string) => rpc("resources/read", { uri });
          expect(await read(skillUri)).toMatchObject({
            result: {
              ...cache,
              contents: [
                {
                  uri: skillUri,
                  mimeType: "text/markdown",
                  text: new TextDecoder().decode(main.bytes),
                },
              ],
            },
          });
          const contents = [{ uri: notesUri, blob: "AA0K/w==" }];
          expect(await read(notesUri)).toMatchObject({
            result: { ...cache, contents },
          });
          const resources = [{ uri: skillUri }, { uri: notesUri }];
          expect(await rpc("resources/list")).toMatchObject({
            result: { ...cache, resources },
          });
          for (const uri of [
            "file:///private.md",
            "skill://review/private.md",
            "skill://unknown/SKILL.md",
            "skill://review/../private.md",
            "skill://review/%2e%2e/private.md",
            "skill://review/notes%2f..%2fSKILL.md",
            "skill://review/%53KILL.md",
            "skill://review/SKILL.md?path=private.md",
          ])
            expect(await read(uri), uri).toMatchObject({
              error: { code: -32602 },
            });
          writeFileSync(join(folder, "SKILL.md"), `${skillSource}\nFresh.\n`);
          const changed = (await read(skillUri)).result?.contents?.[0];
          expect(changed?.text).toContain("Fresh.");
          const tools = (await rpc("tools/list")).result?.tools;
          expect(tools?.map(({ name }) => name)).toContain("catalog_list");
        },
        era,
      );
    });
  }, 30_000);
}

test("MCP lists resources even when the project has no skill catalog", async () => {
  await withProject({ blocks: {} }, async (assembly) => {
    await withConnection(
      assembly,
      async (rpc) => {
        expect(await rpc("resources/list")).toMatchObject({
          result: { ...noCache, resources: [] },
        });
      },
      modern,
    );
  });
}, 30_000);

for (const failure of [
  "symlinked companion directory",
  "over 1 MiB of companion bytes",
  "over 512 companion entries",
]) {
  test(`MCP refuses a skill catalog with ${failure}`, async () => {
    await withProject(resourceConfig, async (assembly) => {
      const folder = resourceFixture(assembly.root);
      if (failure === "symlinked companion directory") {
        const unrelated = join(assembly.root, "unrelated");
        mkdirSync(unrelated);
        writeFileSync(join(unrelated, "private.md"), "outside the catalog");
        const kind = process.platform === "win32" ? "junction" : "dir";
        symlinkSync(unrelated, join(folder, "escape"), kind);
      } else if (failure === "over 1 MiB of companion bytes") {
        const bytes = Buffer.alloc(600_000);
        for (const file of ["a.bin", "b.bin"])
          writeFileSync(join(folder, file), bytes);
      } else {
        for (let index = 0; index < 513; index++)
          writeFileSync(join(folder, `example-${index}.bin`), "");
      }
      await withConnection(
        assembly,
        async (rpc) => {
          const unavailable = { error: { code: -32603 } };
          expect(await rpc("resources/list")).toMatchObject(unavailable);
          const read = await rpc("resources/read", { uri: skillUri });
          expect(read).toMatchObject(unavailable);
          expect((await rpc("tools/list")).error).toBeUndefined();
        },
        modern,
      );
    });
  }, 30_000);
}

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
