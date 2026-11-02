import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { createAssembly as AssemblyFactory } from "../../../src/assembly/index.ts";
import type { ResultEnvelope } from "../../../src/generated/types.ts";

test("integration: built CLI scope batches resume until all 100 notes move in isolated stores", async () => {
  const { createAssembly } = (await import(
    pathToFileURL(
      resolve(import.meta.dirname, "../../../dist/src/assembly/index.js"),
    ).href
  )) as { createAssembly: typeof AssemblyFactory };
  const node = Bun.which("node");
  if (!node) throw new Error("Node is required");
  const root = mkdtempSync(join(tmpdir(), "forge-scope-move-"));
  const project = join(root, "project");
  const device = join(root, "device");
  const env = {
    ...process.env,
    FORGE_DEVICE_ROOT: device,
    FORGE_SESSION: "scope-test",
    FORGE_DEVICE_ID: "scope-test",
  };
  let assembly: Awaited<ReturnType<typeof createAssembly>> | undefined;
  try {
    mkdirSync(join(project, ".forge"), { recursive: true });
    writeFileSync(
      join(project, "package.json"),
      '{"name":"scope-test","private":true}',
    );
    writeFileSync(
      join(project, ".forge/config.yaml"),
      "schemaVersion: forge.config/1\nblocks:\n  memory:\n    source:\n      builtin: forge/memory\n",
    );
    expect(
      spawnSync("git", ["init", "--quiet"], {
        cwd: project,
        env,
        windowsHide: true,
        timeout: 30_000,
      }).status,
    ).toBe(0);
    const checked = spawnSync(
      node,
      ["-e", "console.log(process.env.FORGE_DEVICE_ROOT)"],
      {
        cwd: project,
        env,
        encoding: "utf8",
        windowsHide: true,
        timeout: 30_000,
      },
    );
    console.log(`FORGE_DEVICE_ROOT=${checked.stdout.trim()}`);
    expect(checked.status).toBe(0);
    expect(checked.stdout.trim()).toBe(device);
    const under = relative(root, checked.stdout.trim());
    expect(isAbsolute(under) || under.startsWith("..")).toBe(false);
    const seedStarted = performance.now();
    // Seed through the same API in one process; measured moves launch the CLI.
    assembly = await createAssembly({ root: project, deviceRoot: device });
    let request = 0;
    const call = async (op: string, input: object) => {
      const response = await assembly!.catalog.invoke({
        schemaVersion: "forge.invocation/1",
        requestId: `scope-${++request}`,
        op,
        input,
        caller: "human",
        context: {
          actor: { kind: "human", id: "tester" },
          project: { id: project, root: project },
          device: { id: device },
        },
      });
      if (!response.ok) throw new Error(JSON.stringify(response.error));
      return response.result;
    };
    const notes = Array.from({ length: 100 }, (_, n) => ({
      id: `device/note-${n + 1}`,
      scope: "alpha",
      text: { kind: "untrusted", source: "scope-test", text: `note ${n}` },
      tags: ["fact"],
      links: ["device/note-1"],
    }));
    // Restore accepts at most 25 notes per call, committed as one batch.
    for (let offset = 0; offset < notes.length; offset += 25)
      expect(
        await call("memory.restore", {
          format: "forge.memory.export/2",
          level: "device",
          approval: { by: "owner", quote: "Restore the test fixture notes." },
          notes: notes.slice(offset, offset + 25),
        }),
      ).toEqual({ added: 25, skipped: 0, conflicts: [] });
    await assembly.close();
    assembly = undefined;
    console.log(
      `100-note seed: ${Math.round(performance.now() - seedStarted)} ms`,
    );
    const started = performance.now();
    let args = [
      "memory",
      "move",
      "--input",
      '{"scope":"alpha","to":"project","limit":100}',
    ];
    const moved: { id: string; to: string }[] = [];
    let complete = false;
    for (let batch = 1; batch <= notes.length; batch += 1) {
      const batchStarted = performance.now();
      const run = spawnSync(
        node,
        [resolve(import.meta.dirname, "../../../dist/bin/forge.js"), ...args],
        {
          cwd: project,
          env,
          encoding: "utf8",
          windowsHide: true,
          timeout: 20_000,
        },
      );
      console.log(
        `scope batch ${batch}: ${Math.round(performance.now() - batchStarted)} ms`,
      );
      expect(run.status, run.stderr + run.stdout).toBe(0);
      const envelope = JSON.parse(run.stdout) as ResultEnvelope;
      expect(envelope.ok).toBe(true);
      const result = envelope.result as {
        moved: { id: string; to: string }[];
        complete: boolean;
        next?: string;
        stopped?: unknown;
      };
      expect(result.stopped).toBeUndefined();
      expect(result.moved.length).toBeGreaterThan(0);
      moved.push(...result.moved);
      expect(result).not.toHaveProperty("remaining");
      expect(result.complete).toBe(moved.length === notes.length);
      complete = result.complete;
      if (complete) {
        expect(result.next).toBeUndefined();
        break;
      }
      expect(result.next).toBe(
        "forge memory move --scope alpha --to project --limit 100",
      );
      args = result.next!.split(" ").slice(1);
    }
    console.log(
      `100-note scope moves: ${Math.round(performance.now() - started)} ms`,
    );
    expect(complete).toBe(true);
    expect(moved).toHaveLength(100);
    const readbackStarted = performance.now();
    assembly = await createAssembly({ root: project, deviceRoot: device });
    const movedByOldId = new Map(moved.map((note) => [note.id, note.to]));
    expect(movedByOldId.size).toBe(100);
    expect(new Set(movedByOldId.values()).size).toBe(100);
    type ExportedNote = {
      id: string;
      scope?: string;
      text: { text: string };
      tags: string[];
      links: string[];
    };
    const destinations = new Map<string, ExportedNote>();
    let after = 0;
    let more = true;
    while (more) {
      const page = (await call("memory.export", {
        level: "project",
        after,
      })) as {
        count: number;
        truncated: boolean;
        next?: number;
        notes: ExportedNote[];
      };
      expect(page.count).toBe(page.notes.length);
      for (const note of page.notes) {
        expect(destinations.has(note.id)).toBe(false);
        destinations.set(note.id, note);
      }
      more = page.truncated;
      if (more) {
        expect(page.next).toBeGreaterThan(after);
        after = page.next!;
      }
    }
    expect(destinations.size).toBe(100);
    for (const note of notes) {
      const destination = movedByOldId.get(note.id);
      expect(destination).toBeDefined();
      expect(destinations.get(destination!)).toMatchObject({
        id: destination,
        scope: note.scope,
        text: { text: note.text.text },
        tags: note.tags,
        links: note.links,
      });
    }
    for (const n of [0, 49, 99]) {
      const note = notes[n]!;
      expect(await call("memory.show", { id: note.id })).toMatchObject({
        status: "found",
        note: {
          id: movedByOldId.get(note.id),
          movedFrom: note.id,
          scope: note.scope,
          text: { text: note.text.text },
          tags: note.tags,
          links: note.links,
        },
      });
    }
    console.log(
      `100-note readback: ${Math.round(performance.now() - readbackStarted)} ms`,
    );
  } finally {
    await assembly?.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
