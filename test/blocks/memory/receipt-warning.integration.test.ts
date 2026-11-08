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
import { done, memoryTimings, ownerApproval, stageBlock } from "./lib.ts";
import { approvalReply } from "../../fixtures/owner-approval.mjs";

async function warningReceipt(tamper = false, large = false) {
  const work = mkdtempSync(join(tmpdir(), "forge-receipt-warning-"));
  const root = join(work, "project");
  mkdirSync(join(root, ".forge"), { recursive: true });
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
    // An owner-tagged add is only proposed: the owner's relayed accept makes it a served rule.
    const accept = async (approval: unknown) =>
      (
        await runCli(
          assembly.catalog,
          [
            "memory",
            "accept",
            "--input",
            JSON.stringify({ ids: [added.id], approval }),
          ],
          options,
        )
      ).envelope;
    done(
      await accept(
        approvalReply(
          await accept(ownerApproval),
          { harness: "fixture", thread: "fixture" },
          ownerApproval.quote,
        ),
      ),
    );
    // Restore writes a page of 25 notes in one transaction; 55 single adds outlast the deadline on Windows CI.
    if (large)
      for (let start = 0; start < 55; start += 25) {
        const page = {
          format: "forge.memory.export/2",
          level: "device",
          notes: Array.from(
            { length: Math.min(25, 55 - start) },
            (_, offset) => ({
              id: `device/note-${start + offset + 100}`,
              scope: "general",
              tags: ["rule"],
              links: [],
              text: {
                kind: "untrusted",
                source: "seed",
                text: "x".repeat(6000),
              },
            }),
          ),
        };
        const restore = async (approval: unknown) =>
          (
            await runCli(
              assembly.catalog,
              [
                "memory",
                "restore",
                "--input",
                JSON.stringify({ approval, ...page }),
              ],
              options,
            )
          ).envelope;
        // The owner's words are relayed: the claim gets a request, the retry carries it.
        const asked = await restore(ownerApproval);
        done(
          await restore(
            approvalReply(
              asked,
              { harness: "fixture", thread: "fixture" },
              ownerApproval.quote,
            ),
          ),
        );
      }
    // Broken after seeding: restore refuses an unreadable config, while rules must still answer.
    writeFileSync(join(root, ".forge/config.yaml"), "blocks: [invalid\n");
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
      { id: added.id, revision: 2, scope: "general" },
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
  () => memoryTimings(() => warningReceipt()),
  30_000,
);

test(
  "integration: a block cannot add or change host envelope or receipt warnings",
  () => memoryTimings(() => warningReceipt(true)),
  30_000,
);

test(
  "integration: bounded omissions return ok and the true total through CLI and MCP",
  () => memoryTimings(() => warningReceipt(false, true)),
  30_000,
);
