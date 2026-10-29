import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { done } from "../blocks/memory/lib.ts";

const { createAssembly, localCall } = (await import(
  pathToFileURL(resolve("dist/src/assembly/index.js")).href
)) as typeof import("../../src/assembly/index.ts");
const { createMcpHandlers } = (await import(
  pathToFileURL(resolve("dist/src/surface/mcp.js")).href
)) as typeof import("../../src/surface/mcp.ts");
const bin = resolve(import.meta.dirname, "../../dist/bin/forge.js");
const operations = [
  {
    op: "notes.forget",
    input: { id: "device/note-1" },
    expected: { status: "forgotten" },
  },
  {
    op: "notes.restore",
    input: {
      format: "forge.memory.export/2",
      level: "device",
      notes: [
        {
          id: "device/note-2",
          tags: [],
          links: [],
          text: {
            kind: "untrusted",
            source: "test",
            text: "must not be restored by an agent",
          },
        },
      ],
    },
    expected: { added: 1 },
  },
  {
    op: "choices.adopt",
    input: { id: "ADR-001" },
    expected: { status: "adopted" },
  },
] as const;

function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const scan = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) scan(path);
      else
        files[path] = createHash("sha256")
          .update(readFileSync(path))
          .digest("hex");
    }
  };
  scan(join(root, ".forge"));
  scan(join(root, "device"));
  return files;
}

for (const route of ["cli", "cli-catalog", "mcp", "mcp-catalog"] as const)
  for (const { op, input, expected } of operations)
    test(`integration: ${route} refuses renamed ${op} without changing any files`, async () => {
      const root = mkdtempSync(join(tmpdir(), "forge-human-renames-"));
      const deviceRoot = join(root, "device");
      mkdirSync(join(root, ".forge"));
      writeFileSync(
        join(root, ".forge/config.yaml"),
        JSON.stringify({
          schemaVersion: "forge.config/1",
          blocks: {
            memory: {
              source: { builtin: "forge/memory" },
              rename: { memory: "notes", decision: "choices" },
              config: { decisions: { idPattern: "ADR-NNN" } },
            },
          },
        }),
      );
      const assembly = await createAssembly({ root, deviceRoot });
      const options = localCall(assembly);
      let request = 0;
      const prepare = async (name: string, value: unknown) =>
        done(
          await assembly.catalog.invoke({
            schemaVersion: "forge.invocation/1",
            requestId: `fixture-${++request}`,
            op: name,
            input: value,
            caller: "human",
            context: options.context ?? {},
          }),
        );
      try {
        await prepare("notes.add", { level: "device", text: "must survive" });
        await prepare("choices.propose", {
          title: "Keep proposed",
          text: "owner decides",
        });
        const before = snapshot(root);
        let refused: unknown;
        if (route.startsWith("cli")) {
          const args =
            route === "cli"
              ? [...op.split("."), "--input", JSON.stringify(input)]
              : ["catalog", "call", "--input", JSON.stringify({ op, input })];
          const result = spawnSync("node", [bin, ...args], {
            cwd: root,
            env: {
              ...process.env,
              FORGE_DEVICE_ROOT: deviceRoot,
              FORGE_AGENT: "test-agent",
            },
            encoding: "utf8",
            timeout: 20_000,
            windowsHide: true,
          });
          if (result.error) throw result.error;
          refused = JSON.parse(result.stdout);
          expect(refused).toMatchObject({
            ok: false,
            error: { code: "HUMAN_REQUIRED" },
          });
          expect(result.status).toBe(1);
        } else {
          const handlers = createMcpHandlers(assembly.catalog, {}, options);
          refused = await handlers.callTool(
            route === "mcp" ? op.replace(".", "_") : "catalog_call",
            route === "mcp" ? input : { op, input },
          );
          expect(refused).toMatchObject({
            ok: false,
            error: { code: "HUMAN_REQUIRED" },
          });
        }
        const repair = (refused as { error: { repair: string } }).error.repair;
        expect(repair).toContain("Ask the owner in the conversation");
        expect(
          (refused as { error: { message: string } }).error.message,
        ).toContain(op);
        expect(snapshot(root)).toEqual(before);
        expect(
          await prepare("notes.show", { id: "device/note-1" }),
        ).toMatchObject({ status: "found" });
        expect(
          await prepare("notes.show", { id: "device/note-2" }),
        ).toMatchObject({ status: "not_found" });
        expect(await prepare("choices.list", {})).toMatchObject({
          decisions: [{ status: "proposed" }],
        });
        const approvedInput = {
          ...input,
          approval: { by: "owner", quote: "Please make this change." },
        };
        if (route.startsWith("cli")) {
          const args =
            route === "cli"
              ? [...op.split("."), "--input", JSON.stringify(approvedInput)]
              : [
                  "catalog",
                  "call",
                  "--input",
                  JSON.stringify({ op, input: approvedInput }),
                ];
          const approved = spawnSync("node", [bin, ...args], {
            cwd: root,
            env: {
              ...process.env,
              FORGE_DEVICE_ROOT: deviceRoot,
              FORGE_AGENT: "test-agent",
            },
            encoding: "utf8",
            timeout: 20_000,
            windowsHide: true,
          });
          if (approved.error) throw approved.error;
          expect(JSON.parse(approved.stdout)).toMatchObject({
            ok: true,
            result: expected,
          });
          expect(approved.status).toBe(0);
        } else {
          const handlers = createMcpHandlers(assembly.catalog, {}, options);
          expect(
            await handlers.callTool(
              route === "mcp" ? op.replace(".", "_") : "catalog_call",
              route === "mcp" ? approvedInput : { op, input: approvedInput },
            ),
          ).toMatchObject({ ok: true, result: expected });
        }
      } finally {
        await assembly.close();
        rmSync(root, { recursive: true, force: true });
      }
    }, 60_000);
