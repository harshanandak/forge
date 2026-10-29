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
import type { ResultEnvelope } from "../../src/generated/types.ts";
import { done } from "../blocks/memory/lib.ts";

const { createAssembly, localCall } = (await import(
  pathToFileURL(resolve("dist/src/assembly/index.js")).href
)) as typeof import("../../src/assembly/index.ts");
const { createMcpHandlers } = (await import(
  pathToFileURL(resolve("dist/src/surface/mcp.js")).href
)) as typeof import("../../src/surface/mcp.ts");
const bin = resolve("dist/bin/forge.js");
const owner = {
  by: "owner",
  quote: "Forget that rule; bring it back when I ask.",
};
const agent = {
  by: "agent",
  reason: "This disposable note has served its purpose.",
};

function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const scan = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) scan(path);
      else
        files[path] = createHash("sha256")
          .update(readFileSync(path))
          .digest("hex");
    }
  };
  scan(root);
  return files;
}

async function fixture(
  route: "cli" | "mcp",
  policy: Record<string, unknown> = {},
) {
  const root = mkdtempSync(join(tmpdir(), "forge-conversation-"));
  const deviceRoot = join(root, "device");
  mkdirSync(join(root, ".forge"));
  writeFileSync(
    join(root, ".forge/config.yaml"),
    JSON.stringify({
      schemaVersion: "forge.config/1",
      blocks: {
        memory: {
          source: { builtin: "forge/memory" },
          config: { decisions: { idPattern: "ADR-NNN" }, ...policy },
        },
      },
    }),
  );
  const assembly = await createAssembly({ root, deviceRoot });
  const options = localCall(assembly);
  const handlers = createMcpHandlers(
    assembly.catalog,
    { budget: 100 },
    options,
  );
  const call = async (
    op: string,
    input: Record<string, unknown>,
  ): Promise<ResultEnvelope> => {
    if (route === "mcp") {
      const result = await handlers.callTool(op.replace(".", "_"), input);
      if (!result) throw new Error(`MCP did not expose ${op}`);
      return result;
    }
    const args =
      input.undo === true
        ? [
            String(input.id),
            "--undo",
            "--approval",
            JSON.stringify(input.approval),
          ]
        : ["--input", JSON.stringify(input)];
    const result = spawnSync("node", [bin, ...op.split("."), ...args], {
      cwd: root,
      env: {
        ...process.env,
        FORGE_DEVICE_ROOT: deviceRoot,
        FORGE_AGENT: "approval-test",
      },
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
    });
    if (result.error) throw result.error;
    const envelope = JSON.parse(result.stdout) as ResultEnvelope;
    expect(result.status).toBe(envelope.ok ? 0 : 1);
    return envelope;
  };
  return {
    root,
    call,
    handlers,
    async close() {
      await assembly.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

for (const route of ["cli", "mcp"] as const) {
  test(`integration: ${route} owner forget hides content and undo restores all retained fields`, async () => {
    const h = await fixture(route);
    try {
      const first = done(
        await h.call("memory.add", {
          level: "device",
          text: "secret alpha",
          scope: "general",
          tags: ["rule"],
          links: ["device/note-2"],
        }),
      ) as { id: string; note: { revision: number } };
      done(
        await h.call("memory.add", {
          id: first.id,
          text: "secret beta",
          expectRevision: first.note.revision,
        }),
      );
      const before = done(await h.call("memory.show", { id: first.id })) as {
        note: Record<string, unknown>;
      };
      expect(
        JSON.stringify(done(await h.call("memory.rules", { notes: true }))),
      ).toContain("secret beta");
      expect(
        await h.call("memory.forget", { id: first.id, approval: owner }),
      ).toMatchObject({ ok: true, result: { status: "forgotten" } });
      const forgotten = done(await h.call("memory.show", { id: first.id }));
      expect(forgotten).toMatchObject({
        status: "forgotten",
        approval: {
          by: "owner",
          quote: { kind: "untrusted", text: owner.quote },
          at: expect.any(String) as unknown,
        },
      });
      expect(JSON.stringify(forgotten)).not.toContain("secret");
      for (const [op, input] of [
        ["memory.show", { id: first.id, revision: first.note.revision }],
        ["memory.search", { query: "secret" }],
        ["memory.rules", {}],
        ["memory.rules", { notes: true }],
        ["memory.export", { level: "device" }],
        ["memory.move", { id: first.id, to: "project", expectRevision: 3 }],
        [
          "memory.move",
          { id: first.id, to: "project", expectRevision: 3, keep: true },
        ],
      ] as const)
        expect(JSON.stringify(await h.call(op, input))).not.toContain("secret");
      expect(
        await h.call("memory.forget", {
          id: first.id,
          undo: true,
          approval: owner,
        }),
      ).toMatchObject({ ok: true });
      const back = done(await h.call("memory.show", { id: first.id })) as {
        note: Record<string, unknown>;
      };
      expect(back.note.text).toMatchObject({ text: "secret beta" });
      for (const key of ["tags", "scope", "links", "versions"])
        expect(back.note[key]).toEqual(before.note[key]);
      expect(
        done(
          await h.call("memory.show", {
            id: first.id,
            revision: first.note.revision,
          }),
        ),
      ).toMatchObject({
        status: "found",
        note: { text: { text: "secret alpha" } },
      });
      const files = snapshot(h.root);
      expect(
        await h.call("memory.forget", {
          id: first.id,
          undo: true,
          approval: owner,
        }),
      ).toMatchObject({ ok: true, result: { status: "not_forgotten" } });
      expect(snapshot(h.root)).toEqual(files);
    } finally {
      await h.close();
    }
  }, 240_000);

  test(`integration: ${route} approval refusal is byte-identical and agent notes record reasons`, async () => {
    const h = await fixture(route);
    try {
      done(
        await h.call("memory.add", {
          level: "device",
          text: "kept",
          tags: ["rule"],
        }),
      );
      const files = snapshot(h.root);
      for (const approval of [undefined, agent]) {
        const result = await h.call("memory.forget", {
          id: "device/note-1",
          ...(approval ? { approval } : {}),
        });
        expect(result).toMatchObject({
          ok: false,
          error: {
            code: "HUMAN_REQUIRED",
            message: expect.stringContaining("rule") as unknown,
          },
        });
        expect(JSON.stringify(result)).toContain(
          "Ask the owner in the conversation, then retry with approval by owner and their words.",
        );
        expect(snapshot(h.root)).toEqual(files);
      }
      done(await h.call("memory.add", { level: "device", text: "temporary" }));
      done(
        await h.call("memory.forget", { id: "device/note-2", approval: agent }),
      );
      expect(
        done(await h.call("memory.show", { id: "device/note-2" })),
      ).toMatchObject({
        status: "forgotten",
        approval: {
          by: "agent",
          reason: { kind: "untrusted", text: agent.reason },
          at: expect.any(String) as unknown,
        },
      });
    } finally {
      await h.close();
    }
  }, 240_000);

  test(`integration: ${route} configured owner tags and adoption policy govern approval`, async () => {
    const h = await fixture(route, {
      approval: { ownerTags: ["fact"], adopt: "agent" },
    });
    try {
      for (const tag of ["rule", "fact"])
        done(
          await h.call("memory.add", {
            level: "device",
            text: tag,
            tags: [tag],
          }),
        );
      expect(
        await h.call("memory.forget", { id: "device/note-1", approval: agent }),
      ).toMatchObject({ ok: true });
      const files = snapshot(h.root);
      expect(
        await h.call("memory.forget", { id: "device/note-2", approval: agent }),
      ).toMatchObject({
        ok: false,
        error: {
          code: "HUMAN_REQUIRED",
          message: expect.stringContaining("fact") as unknown,
        },
      });
      expect(snapshot(h.root)).toEqual(files);
      done(
        await h.call("decision.propose", {
          title: "Choice",
          text: "adopt this",
        }),
      );
      expect(
        await h.call("decision.adopt", { id: "ADR-001", approval: agent }),
      ).toMatchObject({ ok: true, result: { status: "adopted" } });
      expect(done(await h.call("decision.list", {}))).toMatchObject({
        decisions: [
          {
            approval: {
              by: "agent",
              reason: { text: agent.reason },
              at: expect.any(String) as unknown,
            },
          },
        ],
      });
    } finally {
      await h.close();
    }
  }, 240_000);

  test(`integration: ${route} restore, adopt and owner-tag removal use conversation approval`, async () => {
    const h = await fixture(route);
    try {
      done(
        await h.call("memory.add", {
          level: "device",
          text: "unrelated existing note",
        }),
      );
      const restore = {
        format: "forge.memory.export/2",
        level: "device",
        notes: [
          {
            id: "device/note-3",
            tags: ["preference"],
            links: [],
            text: { kind: "untrusted", source: "test", text: "imported" },
          },
        ],
      };
      const files = snapshot(h.root);
      expect(
        await h.call("memory.restore", { ...restore, approval: agent }),
      ).toMatchObject({
        ok: false,
        error: {
          code: "HUMAN_REQUIRED",
          message: expect.stringContaining("preference") as unknown,
        },
      });
      expect(snapshot(h.root)).toEqual(files);
      expect(
        await h.call("memory.restore", { ...restore, approval: owner }),
      ).toMatchObject({ ok: true, result: { added: 1 } });
      expect(
        done(await h.call("memory.show", { id: "device/note-3" })),
      ).toMatchObject({
        note: {
          approval: {
            by: "owner",
            quote: { text: owner.quote },
            at: expect.any(String) as unknown,
          },
        },
      });
      expect(
        await h.call("memory.restore", {
          ...restore,
          notes: [{ ...restore.notes[0], id: "device/note-4", tags: [] }],
          approval: agent,
        }),
      ).toMatchObject({ ok: true, result: { added: 1 } });
      done(
        await h.call("decision.propose", {
          title: "Choice",
          text: "adopt this",
        }),
      );
      const beforeAdopt = snapshot(h.root);
      expect(
        await h.call("decision.adopt", { id: "ADR-001", approval: agent }),
      ).toMatchObject({
        ok: false,
        error: {
          code: "HUMAN_REQUIRED",
          message: expect.stringContaining("adopt") as unknown,
        },
      });
      expect(snapshot(h.root)).toEqual(beforeAdopt);
      expect(
        await h.call("decision.adopt", { id: "ADR-001", approval: owner }),
      ).toMatchObject({ ok: true });
      expect(done(await h.call("decision.list", {}))).toMatchObject({
        decisions: [
          {
            approval: {
              by: "owner",
              quote: { text: owner.quote },
              at: expect.any(String) as unknown,
            },
          },
        ],
      });
      done(
        await h.call("memory.add", {
          id: "device/note-3",
          text: "edited",
          tags: ["preference", "rule"],
          expectRevision: 1,
        }),
      );
      const beforeEdit = snapshot(h.root);
      for (const approval of [undefined, agent]) {
        expect(
          await h.call("memory.add", {
            id: "device/note-3",
            text: "edited",
            tags: [],
            expectRevision: 2,
            ...(approval ? { approval } : {}),
          }),
        ).toMatchObject({ ok: false, error: { code: "HUMAN_REQUIRED" } });
        expect(snapshot(h.root)).toEqual(beforeEdit);
      }
      done(
        await h.call("memory.add", {
          id: "device/note-3",
          text: "edited",
          tags: [],
          expectRevision: 2,
          approval: owner,
        }),
      );
      const shown = done(await h.call("memory.show", { id: "device/note-3" }));
      expect(shown).toMatchObject({
        note: {
          tags: [],
          approval: {
            by: "owner",
            quote: { text: owner.quote },
            at: expect.any(String) as unknown,
          },
        },
      });
      if (route === "mcp")
        for (const name of [
          "memory_forget",
          "memory_restore",
          "decision_adopt",
        ])
          expect(h.handlers.listTools().map((t) => t.name)).toContain(name);
    } finally {
      await h.close();
    }
  }, 240_000);
}
