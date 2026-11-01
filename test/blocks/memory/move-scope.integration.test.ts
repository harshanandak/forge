import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { createAssembly as AssemblyFactory } from "../../../src/assembly/index.ts";
import type { ResultEnvelope } from "../../../src/generated/types.ts";

test("integration: one built CLI call moves 100 notes in under 20 seconds in isolated stores", async () => {
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
    // Seed through the same API in one process; only the measured move launches a CLI.
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
    for (let n = 0; n < 100; n += 1)
      await call("memory.add", {
        level: "device",
        scope: "alpha",
        text: `note ${n}`,
        tags: ["fact"],
        links: ["device/note-1"],
      });
    await assembly.close();
    assembly = undefined;
    const started = performance.now();
    const run = spawnSync(
      node,
      [
        resolve(import.meta.dirname, "../../../dist/bin/forge.js"),
        "memory",
        "move",
        "--input",
        '{"scope":"alpha","to":"project","limit":100}',
      ],
      {
        cwd: project,
        env,
        encoding: "utf8",
        windowsHide: true,
        timeout: 20_000,
      },
    );
    const elapsed = performance.now() - started;
    console.log(`100-note scope batch: ${Math.round(elapsed)} ms`);
    expect(run.status, run.stderr + run.stdout).toBe(0);
    expect(elapsed).toBeLessThan(20_000);
    const envelope = JSON.parse(run.stdout) as ResultEnvelope;
    expect(envelope.ok).toBe(true);
    const result = envelope.result as { moved: { id: string; to: string }[] };
    expect(result).toMatchObject({ remaining: 0, complete: true });
    expect(result.moved).toHaveLength(100);
    assembly = await createAssembly({ root: project, deviceRoot: device });
    for (const [n, moved] of result.moved.entries()) {
      expect(await call("memory.show", { id: moved.id })).toMatchObject({
        status: "found",
        note: {
          id: moved.to,
          movedFrom: moved.id,
          scope: "alpha",
          text: { text: `note ${n}` },
          tags: ["fact"],
          links: ["device/note-1"],
        },
      });
    }
  } finally {
    await assembly?.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
