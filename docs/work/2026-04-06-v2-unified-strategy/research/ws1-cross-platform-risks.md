# Cross-Platform Risk Analysis: Forge CLI Abstraction Layer

**Date:** April 6, 2026  
**Scope:** Node.js-based Forge CLI (bin/forge.js) running on Windows, macOS, Linux, WSL  
**Status:** Research Complete

---

## Executive Summary

Forge CLI exhibits **HIGH cross-platform risk** despite mitigations:
- Mature shell execution (execFileSync over exec, secure path resolution)
- Platform detection in place (process.platform checks)
- Critical gaps in WSL integration, gh CLI auth, and SQLite cross-platform access
- Known Beads workaround documented (npm EPERM → PowerShell fallback)

5 risk categories require pre-v2 fixes.

---

## A. Path Handling Risks

### A1: Backslash Path Traversal (MEDIUM/MEDIUM)
**Location:** bin/forge.js validatePathInput()  
Uses path.resolve() which handles backslashes correctly.

### A2: Git Worktree WSL/Windows Boundary (HIGH/MEDIUM) CRITICAL
**Finding:** No handling for WSL path translation.  
**Risk:** File locking semantics differ (fcntl vs LockFileEx).  
**Action:** Detect WSL; translate paths; separate state per shell.

### A3: UNC Paths (LOW/LOW)
Network drives not validated.

### A4: Long Paths >260 chars (MEDIUM/LOW)
Windows MAX_PATH limit hit by npm postinstall.

---

## B. Shell Execution Risks

### B1: Shell Quoting (MEDIUM/MEDIUM)
Location: lib/commands/push.js spawnFn() with shell: isWindows flag  
Different quoting rules on Windows (cmd.exe) vs Unix shells.

### B2: Environment Variables (MEDIUM/LOW)
No handling for bash $VAR vs cmd %VAR% vs PowerShell $env:VAR.

### B3: Git Bash/WSL/CMD Mixing (HIGH/MEDIUM) CRITICAL
**Finding:** Windows has 3 shells with different tool paths.  
**Code Location:** bin/forge.js line 185 uses where.exe or which  
**Risk:** User installs in Git Bash, runs in PowerShell, silent failures.  
**Action:** Detect active shell; resolve commands per shell.

---

## C. gh CLI Integration Risks

### C1: gh Auth Status Format Drift (MEDIUM/HIGH)
Code relies on exit codes only. gh v2.41+ changed format.

### C2: gh Installation Divergence (HIGH/MEDIUM) CRITICAL
**Finding:** Multiple Windows install paths (Scoop, Winget, Chocolatey, Git Bash, WSL).  
**Code:** secureExecFileSync() takes first match from where.  
**Risk:** Wrong version picked.  
**Action:** Validate gh version; prefer latest.

### C3: WSL/Windows gh Auth Incompatibility (HIGH/HIGH) CRITICAL
**Finding:** Auth tokens stored separately per shell:
- Windows: ~\AppData\Local\GitHub CLI\hosts.yml
- WSL: /home/user/.config/gh/hosts.yml

**Risk:** User authenticates Windows gh, WSL gh not authenticated.  
**Action:** Detect shell; use appropriate credential store.

---

## D. Git Differences Across Platforms

### D1: Git autocrlf Line Ending Corruption (MEDIUM/MEDIUM)
Forge writes \n, git with core.autocrlf=true converts to \r\n.

### D2: Git Credential Helper Missing (LOW/LOW)
Different per OS; may not be installed.

### D3: Git Worktree Symlink vs Junction (MEDIUM/LOW)
Windows junctions vs Unix symlinks behave differently.

---

## E. SQLite (better-sqlite3) Risks

### E1: Native Binary Incompatibility (MEDIUM/MEDIUM) CRITICAL
**Finding:** better-sqlite3 is native C++.  
**Risk:** Windows npm install creates Windows binary. wsl forge status fails.  
**Action:** Replace with JSON state file (no native compilation).

### E2: SQLite File Locking (HIGH/MEDIUM) CRITICAL
**Finding:** Lock semantics differ:
- Windows: LockFileEx (exclusive)
- Unix: fcntl (advisory)
- WSL: Unix on Windows filesystem

**Risk:** Windows locks state.db; WSL ignores lock → database corruption.  
**Action:** Implement retry-with-backoff; cache state in-process.

### E3: Defender Blocks I/O (MEDIUM/MEDIUM)
Defender scans .db-wal and .db-shm files → temp EACCES errors.

---

## F. CI/CD Environment Risks

### F1: GitHub Actions Runner Inconsistency (MEDIUM/MEDIUM)
Different tools per runner type (ubuntu vs windows vs macos).

### F2: Minimal Docker (LOW/LOW)
Alpine/Busybox lack full tooling.

### F3: Codex Unknown Environment (MEDIUM/MEDIUM)
Codex execution environment opaque.

---

## G. WSL-Specific Integration Risks

### G1: Mixed WSL/Windows Development (HIGH/MEDIUM) CRITICAL
**Finding:** Developer workflow mixes shells:
1. Clone in Windows: C:\project
2. forge setup in Windows PowerShell
3. forge push in WSL shell

**Problem:**
- Paths differ: C:\project vs /mnt/c/project
- State file .git/forge/state.db location matters
- SQLite binary incompatibility (E1)
- gh auth separate per shell (C3)

**Code:** No WSL detection in forge.  
**Action:** Detect WSL; normalize paths; separate state per shell.

### G2: WSL Credential Mismatch (MEDIUM/MEDIUM)
WSL git and Windows git have separate credential stores.

---

## Critical Blockers for v2

1. **C3 + G1 + E1:** WSL/Windows state and auth incompatibility
   - Primary Fix: Replace better-sqlite3 with JSON state file
   - Secondary: Detect WSL; use per-shell credential stores

2. **E2:** SQLite file locking
   - Fix: Implement lock retry (exponential backoff)

3. **B3:** Shell detection
   - Fix: Detect active shell; resolve commands per shell

---

## Files Analyzed

- bin/forge.js — Entry point, secureExecFileSync, path validation
- lib/commands/push.js — Shell execution
- lib/commands/dev.js — bun test spawning
- lib/commands/ship.js — gh pr create
- lib/detect-agent.js — Platform detection
- package.json — better-sqlite3 dependency

---

## Conclusion

Forge CLI has solid security practices (execFileSync, arg arrays, no injection). However, integration across Windows/WSL/Git Bash is untested, and cross-platform state management is broken.

**Risk Level for v2 Release: HIGH** without fixes to critical blockers.
