import { expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssembly } from "../../../src/assembly/index.ts";
import { blockCapture } from "../../../src/assembly/capture.ts";
import { firstPartyBlocks } from "../../../src/assembly/first-party.ts";
import { stageBlock } from "../../blocks/memory/lib.ts";

test("device-only discovery exposes memory without creating a project or device store", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-device-memory-"));
  const deviceRoot = join(root, "device");
  const staged = stageBlock("memory", join(root, "builtins"));
  const source = fileURLToPath(firstPartyBlocks["forge/memory"]!);
  const open = blockCapture.open;
  const capture = spyOn(blockCapture, "open").mockImplementation((path) =>
    open(path === source ? staged : path),
  );
  const assembly = await createAssembly({
    root,
    deviceRoot,
    project: false,
    providers: { env: {} },
  });
  try {
    expect(assembly.catalog.list().map((entry) => entry.op)).toContain(
      "memory.add",
    );
    expect(assembly.catalog.list().map((entry) => entry.op)).toContain(
      "memory.search",
    );
    expect(existsSync(join(root, ".forge"))).toBe(false);
    expect(existsSync(deviceRoot)).toBe(false);
  } finally {
    await assembly.close();
    capture.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("a project with memory disabled keeps its configured composition", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-device-memory-"));
  mkdirSync(join(root, ".forge"));
  writeFileSync(
    join(root, ".forge/config.yaml"),
    JSON.stringify({
      schemaVersion: "forge.config/1",
      blocks: {
        memory: { source: { builtin: "forge/memory" }, enabled: false },
      },
    }),
  );
  const assembly = await createAssembly({
    root,
    deviceRoot: join(root, "device"),
    project: false,
    providers: { env: {} },
  });
  try {
    expect(assembly.catalog.list().map((entry) => entry.op)).not.toContain(
      "memory.add",
    );
  } finally {
    await assembly.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
