import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../..");

describe("github-beads-sync config files", () => {
  // ── Config file ──────────────────────────────────────────────

  const configPath = resolve(ROOT, "scripts/github-beads-sync.config.json");

  it("scripts/github-beads-sync.config.json is valid JSON", () => {
    const raw = readFileSync(configPath, "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  const config = JSON.parse(readFileSync(configPath, "utf-8"));

  it("has all required top-level keys", () => {
    const requiredKeys = [
      "labelToType",
      "labelToPriority",
      "defaultType",
      "defaultPriority",
      "mapAssignee",
      "publicRepoGate",
      "gateLabelName",
      "gateAssociations",
    ];
    for (const key of requiredKeys) {
      expect(config).toHaveProperty(key);
    }
  });

  it("labelToType maps common GitHub labels", () => {
    expect(config.labelToType.bug).toBe("bug");
    expect(config.labelToType.enhancement).toBe("feature");
  });

  it("labelToPriority maps P0-P4", () => {
    expect(config.labelToPriority.P0).toBe(0);
    expect(config.labelToPriority.P1).toBe(1);
    expect(config.labelToPriority.P2).toBe(2);
    expect(config.labelToPriority.P3).toBe(3);
    expect(config.labelToPriority.P4).toBe(4);
  });

  it('defaultType is "task" and defaultPriority is 2', () => {
    expect(config.defaultType).toBe("task");
    expect(config.defaultPriority).toBe(2);
  });

  it('publicRepoGate defaults to "none"', () => {
    expect(config.publicRepoGate).toBe("none");
  });

  // ── Mapping file ─────────────────────────────────────────────

  const mappingPath = resolve(ROOT, ".github/beads-mapping.json");

  it(".github/beads-mapping.json is valid JSON with string values", () => {
    const raw = readFileSync(mappingPath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(typeof parsed).toBe("object");
    expect(parsed).not.toBeNull();
    // All values should be strings (beads issue IDs)
    for (const val of Object.values(parsed)) {
      expect(typeof val).toBe("string");
    }
  });
});
