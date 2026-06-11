const { describe, it, expect } = require("bun:test");
const fs = require("node:fs");
const path = require("node:path");
const { validatePluginSchema } = require("../lib/plugin-manager");

const ROOT = path.join(__dirname, "..");
const AGENTS_DIR = path.join(ROOT, "lib", "agents");

describe("plugin-manager supported agent catalog", () => {
  const catalogFiles = fs
    .readdirSync(AGENTS_DIR)
    .filter((file) => file.endsWith(".plugin.json"))
    .sort();

  it("contains exactly the supported harness catalogs (claude, codex, cursor)", () => {
    expect(catalogFiles).toEqual([
      "claude.plugin.json",
      "codex.plugin.json",
      "cursor.plugin.json",
    ]);
  });

  it("every supported catalog passes plugin schema validation", () => {
    for (const file of catalogFiles) {
      const plugin = JSON.parse(
        fs.readFileSync(path.join(AGENTS_DIR, file), "utf-8")
      );
      const result = validatePluginSchema(plugin);
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
    }
  });

  it("does not retain catalogs for dropped harnesses", () => {
    const dropped = ["cline", "copilot", "kilocode", "opencode", "roo"];
    for (const agent of dropped) {
      expect(catalogFiles).not.toContain(`${agent}.plugin.json`);
    }
  });
});
