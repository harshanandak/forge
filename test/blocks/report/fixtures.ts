import { spyOn } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { blockCapture } from "../../../src/assembly/capture.ts";
import { firstPartyBlocks } from "../../../src/assembly/first-party.ts";
import { createAssembly, localCall } from "../../../src/assembly/index.ts";

export async function withReportAssembly(
  run: (
    assembly: Awaited<ReturnType<typeof createAssembly>>,
    options: ReturnType<typeof localCall>,
  ) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "forge-report-"));
  const deviceRoot = join(root, "device");
  const source = firstPartyBlocks["forge/report"];
  const open = blockCapture.open.bind(blockCapture);
  const capture = spyOn(blockCapture, "open");
  try {
    if (source !== undefined) {
      const path = fileURLToPath(source);
      const staged = join(root, "staged");
      cpSync(path, staged, {
        recursive: true,
        filter: (file) => !/\.[cm]?ts$/.test(file),
      });
      const bundle = await Bun.build({
        entrypoints: [join(path, "entry.cts")],
        target: "node",
        format: "cjs",
      });
      writeFileSync(join(staged, "entry.cjs"), await bundle.outputs[0]!.text());
      capture.mockImplementation((file) => open(file === path ? staged : file));
    }
    mkdirSync(join(root, ".forge"));
    writeFileSync(
      join(root, ".forge/config.yaml"),
      JSON.stringify({
        schemaVersion: "forge.config/1",
        blocks: { report: { source: { builtin: "forge/report" } } },
      }),
    );
    const assembly = await createAssembly({
      root,
      deviceRoot,
      providers: { env: {} },
    });
    try {
      await run(assembly, localCall(assembly));
    } finally {
      await assembly.close();
    }
  } finally {
    capture.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
}
