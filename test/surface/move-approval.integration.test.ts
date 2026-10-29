import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const bin = resolve("dist/bin/forge.js");
interface Audit {
  by: string;
  at: string;
  quote?: { text: string };
  reason?: { text: string };
}
interface Note {
  id: string;
  revision: number;
  createdAt: string;
  text: { text: string };
  approval?: Audit;
  versions: { revision: number; at: string; approval?: Audit }[];
}
function approval(value?: Audit) {
  return value === undefined
    ? undefined
    : {
        by: value.by,
        at: value.at,
        ...(value.quote ? { quote: value.quote.text } : {}),
        ...(value.reason ? { reason: value.reason.text } : {}),
      };
}

for (const route of ["cli", "mcp"] as const)
  test(`integration: ${route} preserves the last approval and retained version trail through both move directions`, async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-move-approval-"));
    const deviceRoot = join(root, "device");
    mkdirSync(join(root, ".forge"));
    writeFileSync(
      join(root, ".forge/config.yaml"),
      JSON.stringify({
        schemaVersion: "forge.config/1",
        blocks: {
          memory: {
            source: { builtin: "forge/memory" },
            config: { scope: "general" },
          },
        },
      }),
    );
    const assembly = await createAssembly({ root, deviceRoot });
    const handlers = createMcpHandlers(
      assembly.catalog,
      { budget: 100 },
      localCall(assembly),
    );
    const call = async (op: string, input: Record<string, unknown> = {}) => {
      if (route === "mcp") {
        const result = await handlers.callTool(op.replace(".", "_"), input);
        if (!result) throw new Error(`Missing MCP operation ${op}`);
        return done(result);
      }
      const result = spawnSync(
        "node",
        [bin, ...op.split("."), "--input", JSON.stringify(input)],
        {
          cwd: root,
          env: {
            ...process.env,
            FORGE_DEVICE_ROOT: deviceRoot,
            FORGE_AGENT: "move-trail-test",
          },
          encoding: "utf8",
          timeout: 20_000,
          windowsHide: true,
        },
      );
      if (result.error) throw result.error;
      expect(result.status, result.stdout + result.stderr).toBe(0);
      return done(
        JSON.parse(
          result.stdout,
        ) as import("../../src/generated/types.ts").ResultEnvelope,
      );
    };
    const show = async (id: string, revision?: number) =>
      (
        (await call("memory.show", {
          id,
          ...(revision === undefined ? {} : { revision }),
        })) as { note: Note }
      ).note;
    const trail = async (note: Note) => ({
      createdAt: note.createdAt,
      text: note.text.text,
      approval: approval(note.approval),
      versions: await Promise.all(
        note.versions.map(async (version) => ({
          revision: version.revision,
          at: version.at,
          approval: approval(version.approval),
          text: (await show(note.id, version.revision)).text.text,
        })),
      ),
    });
    try {
      let note = (
        (await call("memory.add", {
          level: "device",
          text: "original protected text",
          tags: ["rule"],
        })) as { note: Note }
      ).note;
      const id = note.id;
      note = (
        (await call("memory.add", {
          id,
          expectRevision: note.revision,
          text: "owner approved revision",
          tags: [],
          approval: { by: "owner", quote: "Remove this rule tag." },
        })) as { note: Note }
      ).note;
      note = (
        (await call("memory.add", {
          id,
          expectRevision: note.revision,
          text: "ordinary subsequent revision",
        })) as { note: Note }
      ).note;
      await call("memory.forget", {
        id,
        approval: { by: "owner", quote: "Forget this note temporarily." },
      });
      await call("memory.forget", {
        id,
        undo: true,
        approval: {
          by: "owner",
          quote: "Restore this note and keep its trail.",
        },
      });
      let expected = await trail(await show(id));
      expect(expected.approval).toMatchObject({
        by: "owner",
        quote: "Restore this note and keep its trail.",
      });
      expect(expected.versions.map((version) => version.text)).toEqual([
        "original protected text",
        "owner approved revision",
        "ordinary subsequent revision",
      ]);
      expect(expected.versions[1]!.approval).toMatchObject({
        by: "owner",
        quote: "Remove this rule tag.",
      });
      expect(expected.versions[2]!.approval).toBeUndefined();
      for (const to of ["project", "device"] as const) {
        const current = await show(note.id);
        const moved = (await call("memory.move", {
          id: current.id,
          expectRevision: current.revision,
          to,
        })) as { to: string };
        note = await show(moved.to);
        expect(await trail(note)).toEqual(expected);
        if (to === "project") {
          note = (
            (await call("memory.add", {
              id: note.id,
              expectRevision: note.revision,
              text: "ordinary edit after move",
            })) as { note: Note }
          ).note;
          const edited = await trail(note);
          expect(edited.text).toBe("ordinary edit after move");
          expect(edited.approval).toEqual(expected.approval);
          expect(edited.versions.slice(0, -1)).toEqual(expected.versions);
          expect(
            new Set(edited.versions.map((version) => version.revision)).size,
          ).toBe(edited.versions.length);
          expect(edited.versions.at(-1)!.revision).toBeGreaterThan(
            Math.max(...expected.versions.map((version) => version.revision)),
          );
          expect(edited.versions.at(-1)!.text).toBe("ordinary edit after move");
          expect(edited.versions.at(-1)!.approval).toBeUndefined();
          expected = edited;
        }
      }
    } finally {
      await assembly.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 240_000);
