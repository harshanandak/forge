import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ResultEnvelope } from "../../../src/generated/types.ts";

const bin = resolve(import.meta.dirname, "../../../dist/bin/forge.js");
const preload = pathToFileURL(
  resolve(
    import.meta.dirname,
    "../../node-fixtures/memory/drop-note-preload.mjs",
  ),
).href;

for (const level of ["device", "project"] as const) {
  test(`integration: built Node CLI refuses an acknowledged but dropped ${level} memory.add`, () => {
    const node = Bun.which("node");
    if (!node)
      throw new Error("Node runtime required for memory read-back integration");
    const root = mkdtempSync(join(tmpdir(), "forge-memory-readback-"));
    try {
      mkdirSync(join(root, ".forge"));
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          name: "memory-readback-test",
          private: true,
        }),
      );
      writeFileSync(
        join(root, ".forge/config.yaml"),
        [
          "schemaVersion: forge.config/1",
          "blocks:",
          "  memory:",
          "    source:",
          "      builtin: forge/memory",
          "",
        ].join("\n"),
      );
      const env = {
        ...(process.env.SystemRoot === undefined
          ? {}
          : { SystemRoot: process.env.SystemRoot }),
        ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
        ...(process.env.PATHEXT === undefined
          ? {}
          : { PATHEXT: process.env.PATHEXT }),
        FORGE_DEVICE_ROOT: join(root, "device"),
        FORGE_DEVICE_ID: "memory-readback-test",
        FORGE_SESSION: "memory-readback-test",
        FORGE_MEMORY_READBACK_ROOT: root,
      };
      function cli(verb: "add" | "show", input: unknown, drop = false) {
        const run = spawnSync(
          node!,
          [
            ...(drop ? ["--import", preload] : []),
            bin,
            "memory",
            verb,
            "--input",
            JSON.stringify(input),
          ],
          {
            cwd: root,
            env,
            encoding: "utf8",
            timeout: 30_000,
            windowsHide: true,
          },
        );
        if (run.error) throw run.error;
        expect(run.signal, run.stderr).toBeNull();
        return {
          exit: run.status,
          envelope: JSON.parse(run.stdout) as ResultEnvelope,
        };
      }
      const added = cli("add", { level, text: "durable note" });
      expect(added.exit).toBe(0);
      expect(added.envelope).toMatchObject({
        ok: true,
        result: { status: "added" },
      });
      if (!added.envelope.ok) throw new Error("normal memory.add failed");
      const { id } = added.envelope.result as { id: string };
      expect(cli("show", { id }).envelope).toMatchObject({
        ok: true,
        result: { status: "found", note: { text: { text: "durable note" } } },
      });
      const missingId = id.replace(
        /note-(\d+)$/,
        (_match, number: string) => `note-${Number(number) + 1}`,
      );
      expect(missingId).not.toBe(id);
      const dropped = cli(
        "add",
        { level, text: "acknowledged but dropped note" },
        true,
      );
      expect(readFileSync(join(root, "dropped-note.log"), "utf8")).toBe(
        "dropped\n",
      );
      expect(dropped.exit).toBe(1);
      expect(dropped.envelope).toMatchObject({
        ok: false,
        error: { code: "INTERNAL" },
      });
      if (dropped.envelope.ok)
        throw new Error("dropped memory.add was acknowledged as successful");
      expect(dropped.envelope.error.message).toContain("memory.add");
      expect(dropped.envelope.error.message).toMatch(/reconcil/i);
      expect(dropped.envelope.error.message).toMatch(/memory[ .]show/);
      const shown = cli("show", { id: missingId });
      expect(shown.exit).toBe(0);
      expect(shown.envelope).toMatchObject({
        ok: true,
        result: { status: "not_found" },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);
}

/** Every subprocess is confined to this disposable project and its named device root. */
function openCli() {
  const node = Bun.which("node");
  if (!node)
    throw new Error("Node runtime required for memory read-back integration");
  const root = mkdtempSync(join(tmpdir(), "forge-memory-readback-"));
  mkdirSync(join(root, ".forge"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "readback-test", private: true }),
  );
  writeFileSync(
    join(root, ".forge/config.yaml"),
    [
      "schemaVersion: forge.config/1",
      "blocks:",
      "  memory:",
      "    source:",
      "      builtin: forge/memory",
      "",
    ].join("\n"),
  );
  function cli(
    verb: "add" | "show",
    input: unknown,
    fault?: "text" | "tags" | "scope" | "audit",
  ) {
    const run = spawnSync(
      node!,
      [
        ...(fault === undefined ? [] : ["--import", preload]),
        bin,
        "memory",
        verb,
        "--input",
        JSON.stringify(input),
      ],
      {
        cwd: root,
        env: {
          ...(process.env.SystemRoot === undefined
            ? {}
            : { SystemRoot: process.env.SystemRoot }),
          ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
          ...(process.env.PATHEXT === undefined
            ? {}
            : { PATHEXT: process.env.PATHEXT }),
          FORGE_DEVICE_ROOT: join(root, "device"),
          FORGE_DEVICE_ID: "memory-readback-test",
          FORGE_SESSION: "memory-readback-test",
          FORGE_MEMORY_READBACK_ROOT: root,
          ...(fault === undefined
            ? {}
            : { FORGE_MEMORY_READBACK_FAULT: fault }),
        },
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
      },
    );
    if (run.error) throw run.error;
    expect(run.signal, run.stderr).toBeNull();
    return {
      exit: run.status,
      envelope: JSON.parse(run.stdout) as ResultEnvelope,
    };
  }
  return {
    root,
    cli,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

function successful(reply: { exit: number | null; envelope: ResultEnvelope }) {
  expect(reply.exit).toBe(0);
  expect(reply.envelope.ok).toBe(true);
  if (!reply.envelope.ok) throw new Error(reply.envelope.error.message);
  return reply.envelope.result as {
    id: string;
    status: string;
    note: Record<string, unknown>;
  };
}

for (const level of ["device", "project"] as const) {
  test(`integration: built Node CLI refuses matching altered values and acknowledgments on ${level} adds and edits`, () => {
    const h = openCli();
    try {
      const seed = successful(
        h.cli("add", { level, text: "seed", scope: "old", tags: ["old"] }),
      );
      const events: string[] = [];
      let next = 2;
      let revision = 1;
      for (const operation of ["add", "edit"] as const) {
        for (const field of ["text", "tags", "scope"] as const) {
          const id =
            operation === "edit"
              ? seed.id
              : seed.id.replace(/note-\d+$/, `note-${next++}`);
          const result = h.cli(
            "add",
            {
              level,
              text: "requested",
              tags: ["requested"],
              scope: "requested",
              ...(operation === "edit"
                ? { id, expectRevision: revision++ }
                : {}),
            },
            field,
          );
          events.push(`${operation} ${field}`);
          expect(readFileSync(join(h.root, "altered-note.log"), "utf8")).toBe(
            `${events.join("\n")}\n`,
          );
          expect(result.exit).toBe(1);
          expect(result.envelope).toMatchObject({
            ok: false,
            error: { code: "INTERNAL" },
          });
          if (result.envelope.ok)
            throw new Error(
              "altered memory.add was acknowledged as successful",
            );
          expect(result.envelope.error.message).toContain("memory.add");
          expect(result.envelope.error.message).toMatch(/reconcil/i);
          expect(result.envelope.error.message).toMatch(/memory[ .]show/);
          const shown = successful(h.cli("show", { id }));
          expect(shown.status).toBe("found");
          expect(shown.note[field]).toEqual(
            field === "text"
              ? {
                  kind: "untrusted",
                  source: `memory:${id}`,
                  text: "altered text",
                  receivedAt: expect.any(String) as unknown,
                }
              : field === "tags"
                ? ["altered"]
                : "altered",
          );
        }
      }
    } finally {
      h.close();
    }
  }, 240_000);

  test(`integration: built Node CLI preserves raw ${level} text and partial edit semantics`, () => {
    const h = openCli();
    try {
      const texts = [
        "simple note",
        "  leading\tspace\nCafé e\u0301 漢字 🪶 ⟦fence⟧  ",
        "x".repeat(8000),
      ];
      let id = "";
      for (const text of texts) {
        const added = successful(
          h.cli(
            "add",
            {
              level,
              text,
              tags: ["kept"],
              scope: "kept",
              links: ["device/note-7"],
            },
            "audit",
          ),
        );
        id = added.id;
        expect(added.status).toBe("added");
        const display = text.replaceAll("⟦", "(").replaceAll("⟧", ")");
        expect(added.note.text).toMatchObject({
          kind: "untrusted",
          source: `memory:${id}`,
          text: display,
        });
        const shown = successful(h.cli("show", { id }));
        expect(shown.status).toBe("found");
        expect(shown.note.text).toMatchObject({
          kind: "untrusted",
          source: `memory:${id}`,
          text: display,
        });
        const persisted = JSON.parse(
          readFileSync(join(h.root, "persisted-note.log"), "utf8")
            .trimEnd()
            .split("\n")
            .at(-1)!,
        ) as { text: string };
        expect(persisted.text).toBe(text);
      }
      const edited = successful(
        h.cli("add", { id, expectRevision: 1, text: "edited" }, "audit"),
      );
      expect(edited.status).toBe("updated");
      expect(edited.note).toMatchObject({
        tags: ["kept"],
        scope: "kept",
        links: ["device/note-7"],
      });
      const cleared = successful(
        h.cli(
          "add",
          { id, expectRevision: 2, text: "cleared", scope: null },
          "audit",
        ),
      );
      expect(cleared.status).toBe("updated");
      expect(cleared.note).toMatchObject({
        tags: ["kept"],
        links: ["device/note-7"],
      });
      expect(Object.hasOwn(cleared.note, "scope")).toBe(false);
      const persisted = JSON.parse(
        readFileSync(join(h.root, "persisted-note.log"), "utf8")
          .trimEnd()
          .split("\n")
          .at(-1)!,
      ) as Record<string, unknown>;
      expect(Object.hasOwn(persisted, "scope")).toBe(false);
      expect(persisted).toMatchObject({
        text: "cleared",
        tags: ["kept"],
        links: ["device/note-7"],
      });
    } finally {
      h.close();
    }
  }, 240_000);
}
