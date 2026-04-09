# PreToolUse Hook Enforcement: Risk Analysis

**Date**: 2026-04-06  
**Context**: Forge is planning PreToolUse hooks to block raw `bd`/`gh`/`git` commands and enforce forge CLI equivalents across 6 AI agents.

---

## Executive Summary

PreToolUse hooks can **block** commands for Claude Code (Bash tool) but face critical gaps:

1. **Coverage**: Only Claude Code (Bash) supports blocking PreToolUse hooks. Codex, Kilo Code, OpenCode, Cursor, and Copilot rely on advisory/warning hooks that agents can ignore.
2. **False Positives**: Forge commands themselves call `git`/`gh`/`bd` internally — distinguishing agent calls from forge calls requires context inspection (PIDs, parent processes, or environment markers).
3. **Bypass Vectors**: Agents can call scripts, use Node.js `child_process`, or invoke other languages (Python, Ruby) to sidestep hooks.
4. **Performance**: Each PreToolUse hook adds latency per tool invocation; cumulative slowdown with multiple hooks.
5. **UX**: Hook blocks are cryptic without helpful guidance; agents need clear "use forge X instead" messages and graceful fallbacks.

---

## A. Hook Coverage Gaps

### Claude Code (Bash Tool)
- **Support**: PreToolUse/PostToolUse hooks + exit code signaling ✓
- **Capability**: Can BLOCK commands (exit code 2 blocks, 0 allows)
- **Current Implementation**: `.claude/settings.json` has PreToolUse hook with regex blocks for `git reset --hard`, `rm -f`, `--no-verify`, etc.
- **Example Block**:
  ```json
  {
    "matcher": "Bash",
    "hooks": [{
      "type": "command",
      "command": "node -e \"... regex check ... process.exit(2)\" // blocks"
    }]
  }
  ```

### Codex
- **Support**: Hooks system (likely advisory only)
- **Capability**: Skill-based execution; can warn but cannot guarantee block
- **Risk**: Codex follows skill instructions but may bypass hooks if instructed to "ignore warnings" or "retry"
- **Coverage**: `.codex/skills/` exist but no visible PreToolUse-equivalent enforcement

### Kilo Code
- **Support**: Rules-based system (unclear PreToolUse parity)
- **Capability**: Limited hook support; rules are context-aware but not process-intercepting
- **Risk**: No direct hook blocking observed in codebase

### OpenCode
- **Support**: Plugin event hooks (not confirmed to include PreToolUse)
- **Capability**: Unknown level of command interception
- **Risk**: May only log/warn, not block

### Cursor (Verified Cursor 2.4+)
- **Support**: Pre/Post/Stop hooks (similar to Claude Code)
- **Capability**: Can block if configured
- **Risk**: Hook config not found in this codebase; enforcement likely missing

### Copilot
- **Support**: `.github/hooks/` integration
- **Capability**: GitHub Actions workflows (CI-level, not agent-level)
- **Risk**: Only affects push/merge; agents running locally will bypass

### CI/CD Runners
- **Risk**: Agents in GitHub Actions have no local hook support; all enforcement relies on server-side validation (branch protection, CI status checks)

---

## B. False Positives: Hook Collision

### Scenario 1: Forge `pr create` Internally Calls `gh pr create`
```bash
# User requests:
agent: "forge pr create --title 'Fix bug'"

# Forge CLI does:
$ gh pr create --title "Fix bug" --base main

# Hook sees:
"gh pr create" -> BLOCKED

# Result:
False positive — user did not call raw gh, forge did
```

### Scenario 2: Forge `push` Internally Calls `git push`
```bash
# Forge push internally:
$ git push origin feature-branch
$ git push origin main

# Hook sees:
"git push" -> may trigger "Direct push to main blocked"

# Result:
Forge's own internal logic blocked
```

### Scenario 3: Agent Script Indirectly Calls Blocked Command
```bash
# Agent writes a helper script:
$ cat > /tmp/my-helper.sh << 'SCRIPT'
#!/bin/bash
git reset --hard HEAD~1  # Intended for internal cleanup
SCRIPT
$ bash /tmp/my-helper.sh

# Hook sees:
"git reset --hard" -> BLOCKED

# Result:
Hook blocks agent's own script invocation, not direct agent command
```

### Solution Attempts (All Problematic)
1. **Check Parent Process**: `ppid` inspection to detect forge CLI — but forge may spawn subshells, making PPIDs unreliable
2. **Environment Marker**: Set `FORGE_INTERNAL=true` in forge scripts — agent can spoof it
3. **Allowlist Forge Paths**: Allow `/path/to/forge/scripts/*.js` — agent can copy forge scripts
4. **Allowlist Known Processes**: Allow only when parent is `node forge-team` — agent can wrap commands

**Conclusion**: Reliably distinguishing forge calls from agent calls is **not feasible** without breaking legitimate forge operations.

---

## C. Performance Impact

### Hook Latency per Command
- Each PreToolUse hook spawns a Node.js process to evaluate regex
- Typical overhead: **50-200ms per hook** (process startup + regex matching)
- With 5+ hooks, cumulative: **250ms-1s latency per Bash invocation**

### Example Timing
```
forge pr create --title "Fix"
├─ forge CLI invokes gh pr create (internal)
│  ├─ PreToolUse hook runs (100ms)
│  └─ gh executes (500ms)
├─ forge CLI invokes git push (internal)
│  ├─ PreToolUse hook runs (100ms)
│  └─ git executes (300ms)
└─ Total: 1s additional latency
```

### Perceived Slowdown
- Agent submits command → hook evaluates → agent sees delay
- If agent is waiting on hook feedback in a loop (retries), delays compound
- **Risk**: Agent timeouts if hook is slow (e.g., network-based checks)

### Optimization Needed
- Cache hook results per command signature
- Use compiled binary (not Node.js) for fast path
- Batch hook checks (evaluate once per multi-command script)

---

## D. Hook Implementation Patterns

### Current Pattern: Embedded Node.js in settings.json
```json
"hooks": {
  "PreToolUse": [{
    "type": "command",
    "command": "node -e \"...inline regex check...\""
  }]
}
```

**Pros**:
- Self-contained, no external script files
- Cross-platform (node is available)

**Cons**:
- Hard to maintain (inline code is not readable)
- Difficult to debug
- No shared library across agents

### Needed Pattern: Shared Hook Scripts
```
.forge/hooks/
├── block-dangerous-git.sh      (shared for all agents)
├── block-bd-direct.sh
├── block-gh-pr-merge.sh
└── agent-awareness.sh          (detect forge vs. agent)
```

**Challenges**:
- **Format Mismatch**: Claude Code expects Node.js inline; Codex expects skill format; Cursor expects YAML
- **No Universal Format**: Each agent has different hook syntax
- **Maintenance**: Duplicate logic across 6 hook definitions

### Possible Solution: Generate Hook Config
```bash
# One source of truth:
generate-hook-config.js
├─ reads .forge/hook-rules.json
├─ generates .claude/settings.json (Claude Code)
├─ generates .codex/hooks.yaml (Codex)
├─ generates cursor.json (Cursor)
└─ generates .github/workflows/hook.yml (Copilot)
```

**Risk**: Complexity increases 6x; any mistake affects all agents.

---

## E. Bypass Vectors

### Vector 1: Indirect Script Invocation
```javascript
// Agent writes a wrapper script
const { execSync } = require('child_process');
execSync('bash /tmp/agent-script.sh', { stdio: 'inherit' });

// /tmp/agent-script.sh contains:
git reset --hard HEAD~1  // Hook doesn't see this
```

**Prevention**: Monitor `/tmp` and `$TMPDIR` for scripts containing blocked commands (intrusive, false positives)

### Vector 2: Language-Level Execution
```python
# Agent uses Python (or Ruby, etc.) instead
import subprocess
subprocess.run(['git', 'reset', '--hard', 'HEAD~1'])
```

**Prevention**: Extend hooks to intercept all tool invocations (not just Bash) — unrealistic

### Vector 3: Node.js Direct API
```javascript
// Assume bd/gh have Node.js APIs available
const beads = require('@forge/beads');
beads.create({ ... });  // Bypasses hook
```

**Prevention**: Wrapper function in Node.js SDK that enforces forge CLI — but requires all agents to use SDK (not CLI)

### Vector 4: Ignore Hook Warning and Retry
```
Hook: "BLOCKED: Use 'forge pr create' instead"
Agent: "I'll try again with a different approach"
       → Uses gh pr create --dry-run (bypass logic)
       → Manually parses output
```

**Prevention**: Make hook blocks **non-recoverable** (very strict) — but then legitimate forge calls get blocked too

---

## F. Graceful Degradation

### Current Hook Message Design
```
BLOCKED: <generic message>
```

**Problems**:
1. No suggestion for alternative command
2. No fallback mechanism (agent is stuck)
3. No context (why was it blocked? who can unblock?)

### Better Pattern
```
BLOCKED: Direct 'git push' to main not allowed.

ACTION: Use 'forge push' instead, which validates and auto-syncs to Beads.

DETAILS: This prevents accidental force pushes and keeps Beads<>GitHub in sync.

FALLBACK: If this is a critical hotfix, ask the team lead to bypass via FORGE_OVERRIDE=true
```

### Fallback Mechanism
```bash
# Hook checks for override token:
if [[ "$FORGE_OVERRIDE" == "secret-token-from-lead" ]]; then
  echo "WARNING: Override used — logging for audit"
  exit 0  # Allow
fi

# Team lead can issue temporary token:
$ forge admin issue-override-token --recipient alice --until "2026-04-07" --reason "Critical hotfix"
```

### Warning Phase (Week 1)
```bash
# Instead of exit(2), use exit(0) + warning:
if (blockedCmd) {
  console.warn('WARNING: Consider using forge instead of raw git/gh/bd');
  process.exit(0);  // Allow, but warn
}
```

After 1 week of warnings, promote to blocks.

---

## G. Hook Integration with Beads/GitHub Sync

### Risk: Hook Desync
If hook blocks `git push`, but `forge push` internally calls `git push`, forge's own push may be blocked mid-execution, leaving Beads and GitHub out of sync.

**Example**:
```
Agent: "Use forge push"
Hook: Pre-push check runs
  ├─ Calls execGit(...) to check branch
  └─ Calls execGit(...) to push
  └─ PreToolUse hook fires again (recursive!)
     └─ Blocks second git call
  └─ Push incomplete, sync broken
```

### Solution: Whitelist Internal Forge Processes
```javascript
// In hook script:
if (process.env.FORGE_INTERNAL_CALL === 'true') {
  process.exit(0);  // Allow internal forge calls
}
```

**Risk**: Agent can set `FORGE_INTERNAL_CALL=true` to bypass

### Better Solution: Fork/Exec Isolation
```javascript
// Forge scripts use execFileSync with clean environment:
const cleanEnv = { ...process.env };
delete cleanEnv.FORGE_INTERNAL_CALL;  // Remove any spoofing

execFileSync('git', ['push', ...], { env: cleanEnv });
```

This prevents agents from spoofing the marker.

---

## H. Recommended Risk Mitigations

### Phase 1: Claude Code Only (Immediate)
- Keep existing Bash hook in `.claude/settings.json`
- Add clear "use forge instead" messages
- Document which commands are blocked and why
- **No changes to other 5 agents yet**

### Phase 2: Codex/Cursor (If Both Support Pre-blocking Hooks)
- Generate equivalent hook config for Codex/Cursor
- Test false positives thoroughly (esp. forge's own calls)
- Monitor hook latency and optimize if >100ms per command

### Phase 3: OpenCode/Kilo Code/Copilot (Long-term)
- If no blocking hook support, use **advisory-only** hooks (warn, don't block)
- Implement server-side validation (GitHub branch protection + status checks)
- Train agents to use forge CLI via skill instructions, not hook enforcement

### Phase 4: Testing & Rollback
- Test with each of 6 agents independently
- Monitor for "stuck agents" (blocked but no recovery path)
- Provide emergency override mechanism (FORGE_OVERRIDE token)
- Plan rollback: can disable hooks in <5 minutes if needed

---

## I. Critical Unknowns

**Before Implementation, Resolve**:

1. **Codex Hook Support**: Does Codex support PreToolUse-style blocking? Or only advisory?
2. **Kilo Code Hooks**: What hook format does Kilo Code use? Can it block?
3. **OpenCode Plugin Events**: Do OpenCode plugin hooks intercept tool invocations or only app events?
4. **Cursor Hook Parity**: Is Cursor 2.4+ in use across the team? Does it support identical hook syntax to Claude Code?
5. **CI Agents**: How are agents run in GitHub Actions? Do they have hook support or only CI checks?

**Recommendation**: Audit each agent's hook capabilities before expanding beyond Claude Code.

---

## J. Risk Summary Table

| Risk | Severity | Likelihood | Mitigation |
|------|----------|------------|-----------|
| **A. Coverage Gaps** | High | High | Start with Claude Code only; audit other agents |
| **B. False Positives** | Critical | High | Use environment markers + allowlist forge processes |
| **C. Performance** | Medium | Medium | Optimize with compiled binary; cache results |
| **D. Hook Fragmentation** | Medium | High | Create config generator for all 6 agents |
| **E. Bypass Vectors** | Medium | High | Accept some bypasses; focus on advisor warnings |
| **F. Graceful Degradation** | High | High | Add helpful messages + override mechanism |
| **G. Beads/GitHub Desync** | Critical | Medium | Isolate forge internal calls from hook checks |
| **H. Agent Timeouts** | Medium | Low | Monitor hook latency; add timeout failsafe |

---

## Conclusions

**DO**:
- Implement PreToolUse hooks for Claude Code Bash tool (already exists)
- Add clear, actionable error messages with forge alternatives
- Whitelist forge internal processes via environment or exec isolation
- Phase rollout: Claude Code → Codex/Cursor → others

**DO NOT**:
- Deploy identical hooks across all 6 agents without testing each
- Assume PreToolUse hook support exists for Codex/Kilo Code/OpenCode/Copilot without audit
- Create false positives by blocking forge's own internal calls
- Underestimate bypass vectors (agents are creative)

**DEFER**:
- Extending hooks to intercept non-Bash tool calls (Python, Ruby, Node.js APIs)
- Enforcing hook blocks on agents without clear recovery path
- Adding network-based hook checks (introduces latency and failure modes)

---

## Files Examined

- `.claude/settings.json` — Claude Code PreToolUse hook configuration
- `lefthook.yml` — Git-level hooks (pre-commit, pre-push, commit-msg)
- `scripts/forge-team/lib/hooks.sh` — Beads<>GitHub sync hook
- `scripts/branch-protection.js` — Branch protection PreToolUse example
- `scripts/lib/eval-runner.js` — Forge internal tool invocations (git, gh, bd)

