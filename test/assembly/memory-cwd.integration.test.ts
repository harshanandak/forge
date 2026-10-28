// [integration] Nested memory follows the current folder, never an ancestor's config.
import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAssembly, localCall } from "../../src/assembly/index.ts";
import { blockCapture } from "../../src/assembly/capture.ts";
import { firstPartyBlocks } from "../../src/assembly/first-party.ts";
import { fileURLToPath } from "node:url";
import { runCli } from "../../src/surface/cli.ts";
import { stageBlock } from "../blocks/memory/lib.ts";
import * as configFiles from "../../src/adapters/fs/index.ts";

const env: Record<string, string> = {};
for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "TEMP", "TMP"])
  if (process.env[key] !== undefined) env[key] = process.env[key]!;

for (const [name, config, args] of [
  [
    "nested scope ignores an ancestor override without reading its config",
    "blocks:\n  memory:\n    scope: repo:override\n",
    ["memory", "scope"],
  ],
  [
    "nested device export ignores a broken ancestor config",
    "template: old\nadapters: {}\n",
    ["memory", "export", "--input", '{"level":"device"}'],
  ],
  [
    "nested rules ignore an invalid ancestor memory setting without reading its config",
    "blocks:\n  memory:\n    scope: 33\n",
    ["memory", "rules"],
  ],
] as const) {
  test(
    name,
    async () => {
      const work = fs.mkdtempSync(join(tmpdir(), "forge-memory-cwd-"));
      const root = join(work, "project");
      const nested = join(root, "nested");
      const deviceRoot = join(work, "device");
      fs.mkdirSync(join(root, ".forge"), { recursive: true });
      fs.mkdirSync(nested);
      fs.mkdirSync(deviceRoot);
      fs.writeFileSync(
        join(deviceRoot, "memory-scopes.json"),
        '{"project":"device-alias"}',
      );
      const configPath = join(root, ".forge", "config.yaml");
      fs.writeFileSync(configPath, config);
      expect(
        spawnSync("git", ["init", "--quiet"], { cwd: root, env }).status,
      ).toBe(0);
      const staged = stageBlock("memory", join(work, "builtins"));
      const source = fileURLToPath(firstPartyBlocks["forge/memory"]!);
      const captureOpen = blockCapture.open.bind(blockCapture);
      const capture = spyOn(blockCapture, "open").mockImplementation((path) =>
        captureOpen(path === source ? staged : path),
      );
      const opened: string[] = [];
      const files = configFiles.nodeConfigFiles;
      const reads = spyOn(configFiles, "nodeConfigFiles").mockImplementation(
        (folder) => {
          const port = files(folder);
          return {
            ...port,
            read(path, maxBytes) {
              opened.push(join(folder, path));
              return port.read(path, maxBytes);
            },
          };
        },
      );
      const assembly = await createAssembly({
        root: nested,
        deviceRoot,
        providers: { env },
      });
      try {
        const result = await runCli(
          assembly.catalog,
          [...args],
          localCall(assembly),
        );
        // Main reads only cwd's config. Slice A adds checkout scope resolution,
        // but must not make project config inheritance part of that resolution.
        expect(result.exitCode).toBe(0);
        expect(result.envelope.warnings).toEqual([]);
        expect(opened.map((path) => resolve(path))).not.toContain(
          resolve(configPath),
        );
        if (args[1] === "scope")
          expect(result.envelope).toMatchObject({
            result: { scope: "device-alias" },
          });
        if (args[1] === "rules" && result.envelope.ok) {
          const rules = result.envelope.result as { text: { text: string } };
          expect(rules.text.text).toContain("device-alias 0.");
        }
      } finally {
        await assembly.close();
        reads.mockRestore();
        capture.mockRestore();
        fs.rmSync(work, { recursive: true, force: true });
      }
    },
    90_000,
  );
}
