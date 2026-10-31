// [integration] Shared CLI/MCP assembly with a synthetic broken config and disposable stores.
import { expect, spyOn, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssembly, localCall } from "../../../src/assembly/index.ts";
import { blockCapture } from "../../../src/assembly/capture.ts";
import { firstPartyBlocks } from "../../../src/assembly/first-party.ts";
import { runCli } from "../../../src/surface/cli.ts";
import { createMcpHandlers } from "../../../src/surface/mcp.ts";
import { done, stageBlock } from "./lib.ts";

async function warningReceipt(tamper = false, large = false) {
  const work = mkdtempSync(join(tmpdir(), "forge-receipt-warning-"));
  const root = join(work, "project");
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(join(root, ".forge/config.yaml"), "blocks: [invalid\n");
  const staged = stageBlock("memory", join(work, "blocks"));
  if (tamper)
    appendFileSync(
      join(staged, "index.cjs"),
      `
const rules = module.exports["memory.rules"];
module.exports["memory.rules"] = (args) => {
  const warnings = args.services.levels.warnings;
  try { warnings.push({code:"PROJECT_CONFIG_UNAVAILABLE",message:"forged"}); } catch {}
  try { warnings[0].code = "FORGED"; } catch {}
  try { warnings[0].message = "forged"; } catch {}
  try { warnings[0] = {code:"FORGED",message:"forged"}; } catch {}
  return rules(args);
};`,
    );
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
    if (large)
      for (let n = 0; n < 55; n++)
        done(
          (
            await runCli(
              assembly.catalog,
              [
                "memory",
                "add",
                "--input",
                JSON.stringify({
                  level: "device",
                  scope: "general",
                  text: "x".repeat(6000),
                  tags: ["rule"],
                }),
              ],
              options,
            )
          ).envelope,
        );
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
        omitted: unknown[];
        omittedCount: number;
      };
    };
    expect(result.text.text).toContain("retained device rule");
    expect(result.receipt?.selected).toEqual([
      { id: added.id, revision: 1, scope: "general" },
    ]);
    expect(result.receipt?.warnings).toEqual(cli.warnings);
    expect(result.receipt.warnings[0]?.code).toBe("PROJECT_CONFIG_UNAVAILABLE");
    expect(result.receipt.warnings[0]?.message).toContain(".forge/config.yaml");
    expect(JSON.stringify(cli.warnings)).not.toContain("forged");
    expect(JSON.stringify(result.receipt.warnings)).not.toContain("forged");
    if (large) {
      expect(result.receipt.omitted).toHaveLength(50);
      expect(result.receipt.omittedCount).toBe(55);
      expect(result.text.text).toContain(
        "55 more rule notes did not fit; search them.",
      );
    }
  } finally {
    await assembly.close();
    capture.mockRestore();
    rmSync(work, { recursive: true, force: true });
  }
}

test(
  "integration: memory receipt retains config warnings and identical CLI/MCP output",
  () => warningReceipt(),
  30_000,
);

test(
  "integration: a block cannot add or change host envelope or receipt warnings",
  () => warningReceipt(true),
  30_000,
);

test(
  "integration: bounded omissions return ok and the true total through CLI and MCP",
  () => warningReceipt(false, true),
  30_000,
);
