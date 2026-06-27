const { describe, it, expect } = require("bun:test");
const { readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");

const ROOT = join(__dirname, "../..");

describe("/status command - smart-status integration", () => {
  const statusPath = join(ROOT, "skills/status/SKILL.md");
  const content = readFileSync(statusPath, "utf-8");

  it("references smart-status.sh as the primary status command", () => {
    expect(content).toContain("bash scripts/smart-status.sh");
  });

  it("does NOT use 'bd list --status in_progress' as the primary step", () => {
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

  it("codex skill copy also references smart-status.sh", () => {
    // .cursor/commands/ was removed in A0d; check codex skill (generated from canonical)
    const codexPath = join(ROOT, ".codex", "skills/status/SKILL.md");
    expect(existsSync(codexPath)).toBe(true);
    const codexContent = readFileSync(codexPath, "utf-8");
    expect(codexContent).toContain("bash scripts/smart-status.sh");
  });

  it("does not instruct users to pass --workflow-state or --issue-id for status discovery", () => {
    expect(content).not.toContain("--workflow-state");
    expect(content).not.toContain("--issue-id");
  });
});
