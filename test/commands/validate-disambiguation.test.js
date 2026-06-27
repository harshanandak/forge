const { describe, it, expect } = require("bun:test");
const { readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");

const ROOT = join(__dirname, "..", "..");

describe("/validate disambiguation note", () => {
  // Canonical source is now skills/validate/SKILL.md (A0d migration)
  const validatePath = join(ROOT, "skills", "validate", "SKILL.md");
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

  it(".claude/commands/validate.md no longer exists (deleted in A0d)", () => {
    const legacyPath = join(ROOT, ".claude", "commands", "validate.md");
    expect(existsSync(legacyPath)).toBe(false);
  });

  it("is synced to .codex agent directory", () => {
    const codexPath = join(ROOT, ".codex", "skills", "validate", "SKILL.md");
    if (!existsSync(codexPath)) {
      throw new Error(".codex/skills/validate/SKILL.md does not exist — run sync-commands.js");
    }
    const codexContent = readFileSync(codexPath, "utf-8");
    expect(codexContent).toContain("forge-preflight");
  });
});
