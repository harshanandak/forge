const { describe, it, expect } = require("bun:test");
const { readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");

const ROOT = join(__dirname, "../..");

describe("/status command — smart-status integration", () => {
  const statusPath = join(ROOT, ".claude/commands/status.md");
  const content = readFileSync(statusPath, "utf-8");

  it("references smart-status.sh as the primary status command", () => {
    expect(content).toContain("smart-status.sh");
  });

  it("does NOT use 'bd list --status in_progress' as the primary step", () => {
    // The old Step 2 used bd list --status in_progress as the main command.
    // It should no longer appear as a standalone step command.
    const lines = content.split("\n");
    const hasPrimaryBdList = lines.some(
      (line) =>
        line.trim().startsWith("bd list --status in_progress") ||
        line.trim() === "bd list --status in_progress"
    );
    expect(hasPrimaryBdList).toBe(false);
  });

  it("still contains git log for recent commits", () => {
    expect(content).toContain("git log");
  });

  it("agent copies (.cursor, .roo) also reference smart-status.sh", () => {
    const agentDirs = [".cursor", ".roo"];
    for (const dir of agentDirs) {
      const agentPath = join(ROOT, dir, "commands/status.md");
      expect(existsSync(agentPath)).toBe(true);
      const agentContent = readFileSync(agentPath, "utf-8");
      expect(agentContent).toContain("smart-status.sh");
    }
  });
});
