// [integration] Catalog CLI/MCP parity and byte-for-byte store preservation on disposable stores.
import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { localCall } from "../../../src/assembly/index.ts";
import { runCli } from "../../../src/surface/cli.ts";
import { createMcpHandlers } from "../../../src/surface/mcp.ts";
import {
  blockSchema,
  done,
  openHarness,
  ownerApproval,
  type Harness,
} from "./lib.ts";

async function restore(
  h: Harness,
  count: number,
  text: string | ((index: number) => string),
) {
  for (let start = 0; start < count; start += 25)
    done(
      await h.call("memory.restore", {
        format: "forge.memory.export/2",
        level: "device",
        approval: ownerApproval,
        notes: Array.from({ length: Math.min(25, count - start) }, (_, i) => ({
          id: `device/note-${start + i + 1}`,
          scope: "general",
          tags: ["on:memory"],
          links: [],
          text: {
            kind: "untrusted",
            source: "seed",
            text: typeof text === "string" ? text : text(start + i),
          },
        })),
      }),
    );
}

interface Receipt {
  selected: { id: string }[];
  omitted: { id: string; revision: number; scope: string; reason: string }[];
  omittedCount: number;
  warnings: { code: string; message: string }[];
}

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
    const seed = async (
      h: typeof alpha,
      level: string,
      scope: string,
      text: string,
    ) => {
      const id = `${level === "device" ? "device" : "project/0123456789abcdef"}/note-1`;
      done(
        await h.call("memory.restore", {
          format: "forge.memory.export/2",
          level,
          approval: ownerApproval,
          notes: [
            {
              id,
              scope,
              tags: ["on:memory"],
              links: [],
              text: { kind: "untrusted", source: "seed", text },
            },
          ],
        }),
      );
      return (
        done(await h.call("memory.export", { level })) as {
          notes: { id: string }[];
        }
      ).notes[0]!;
    };
    const general = await seed(alpha, "device", "general", "shared memory");
    const foreign = await seed(
      beta,
      "project",
      "general",
      "foreign project memory",
    );
    done(
      await alpha.call("memory.restore", {
        format: "forge.memory.export/2",
        level: "device",
        approval: ownerApproval,
        notes: [
          {
            id: "device/note-2",
            scope: "beta",
            tags: ["on:memory"],
            links: [],
            text: {
              kind: "untrusted",
              source: "seed",
              text: "foreign scoped memory",
            },
          },
        ],
      }),
    );
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
}, 30_000);

test("integration: first maximum-size add note survives JSON escaping and later asked overflow", async () => {
  const h = await openHarness(["memory"]);
  try {
    // NUL survives whitespace normalization and costs six bytes per character in JSON.
    const text = "\u0000".repeat(8000);
    expect(
      blockSchema("memory", "add.input.json")({ text, level: "device" }),
    ).toEqual([]);
    await restore(h, 33, (index) => (index === 0 ? text : "x".repeat(8000)));
    const ids = Array.from({ length: 33 }, (_, i) => `device/note-${i + 1}`);
    const result = done(await h.call("memory.attach", { ids })) as {
      text: { text: string };
      receipt: Receipt;
    };
    expect(result.receipt.selected[0]?.id).toBe(ids[0]);
    expect(result.text.text).toContain(text);
    expect(
      result.receipt.warnings.some(
        (warning) => warning.code === "ATTACH_OVER_BUDGET",
      ),
    ).toBe(true);
    expect(result.receipt.omittedCount).toBeGreaterThan(0);
    expect(
      result.receipt.omitted.every((note) => note.reason === "response-limit"),
    ).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(196_608);
  } finally {
    await h.close();
  }
}, 30_000);

test("integration: an oversized restored note returns ok with an omission and the full-read command", async () => {
  const h = await openHarness(["memory"]);
  try {
    const text = "x".repeat(262_144);
    await restore(h, 1, text);
    const result = done(
      await h.call("memory.attach", { ids: ["device/note-1"] }),
    ) as { text: { text: string }; receipt: Receipt };
    expect(result.text.text).toBe("");
    expect(result.receipt.selected).toEqual([]);
    expect(result.receipt.omitted).toEqual([
      {
        id: "device/note-1",
        revision: 1,
        scope: "general",
        reason: "response-limit",
      },
    ]);
    expect(result.receipt.omittedCount).toBe(1);
    expect(result.receipt.warnings).toContainEqual({
      code: "ATTACH_RESPONSE_LIMIT",
      message:
        "1 asked note exceeded the response limit; request them again in another call. Read an individually oversized note in full with forge memory show device/note-1.",
    });
    const shown = done(
      await h.call("memory.show", { id: "device/note-1" }),
    ) as { note: { text: { text: string } } };
    expect(shown.note.text.text).toBe(text);
  } finally {
    await h.close();
  }
}, 30_000);

test("integration: attach returns ok with 50 omission details and the true total", async () => {
  const h = await openHarness(["memory"]);
  try {
    await restore(h, 100, "x".repeat(400));
    const result = done(
      await h.call("memory.attach", { labels: ["memory"] }),
    ) as { receipt: Receipt };
    expect(result.receipt.omitted).toHaveLength(50);
    expect(result.receipt.omittedCount).toBe(
      100 - result.receipt.selected.length,
    );
    expect(result.receipt.omitted.map((note) => note.id)).toEqual(
      Array.from(
        { length: 50 },
        (_, i) => `device/note-${result.receipt.selected.length + i + 1}`,
      ),
    );
  } finally {
    await h.close();
  }
}, 30_000);

test("integration: attach returns large asked notes and response-limit omissions through the runtime", async () => {
  const h = await openHarness(["memory"]);
  try {
    await restore(h, 33, "x".repeat(8000));
    const ids = Array.from({ length: 33 }, (_, i) => `device/note-${i + 1}`);
    const result = done(await h.call("memory.attach", { ids })) as {
      text: { text: string };
      receipt: Receipt;
    };
    const count = result.receipt.selected.length;
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(33);
    expect(result.receipt.selected.map((note) => note.id)).toEqual(
      ids.slice(0, count),
    );
    expect(result.receipt.omitted).toMatchObject(
      ids.slice(count).map((id) => ({ id, reason: "response-limit" })),
    );
    expect(result.receipt.omittedCount).toBe(33 - count);
    expect(result.receipt.warnings).toContainEqual({
      code: "ATTACH_RESPONSE_LIMIT",
      message: `${33 - count} asked notes exceeded the response limit; request them again in another call.`,
    });
    expect(result.text.text).toContain("x".repeat(8000));
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1_048_576);
    const next = done(
      await h.call("memory.attach", { ids: ids.slice(count) }),
    ) as { receipt: Receipt };
    expect(next.receipt.selected[0]?.id).toBe(ids[count]);
  } finally {
    await h.close();
  }
}, 30_000);
