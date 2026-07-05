# Plan Phase 2 — Technical Research (OWASP / DRY / blast-radius / TDD scenarios) (reference)

## Phase 2: Technical Research

**Goal**: Find HOW to build it — best practices, known issues, security risks, TDD scenarios.

Record the phase transition before starting research (optional context logging; kernel-only setups skip it — a real helper failure stays visible):
```bash
if [ -f scripts/beads-context.sh ]; then bash scripts/beads-context.sh stage-transition <id> plan research; fi
```

Run these in parallel:

### Web research (parallel-deep-research skill)
```
Skill("parallel-deep-research")
```
Search for:
- "[tech stack] [feature] best practices [year]"
- "[library/framework] [feature] implementation patterns"
- "Known issues / gotchas with [approach selected]"

### OWASP Top 10 analysis

For this feature's risk surface, document each relevant OWASP category:
- What the risk is
- Whether it applies to this feature
- What mitigation will be implemented

### Codebase exploration (Explore agent)
- Similar existing patterns to reuse
- Files this feature will affect
- Existing test infrastructure to leverage

### DRY check (mandatory — use actual search tools)

Before finalizing the approach, run Grep/Glob/Read searches for existing implementations of the planned function or pattern. Do not rely on memory or assumptions — execute the searches.

```
Grep(searchTerm)   # e.g., the function or concept name
Glob("**/*.js")    # narrow to affected file types if needed
Read(matchedFile)  # inspect any match in context
```

If a match is found:
- Update the design doc's "Approach selected" section to say "extend existing [file/function]" — not "create new".
- Note the existing file path and line number in the design doc.

If no match is found: proceed. The DRY gate is cleared.

### Blast-radius search (mandatory for remove/rename/replace features)

If this feature involves **removing**, **renaming**, or **replacing** a concept, tool, or dependency:

1. Grep the ENTIRE codebase for the thing being removed/renamed:
   ```
   Grep("<thing-being-removed>")     # exact name
   Grep("<thing-being-removed>", -i)  # case-insensitive variant
   Glob("**/*<thing>*")              # files named after it
   ```

2. For EVERY match found:
   - Note the file path and line number in the design doc
   - Add a cleanup task to the task list (Phase 3)
   - Flag matches in unexpected packages or config files explicitly

3. Common hiding spots to check:
   - `package.json` (scripts, dependencies, description)
   - `install.sh` / setup scripts
   - CI/CD workflows (`.github/workflows/`)
   - Agent config files (`lib/agents/`, `.cursorrules`, etc.)
   - Documentation (`docs/`, `README.md`, `AGENTS.md`)
   - Import statements and require() calls

If no removal/rename is involved, this section is skipped.

### TDD test scenarios

Identify at minimum 3 test scenarios:
- Happy path
- Error / failure path
- Edge case from Phase 1

Append all research findings to the design doc under a `## Technical Research` section (not a separate file).

---

```
<HARD-GATE: Phase 2 exit>
Do NOT begin Phase 3 (setup) until:
1. OWASP analysis is documented in design doc
2. At least 3 TDD test scenarios are identified
3. Approach selection is confirmed (which library/pattern to use)
4. If feature involves removal/rename: blast-radius search completed, all references added to task list
</HARD-GATE>
```

---
