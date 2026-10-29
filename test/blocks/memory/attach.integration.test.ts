// [integration] Catalog CLI/MCP parity and byte-for-byte store preservation on disposable stores.
import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { localCall } from "../../../src/assembly/index.ts";
import { runCli } from "../../../src/surface/cli.ts";
import { createMcpHandlers } from "../../../src/surface/mcp.ts";
import { done, openHarness } from "./lib.ts";

function snapshot(root: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => {
        const path = join(e.parentPath, e.name);
        return [path, readFileSync(path).toString("base64")];
      }),
  );
}
test("integration: attach CLI and MCP agree, exclude another project's notes, and leave all store files unchanged", async () => {
  const alpha = await openHarness(["memory"], { "memory.scope": "alpha" });
  const beta = await openHarness(
    ["memory"],
    {},
    { deviceRoot: alpha.deviceRoot, project: "beta" },
  );
  try {
    const add = async (
      h: typeof alpha,
      level: string,
      scope: string,
      text: string,
    ) =>
      done(
        await h.call("memory.add", { level, scope, text, tags: ["on:memory"] }),
      ) as { id: string };
    const general = await add(alpha, "device", "general", "shared memory");
    const foreign = await add(
      beta,
      "project",
      "general",
      "foreign project memory",
    );
    await add(alpha, "device", "beta", "foreign scoped memory");
    const options = localCall(alpha.assembly);
    const before = snapshot(alpha.work);
    const rules = JSON.stringify(
      done(await alpha.call("memory.rules", { notes: true })),
    );
    const input = { paths: ["src/blocks/memory/index.cts"], ids: [foreign.id] };
    const cli = (
      await runCli(
        alpha.assembly.catalog,
        ["memory", "attach", "--input", JSON.stringify(input)],
        options,
      )
    ).envelope;
    expect(cli.ok).toBe(true);
    const mcp = createMcpHandlers(alpha.assembly.catalog, {}, options);
    expect(await mcp.callTool("memory_attach", input)).toEqual(cli);
    const result = done(cli) as {
      receipt: { selected: { id: string; revision: number }[] };
    };
    expect(result.receipt.selected.map((n) => n.id)).toEqual([general.id]);
    expect(
      (
        await runCli(
          alpha.assembly.catalog,
          [
            "memory",
            "attach",
            "--input",
            JSON.stringify({ ...input, seen: result.receipt.selected }),
          ],
          options,
        )
      ).envelope.ok,
    ).toBe(true);
    expect(
      JSON.stringify(done(await alpha.call("memory.rules", { notes: true }))),
    ).toBe(rules);
    expect(snapshot(alpha.work)).toEqual(before);
  } finally {
    await beta.close();
    await alpha.close();
  }
}, 60_000);
