# SonarCloud Perfection Plan - Final Phase

## Objective
Achieve 100% SonarCloud quality gate compliance by fixing all remaining complexity and code quality issues.

## Current Status
- **Completed**: 231-point complexity reduction across 7 major functions
- **Remaining**: 6 complexity issues + 10 code quality issues

---

## Phase 7A: Helper Function Refinement (6 points)

### 1. promptBeadsSetup (Line 2951) - Complexity 17→15
**Current**: Single function handles status check, prompts, and 3 installation methods
**Strategy**: Extract installation method handling
- Create `installBeadsWithMethod(method, question)` helper
- Moves the nested try-catch and method switch to separate function
- **Reduction**: 2 points

### 2. promptOpenSpecSetup (Line 3035) - Complexity 17→15
**Current**: Mirror of promptBeadsSetup with same structure
**Strategy**: Extract installation method handling
- Create `installOpenSpecWithMethod(method, question)` helper
- Same pattern as Beads
- **Reduction**: 2 points

### 3. detectPackageManager (Line 251) - Complexity 17→15
**Current**: Nested if-else for 4 package managers + lock file checks
**Strategy**: Simplify detection logic
- Check lock files first (most authoritative)
- Fallback to command detection if no lock files
- Early returns to reduce nesting
- **Reduction**: 2 points

---

## Phase 7B: Pre-Existing Complexity (20+ points)

### 4. validateUserInput (Line 105) - Complexity 25→15
**Current**: Type-specific validation with deeply nested conditions
**Strategy**: Extract type-specific validators
- Create `validatePathInput(input)` - handles 'path' type
- Create `validateDirectoryPathInput(input)` - handles 'directory_path' type
- Create `validateAgentInput(input)` - handles 'agent' type
- Create `validateHashInput(input)` - handles 'hash' type
- Main function becomes a simple switch/dispatcher
- **Reduction**: 10 points

### 5. configureExternalServices (Line 1585) - Complexity 16→15
**Current**: Already heavily refactored, just 1 point over
**Strategy**: Minor extraction
- Extract the initial status check logic
- Or simplify conditional branches
- **Reduction**: 1 point

### 6. Unknown Function (Line 3988) - Complexity 25→15
**Need to identify**: Read the function to determine refactoring strategy
- **Reduction**: 10 points (estimated)

---

## Phase 7C: Code Quality Issues (10 items)

### Minor Fixes (Quick Wins)
1. **Nested Template Literal (Line 314)** - S4624
   - Refactor to avoid nested templates

2. **Catch Parameter Naming (Line 2792)** - S7718
   - Rename `npxErr` to `error_`

3. **Double Negation x2 (Lines 2856, 2889)** - S6509
   - Simplify `!!(condition)` to `Boolean(condition)`

4. **Negated Condition x2 (Lines 2856, 2889)** - S7735
   - Refactor to positive conditions

5. **Optional Chaining x2 (Lines 2167, 3596)** - S6582
   - Replace `a && a.b` with `a?.b`

6. **Return Type Consistency (Lines 507, 2831, 2864)** - S3800
   - Ensure functions return consistent types
   - Common issue: returning `string | boolean | null`
   - Fix: normalize return types

7. **Always Returns Same Value (Line 1834)** - S3516
   - Either remove function or add logic
   - Often dead code that can be refactored

8. **Top-level Await (Line 4373)** - S7785
   - Replace promise chain with top-level await

---

## Implementation Order

### Round 1: Quick Wins (15 minutes)
- Fix all 10 code quality issues (Phase 7C)
- Low risk, high impact on SonarCloud score

### Round 2: Helper Refinement (20 minutes)
- Fix 3 helper functions (Phase 7A)
- promptBeadsSetup, promptOpenSpecSetup, detectPackageManager
- Medium complexity, clear patterns

### Round 3: Deep Refactoring (25 minutes)
- Fix 3 pre-existing complex functions (Phase 7B)
- validateUserInput, configureExternalServices, unknown function
- Higher complexity, requires careful testing

---

## Testing Strategy

After each round:
```bash
bun test test/integration/enhanced-onboarding.test.js
```

After all changes:
```bash
bun test  # Full test suite
```

---

## Success Criteria

- ✅ All functions ≤15 cognitive complexity
- ✅ Zero SonarLint warnings in bin/forge.js
- ✅ All 127 core tests passing
- ✅ SonarCloud quality gate: PASS

---

## Risk Assessment

**Low Risk**:
- Code quality fixes (Phase 7C) - pure style improvements
- Helper function refinement (Phase 7A) - already isolated

**Medium Risk**:
- validateUserInput (Phase 7B) - security-critical, needs careful testing

**Mitigation**:
- Incremental commits after each fix
- Run tests after each round
- Can revert individual changes if needed

---

## Estimated Timeline

- Round 1 (Quick Wins): 15 minutes
- Round 2 (Helper Refinement): 20 minutes
- Round 3 (Deep Refactoring): 25 minutes
- **Total**: ~60 minutes

---

## Notes

- Line numbers may shift as edits are made
- Some warnings may be stale (IDE cache)
- Focus on legitimate issues only
- Maintain test coverage throughout
