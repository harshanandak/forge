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
