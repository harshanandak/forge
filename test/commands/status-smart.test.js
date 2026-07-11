const { describe, it, expect } = require("bun:test");
const { readFileSync } = require("node:fs");
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

  it("codex installs from the canonical skill, which references smart-status.sh", () => {
    // #342 single-source: skills/ is the ONLY committed skill source. The
    // per-agent `.codex/skills` mirror is not committed (it is gitignored, and
    // Codex stage skills install globally into $CODEX_HOME/skills at `forge
    // setup`). Codex is installed from the canonical skills/status/SKILL.md
    // verbatim, so that is where smart-status.sh must live — asserting on an
    // ephemeral generated mirror would be environment-dependent and flaky.
    expect(content).toContain("bash scripts/smart-status.sh");
  });

  it("does not instruct users to pass --workflow-state or --issue-id for status discovery", () => {
    expect(content).not.toContain("--workflow-state");
    expect(content).not.toContain("--issue-id");
  });
});
