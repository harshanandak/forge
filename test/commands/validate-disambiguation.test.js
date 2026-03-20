import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..", "..");

describe("/validate disambiguation note", () => {
  const validatePath = join(ROOT, ".claude", "commands", "validate.md");
  const content = readFileSync(validatePath, "utf-8");

  it('contains "Three" disambiguation intro', () => {
    expect(content.toLowerCase()).toContain("three");
  });

  it('mentions "forge-preflight"', () => {
    expect(content).toContain("forge-preflight");
  });

  it('mentions "bun run check"', () => {
    expect(content).toContain("bun run check");
  });

  it("is synced to .cursor agent directory", () => {
    const cursorPath = join(ROOT, ".cursor", "commands", "validate.md");
    if (!existsSync(cursorPath)) {
      throw new Error(".cursor/commands/validate.md does not exist — run sync-commands.js");
    }
    const cursorContent = readFileSync(cursorPath, "utf-8");
    expect(cursorContent).toContain("forge-preflight");
  });

  it("is synced to .roo agent directory", () => {
    const rooPath = join(ROOT, ".roo", "commands", "validate.md");
    if (!existsSync(rooPath)) {
      throw new Error(".roo/commands/validate.md does not exist — run sync-commands.js");
    }
    const rooContent = readFileSync(rooPath, "utf-8");
    expect(rooContent).toContain("forge-preflight");
  });
});
