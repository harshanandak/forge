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

  it("is synced to the committed .agents/skills agent directory", () => {
    // Hybrid single-source (#342): .codex/skills is gitignored + setup-generated,
    // so the committed agent mirror is .agents/skills (Codex's repo-local discovery
    // path — checked in for teammate-clone discovery, kept byte-identical to skills/
    // by scripts/sync-agent-skills.js + the drift gate).
    const agentsPath = join(ROOT, ".agents", "skills", "validate", "SKILL.md");
    if (!existsSync(agentsPath)) {
      throw new Error(
        ".agents/skills/validate/SKILL.md does not exist — run `forge setup` (or node scripts/sync-agent-skills.js)"
      );
    }
    const agentsContent = readFileSync(agentsPath, "utf-8");
    expect(agentsContent).toContain("forge-preflight");
  });
});
