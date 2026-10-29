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
interface Note {
  id: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  versions: {
    revision: number;
    at: string;
    approval?: {
      by: string;
      at: string;
      quote: { kind: string; text: string };
    };
  }[];
}

for (const route of ["cli", "mcp"] as const)
  test(`integration: ${route} exposes durable note dates, rule changes, approval history and decision dates`, async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-memory-times-"));
    const deviceRoot = join(root, "device");
    mkdirSync(join(root, ".forge"));
    writeFileSync(
      join(root, ".forge/config.yaml"),
      JSON.stringify({
        schemaVersion: "forge.config/1",
        blocks: {
          memory: {
            source: { builtin: "forge/memory" },
            config: { scope: "general", decisions: { idPattern: "ADR-NNN" } },
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
            FORGE_AGENT: "time-test",
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
    const add = async (input: Record<string, unknown>) =>
      (await call("memory.add", input)) as { id: string; note: Note };
    const show = async (id: string) =>
      ((await call("memory.show", { id })) as { note: Note }).note;
    const packet = async () =>
      (
        (await call("memory.rules", { notes: true })) as {
          text: { text: string };
        }
      ).text.text;
    try {
      const first = await add({
        level: "device",
        text: "dated first rule",
        tags: ["rule"],
      });
      expect(first.note.createdAt).toBeString();
      const created = first.note.createdAt;
      const date = created.slice(0, 10);
      expect(await packet()).toContain(
        `- [general] ${first.id} (created ${date}) dated first rule`,
      );
      let note = first.note;
      for (let n = 0; n < 8; n++)
        note = (
          await add({
            id: first.id,
            expectRevision: note.revision,
            text: `dated edit ${n}`,
          })
        ).note;
      expect((await show(first.id)).createdAt).toBe(created);
      expect(await call("memory.search", { query: "dated" })).toMatchObject({
        hits: [{ createdAt: created, updatedAt: note.updatedAt }],
      });
      expect(await packet()).toContain(
        `- [general] ${first.id} (created ${date}, updated ${note.updatedAt.slice(0, 10)}) dated edit 7`,
      );
      const second = await add({
        level: "device",
        text: "unchanged rule",
        tags: ["rule"],
      });
      const secondLine = (await packet())
        .split("\n")
        .find((line) => line.includes(second.id));
      expect(secondLine).toBe(
        `- [general] ${second.id} (created ${second.note.createdAt.slice(0, 10)}) unchanged rule`,
      );
      const approval = {
        by: "owner",
        quote: "Remove the rule tag from this note.",
      };
      const approved = (
        await add({
          id: first.id,
          expectRevision: note.revision,
          text: "approved version",
          tags: [],
          approval,
        })
      ).note;
      const ordinary = (
        await add({
          id: first.id,
          expectRevision: approved.revision,
          text: "ordinary later version",
        })
      ).note;
      const history = (await show(first.id)).versions;
      expect(history.every((version) => typeof version.at === "string")).toBe(
        true,
      );
      expect(
        history.find((version) => version.revision === approved.revision),
      ).toMatchObject({
        approval: {
          by: "owner",
          quote: { kind: "untrusted", text: approval.quote },
          at: expect.any(String) as unknown,
        },
      });
      expect(
        history.find((version) => version.revision === ordinary.revision),
      ).not.toHaveProperty("approval");
      await call("decision.propose", {
        title: "Dated choice",
        text: "Adopt the new rule.",
      });
      const proposed = (await call("decision.list")) as {
        decisions: { proposedAt: string }[];
      };
      expect(proposed.decisions[0]?.proposedAt).toBeString();
      await call("decision.adopt", { id: "ADR-001", approval });
      expect(await call("decision.list")).toMatchObject({
        decisions: [
          {
            proposedAt: proposed.decisions[0]!.proposedAt,
            adoptedAt: expect.any(String) as unknown,
            approval: { by: "owner", at: expect.any(String) as unknown },
          },
        ],
      });
    } finally {
      await assembly.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 240_000);
