# OWASP Top 10 Security Analysis -- 4 Planned Changes

**Date:** 2026-03-20
**Scope:** forge-cpnj, forge-iv1p, forge-8u6q, forge-zs2u
**Analyst:** Security audit (research only)

---

## Change 1: forge-cpnj -- Setup Code Path Unification

**Description:** Extracting shared helper for CLI setup; both interactive and flag-based setup call the same function that seeds `.claude/commands/*.md` and agent directories.

### OWASP Categories

| Category | Applies | Detail |
|----------|---------|--------|
| A01 Broken Access Control | YES | Path traversal if user-supplied `--path` flag flows into file creation without validation |
| A03 Injection | LOW | No shell exec in this path; file content is hardcoded templates |
| A04 Insecure Design | YES | Shared helper must not weaken validation that existed in either code path |
| A08 Software/Data Integrity | YES | Seeded `.md` files become agent instructions -- tampering risk if written to attacker-controlled path |

### Existing Mitigations (Verified in Source)

1. **`writeFile()` (line 520):** Resolves path against `projectRoot`, checks `fullPath.startsWith(resolvedProjectRoot)` -- blocks traversal.
2. **`ensureDir()` (line 505):** Same `startsWith` guard before `mkdirSync`.
3. **`validatePathInput()` (line 178):** `path.resolve` + `startsWith` check for `--path` flag.
4. **`validateCommonSecurity()` (line 130+):** Blocks shell metacharacters, URL-encoded traversal (`%2e`, `%2f`, `%5c`), non-ASCII, null bytes.
5. **File permissions:** `writeFileSync` uses `{ mode: 0o644 }` -- no world-writable files.

### Attack Vectors

1. **Symlink attack:** If `projectRoot` contains a symlink pointing outside the project, `path.resolve` follows it. The `startsWith` check passes because the resolved path still looks correct. **Mitigation needed:** Use `fs.realpathSync()` on both `projectRoot` and the resolved path before comparison.
2. **TOCTOU on ensureDir:** Between `existsSync` check and `mkdirSync`, a race could replace a directory with a symlink. Risk is LOW in CLI context (single-user, synchronous).
3. **`--path` flag with `..` segments:** Currently validated by `validateDirectoryPathInput` (line 187+) which blocks system dirs but does NOT enforce project-root containment for `directory_path` type -- it only blocks `/etc`, `/bin`, etc. The `--path` flag sets `projectRoot` itself, so the `startsWith` check in `writeFile` becomes self-referential. This is by design (user chooses target), but means forge can write to ANY user-writable directory.

### Risk: LOW

The helper unification is a refactor. As long as the new shared function calls the existing `writeFile`/`ensureDir` (which have traversal guards), risk is contained. The symlink edge case pre-exists.

### Recommendations

- Ensure the unified helper does not bypass `writeFile()`/`ensureDir()` by using raw `fs.writeFileSync()` directly.
- Add `fs.realpathSync()` to resolve symlinks in `projectRoot` at initialization (line 58).
- Add a test: pass `--path ../../tmp` and verify files land in the resolved absolute path, not outside it.

---

## Change 2: forge-iv1p -- Postinstall Rewrite

**Description:** Changing postinstall from writing multiple files to: check CI env vars, check AGENTS.md existence, create only AGENTS.md if fresh, print guidance.

### OWASP Categories

| Category | Applies | Detail |
|----------|---------|--------|
| A05 Security Misconfiguration | YES | Postinstall runs during `npm install` with ambient permissions; reducing scope reduces attack surface |
| A08 Software/Data Integrity | YES | npm lifecycle scripts are a supply chain vector; minimizing postinstall is a security improvement |
| A04 Insecure Design | LOW | CI detection via env vars is standard practice |

### Existing Mitigations (Verified in Source)

1. **`projectRoot` source (line 58):** Uses `process.env.INIT_CWD || process.cwd()` -- standard npm behavior, not user-injectable beyond npm's own controls.
2. **`minimalInstall()` (line ~1858):** Already checks `hasPackageJson` before acting; new version further reduces writes.
3. **`writeFile()` guards:** All file creation goes through the traversal-checked helper.

### Attack Vectors

1. **CI env var spoofing:** If the postinstall checks `CI=true` to skip setup, an attacker who controls env vars (e.g., in a compromised CI runner) could force the postinstall to either run or skip. Risk is LOW because skipping is the safer path.
2. **INIT_CWD manipulation:** If `INIT_CWD` is set to a path outside the project, `projectRoot` resolves there. This is an npm-level concern, not specific to this change. Forge should validate `INIT_CWD` points to a directory containing `package.json`.
3. **Reduced file writes = reduced attack surface:** This change is net-positive for security. Fewer files written during postinstall means fewer opportunities for symlink attacks or race conditions.

### Risk: LOW

This change reduces the postinstall footprint, which is a security improvement. The main concern is ensuring CI env var checks use a deny-by-default approach (skip postinstall in CI, not "run extra steps in CI").

### Recommendations

- Check multiple CI indicators: `CI`, `GITHUB_ACTIONS`, `GITLAB_CI`, `JENKINS_URL` -- standard practice.
- Validate that `INIT_CWD` contains a `package.json` before using it as `projectRoot`.
- Log when postinstall is skipped in CI for audit trail.

---

## Change 3: forge-8u6q -- Dead Config Removal

**Description:** Removing `_CODE_REVIEW_TOOLS` and `_CODE_QUALITY_TOOLS` objects from bin/forge.js (lines 275-310).

### OWASP Categories

| Category | Applies | Detail |
|----------|---------|--------|
| A06 Vulnerable/Outdated Components | POSITIVE | Removing dead code reduces maintenance burden and potential confusion |

### Attack Vectors

None. This is pure deletion of unused constants prefixed with `_`. They contain no secrets (just public URLs and tool descriptions). They are not referenced anywhere in runtime code.

### Risk: NEGLIGIBLE

No security concerns. Dead code removal is a best practice.

### Recommendations

- Verify with `grep -r '_CODE_REVIEW_TOOLS\|_CODE_QUALITY_TOOLS'` that no other file references these.
- No further action needed.

---

## Change 4: forge-zs2u -- Lint Script Fix

**Description:** Changing `scripts/lint.js` from `npx --yes eslint .` to using local `node_modules/.bin/eslint` with Windows detection.

### OWASP Categories

| Category | Applies | Detail |
|----------|---------|--------|
| A08 Software/Data Integrity | YES | `npx --yes` auto-installs packages -- supply chain risk; using local binary is more secure |
| A03 Injection | MEDIUM | `shell: isWindows` in spawnSync enables shell interpretation on Windows |
| A05 Security Misconfiguration | LOW | Binary resolution path matters for security |

### Current Code (Verified)

```javascript
const result = spawnSync(
  'npx',
  ['--yes', 'eslint', '.', '--max-warnings', '0'],
  { stdio: 'inherit', shell: isWindows }
);
```

### Attack Vectors

1. **`npx --yes` supply chain risk (CURRENT):** The `--yes` flag auto-confirms installation of packages. If `eslint` is not locally installed and a typosquatted or malicious package is resolved, it executes automatically. This is the PRIMARY security concern in the current code.

2. **`shell: true` on Windows (CURRENT):** When `shell: isWindows` is true, the command string is interpreted by `cmd.exe`. Since the arguments are hardcoded literals (`'eslint'`, `'.'`), this is safe TODAY, but fragile -- any future change adding dynamic arguments would be injectable.

3. **Local binary resolution (PROPOSED):** Using `node_modules/.bin/eslint` directly:
   - POSITIVE: Eliminates `npx --yes` supply chain vector entirely.
   - POSITIVE: Guarantees the exact version from `package-lock.json` runs.
   - RISK: If `node_modules/.bin/` is writable by an attacker, they could replace the binary. This risk exists with `npx` too, so net-neutral.

4. **Windows `.cmd` shim resolution:** On Windows, `node_modules/.bin/eslint` is actually `eslint.cmd`. The proposed change needs to handle this -- using `spawnSync` with `shell: true` on Windows, or explicitly targeting `eslint.cmd`.

### Risk: MEDIUM (current code) -> LOW (after fix)

The proposed change is a security improvement. Removing `npx --yes` eliminates an auto-install supply chain vector.

### Recommendations

- Use `execFileSync` or `spawnSync` WITHOUT `shell: true` where possible. On Windows, target `node_modules/.bin/eslint.cmd` explicitly.
- If `shell: true` is needed on Windows, ensure ALL arguments are hardcoded string literals (no variables).
- Verify the local eslint binary exists before executing; fail with clear error if missing rather than falling back to `npx`.
- Do NOT fall back to `npx --yes` if local binary is missing -- fail loudly instead.

---

## Cross-Cutting Analysis

### Supply Chain Risk: Removing `npx --yes`

**Question:** Are there supply chain risks from removing the `npx --yes` pattern?

**Answer:** Removing `npx --yes` is a security IMPROVEMENT, not a risk. The `--yes` flag in npx:
- Auto-installs packages without user confirmation
- Could install typosquatted packages if the local install is missing
- Bypasses the user's chance to verify what is being installed
- Executes arbitrary code from the npm registry

Using local `node_modules/.bin/eslint` instead:
- Runs only what was explicitly installed via `npm install` / `bun install`
- Is pinned by lockfile (package-lock.json / bun.lockb)
- Cannot auto-install unexpected packages
- Is the recommended pattern per npm security guidelines

**Verdict:** Net positive. No supply chain risk from this removal.

### Path Traversal in File Creation Helpers

**Question:** Are there path traversal risks in the file creation helpers?

**Answer:** The existing guards are solid but have one edge case:

**Strengths (verified in source):**
- `writeFile()` (line 520-539): `path.resolve()` + `startsWith(resolvedProjectRoot)` check
- `ensureDir()` (line 505-517): Same traversal guard
- `validateCommonSecurity()`: Blocks `%2e`/`%2f`/`%5c` URL encoding, shell metacharacters, non-ASCII
- `validatePartialRollbackPaths()` (line 3851): Additional per-file validation for rollback

**Weakness:**
- **Symlink bypass:** `path.resolve()` does NOT resolve symlinks. If `projectRoot` is `/home/user/project` and `/home/user/project/data` is a symlink to `/etc`, then `path.resolve('/home/user/project', 'data/passwd')` returns `/home/user/project/data/passwd` which passes the `startsWith` check but actually writes to `/etc/passwd`. Fix: use `fs.realpathSync()` on both paths.
- **`projectRoot` from `INIT_CWD`:** The root itself comes from an environment variable (line 58). If manipulated, all `startsWith` checks become self-referential.

**Verdict:** Low practical risk in CLI context (requires local attacker who already has file creation access), but the symlink edge case should be documented and optionally hardened.

---

## Summary Table

| Change | ID | Risk | Key OWASP | Action Required |
|--------|----|------|-----------|-----------------|
| Setup unification | forge-cpnj | LOW | A01, A04 | Ensure shared helper uses `writeFile()`/`ensureDir()`, not raw `fs` |
| Postinstall rewrite | forge-iv1p | LOW | A05, A08 | Validate `INIT_CWD`, deny-by-default in CI |
| Dead config removal | forge-8u6q | NEGLIGIBLE | A06 | Grep for references before deleting |
| Lint script fix | forge-zs2u | LOW (improved from MEDIUM) | A03, A08 | Remove `npx --yes`, use local binary, no shell fallback |
