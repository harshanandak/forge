---
title: {{title}}
description: {{description}}
category: review
version: 1.0.0
author: {{author}}
created: {{created}}
updated: {{updated}}
tags:
  - code-review
  - quality
  - testing
---

# {{title}}

## Purpose

This review skill guides you through comprehensive code review covering functionality, security, performance, and maintainability.

## When to Use

- User asks to review a pull request
- User requests code quality assessment
- User needs security vulnerability check
- User wants performance optimization suggestions
- User asks for test coverage analysis

## Instructions

### Phase 1: Initial Assessment
1. Read PR description and linked issues
2. Understand the change scope and intent
3. Check if tests are included
4. Review CI/CD pipeline status

### Phase 2: Functionality Review
1. **Logic correctness**:
   - Does code do what it's supposed to?
   - Are edge cases handled?
   - Are error conditions handled?

2. **Test coverage**:
   - Are there tests for new functionality?
   - Do tests cover edge cases?
   - Are tests meaningful (not just increasing coverage)?

3. **API design**:
   - Is API intuitive and consistent?
   - Are breaking changes necessary and documented?
   - Is backward compatibility maintained?

### Phase 3: Security Review (OWASP Top 10)
1. **Injection vulnerabilities**:
   - SQL injection (parameterized queries?)
   - Command injection (spawn vs exec?)
   - XSS (input sanitization?)

2. **Authentication & Authorization**:
   - Proper auth checks?
   - Session management secure?
   - Access control enforced?

3. **Sensitive data**:
   - Secrets in code/logs?
   - Encryption for sensitive data?
   - PII handled properly?

4. **Dependencies**:
   - Vulnerable dependencies?
   - Unnecessary dependencies?

### Phase 4: Performance Review
1. **Algorithm complexity**: O(n) vs O(n²)?
2. **Database queries**: N+1 problems? Indexes?
3. **Memory usage**: Leaks? Large allocations?
4. **Caching**: Opportunities for caching?

### Phase 5: Maintainability Review
1. **Code style**: Follows conventions?
2. **Readability**: Clear variable names? Obvious intent?
3. **Complexity**: Functions too long/complex?
4. **Documentation**: JSDoc? README updated?
5. **DRY principle**: Code duplication?

### Phase 6: Provide Feedback
1. **Structure feedback**:
   - Critical issues (blocking)
   - Important suggestions (should fix)
   - Nice-to-haves (optional)

2. **Be constructive**:
   - Explain WHY, not just WHAT
   - Suggest alternatives
   - Praise good patterns

3. **Actionable items**:
   - Specific line numbers
   - Code examples
   - Links to documentation

## Tools Required

- Read tool: Review code changes
- Grep tool: Search for patterns
- Bash tool: Run tests, linters, security scans
- WebSearch: Look up best practices

## Examples

### Example 1: Security Issue Found
```
Comment on line 42 (src/auth.js):
❌ CRITICAL: SQL injection vulnerability

Current code:
  const query = `SELECT * FROM users WHERE username = '${username}'`

Issue: User input directly interpolated into SQL query

Fix:
  const query = 'SELECT * FROM users WHERE username = ?'
  const [rows] = await db.query(query, [username])

Why: Prevents SQL injection attacks (OWASP A03:2021)
Reference: https://owasp.org/www-community/attacks/SQL_Injection
```

### Example 2: Performance Suggestion
```
Comment on line 15 (src/reports.js):
⚠️ IMPORTANT: N+1 query problem

Current: Loads users one-by-one in loop (100 queries for 100 users)

Suggestion: Use JOIN or WHERE IN to batch load
  const userIds = posts.map(p => p.userId)
  const users = await db.query('SELECT * FROM users WHERE id IN (?)', [userIds])

Impact: Reduces 100 queries to 1 query
Performance gain: ~95% faster for large datasets
```

## Success Criteria

- [ ] All code paths reviewed
- [ ] Security vulnerabilities identified
- [ ] Performance bottlenecks noted
- [ ] Test coverage assessed
- [ ] Feedback is constructive and actionable
- [ ] Critical issues clearly marked
- [ ] Alternative solutions suggested

## Related Skills

- security-audit: For deep security analysis
- performance-optimization: For profiling and tuning
- test-coverage: For comprehensive testing
- refactoring: For code improvement suggestions
