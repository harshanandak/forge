---
title: {{title}}
description: {{description}}
category: coding
version: 1.0.0
author: {{author}}
created: {{created}}
updated: {{updated}}
tags:
  - coding
  - development
  - implementation
---

# {{title}}

## Purpose

This coding skill guides you through implementing features, fixing bugs, and refactoring code with best practices and test-driven development.

## When to Use

- User asks to implement a new feature
- User requests code refactoring or optimization
- User needs to fix a bug or error
- User wants to add tests for existing code
- User needs code generation or scaffolding

## Instructions

### Phase 1: Understand Requirements
1. Read existing code and understand current implementation
2. Clarify requirements and acceptance criteria
3. Identify affected files and dependencies
4. Review existing tests for similar features

### Phase 2: Test-Driven Development (TDD)
1. **RED**: Write failing test first
   - Define expected behavior
   - Write test case that fails
   - Commit: `git commit -m "test: add test for feature X"`

2. **GREEN**: Implement minimum code to pass
   - Write simplest implementation
   - Run tests until they pass
   - Commit: `git commit -m "feat: implement feature X"`

3. **REFACTOR**: Clean up and optimize
   - Extract helpers and utilities
   - Improve readability
   - Maintain test coverage
   - Commit: `git commit -m "refactor: optimize feature X"`

### Phase 3: Code Quality
1. Follow language/framework conventions
2. Add JSDoc/TSDoc comments for public APIs
3. Handle edge cases and errors
4. Consider performance implications
5. Check for security vulnerabilities

### Phase 4: Documentation
1. Update README if public API changed
2. Add inline comments for complex logic
3. Update CHANGELOG if applicable

## Tools Required

- Read tool: Read existing code
- Write/Edit tools: Modify code
- Bash tool: Run tests, git commands
- Glob/Grep tools: Search codebase

## Examples

### Example 1: Implement Feature with TDD
```
Input: "Add user authentication to the API"

Step 1 (RED):
test/auth.test.js:
  describe('POST /auth/login', () => {
    it('should return 200 and JWT token for valid credentials', ...)
  })
Commit: "test: add login authentication tests"

Step 2 (GREEN):
src/routes/auth.js:
  router.post('/login', async (req, res) => {
    // Basic implementation
  })
Commit: "feat: implement login authentication"

Step 3 (REFACTOR):
src/lib/auth-helpers.js:
  // Extract helpers
Commit: "refactor: extract auth helpers"
```

### Example 2: Bug Fix
```
Input: "Fix validation error in user registration"

1. Read src/routes/register.js - identify bug
2. Write test that reproduces the bug (RED)
3. Fix the bug (GREEN)
4. Verify all tests pass
5. Commit with bug reference
```

## Success Criteria

- [ ] All tests pass (100% pass rate)
- [ ] Code follows project conventions
- [ ] No linting or type errors
- [ ] Security vulnerabilities addressed
- [ ] Documentation updated
- [ ] Commits follow conventional format

## Related Skills

- code-review: For reviewing changes before merge
- testing: For comprehensive test strategies
- refactoring: For improving code structure
- debugging: For troubleshooting issues
