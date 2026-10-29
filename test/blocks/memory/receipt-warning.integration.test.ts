// [integration] Shared CLI/MCP assembly with a synthetic broken config and disposable stores.
import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssembly, localCall } from "../../../src/assembly/index.ts";
import { blockCapture } from "../../../src/assembly/capture.ts";
import { firstPartyBlocks } from "../../../src/assembly/first-party.ts";
import { runCli } from "../../../src/surface/cli.ts";
import { createMcpHandlers } from "../../../src/surface/mcp.ts";
import { done, stageBlock } from "./lib.ts";

test("integration: memory receipt retains config warnings and identical CLI/MCP output", async () => {
  const work = mkdtempSync(join(tmpdir(), "forge-receipt-warning-"));
  const root = join(work, "project");
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(join(root, ".forge/config.yaml"), "blocks: [invalid\n");
  const staged = stageBlock("memory", join(work, "blocks"));
  const builtin = fileURLToPath(firstPartyBlocks["forge/memory"]!);
  const open = blockCapture.open.bind(blockCapture);
  const capture = spyOn(blockCapture, "open").mockImplementation((path) =>
    open(path === builtin ? staged : path),
  );
  const assembly = await createAssembly({
    root,
    deviceRoot: join(work, "device"),
  });
  try {
    const options = localCall(assembly);
    const added = done(
      (
        await runCli(
          assembly.catalog,
          [
            "memory",
            "add",
            "--input",
            '{"level":"device","scope":"general","text":"retained device rule","tags":["rule"]}',
          ],
          options,
        )
      ).envelope,
    ) as { id: string };
    const cli = (
      await runCli(
        assembly.catalog,
        ["memory", "rules", "--notes", "--json"],
        options,
      )
    ).envelope;
    const mcp = await createMcpHandlers(assembly.catalog, {}, options).callTool(
      "memory_rules",
      { notes: true },
    );
    expect(mcp).toEqual(cli);
    expect(cli.warnings).toHaveLength(1);
    const result = done(cli) as {
      text: { text: string };
      receipt: {
        warnings: readonly { code: string; message: string }[];
        selected: unknown[];
      };
    };
    expect(result.text.text).toContain("retained device rule");
    expect(result.receipt?.selected).toEqual([
      { id: added.id, revision: 1, scope: "general" },
    ]);
    expect(result.receipt?.warnings).toEqual(cli.warnings);
    expect(result.receipt.warnings[0]?.code).toBe("PROJECT_CONFIG_UNAVAILABLE");
    expect(result.receipt.warnings[0]?.message).toContain(".forge/config.yaml");
  } finally {
    await assembly.close();
    capture.mockRestore();
    rmSync(work, { recursive: true, force: true });
  }
}, 30_000);
