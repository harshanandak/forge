---
title: {{title}}
description: {{description}}
category: testing
version: 1.0.0
author: {{author}}
created: {{created}}
updated: {{updated}}
tags:
  - testing
  - tdd
  - quality-assurance
---

# {{title}}

## Purpose

This testing skill guides you through comprehensive test strategy including unit tests, integration tests, and end-to-end tests with TDD best practices.

## When to Use

- User asks to write tests for existing code
- User wants to implement test-driven development
- User needs to improve test coverage
- User requests test refactoring or organization
- User wants to set up testing infrastructure

## Instructions

### Phase 1: Test Strategy
1. **Identify test types needed**:
   - Unit tests: Individual functions/modules
   - Integration tests: Component interactions
   - E2E tests: Full user workflows

2. **Determine coverage goals**:
   - Critical paths: 100% coverage
   - Business logic: 90%+ coverage
   - UI components: 70%+ coverage
   - Edge cases: Explicit tests

3. **Choose testing framework**:
   - JavaScript: Jest, Vitest, Bun Test
   - Python: pytest, unittest
   - Go: testing package
   - Rust: cargo test

### Phase 2: Test Structure (AAA Pattern)
```javascript
describe('Feature Name', () => {
  // ARRANGE: Set up test data and dependencies
  const testData = { ... }
  const mockDependency = jest.fn()

  // ACT: Execute the code being tested
  const result = functionUnderTest(testData, mockDependency)

  // ASSERT: Verify expected behavior
  expect(result).toBe(expectedValue)
  expect(mockDependency).toHaveBeenCalledWith(expectedArgs)
})
```

### Phase 3: Test Types

#### Unit Tests
- Test single function/method in isolation
- Mock all dependencies
- Fast execution (< 1ms per test)
- High coverage (aim for 100%)

```javascript
// Example: Pure function test
test('calculateTotal adds items correctly', () => {
  const items = [{ price: 10 }, { price: 20 }]
  expect(calculateTotal(items)).toBe(30)
})
```

#### Integration Tests
- Test multiple components together
- Use real or in-memory dependencies
- Moderate execution time (< 100ms)
- Focus on interfaces between components

```javascript
// Example: API endpoint test
test('POST /users creates user and returns 201', async () => {
  const response = await request(app)
    .post('/users')
    .send({ name: 'Test User' })

  expect(response.status).toBe(201)
  expect(response.body).toHaveProperty('id')
})
```

#### E2E Tests
- Test full user workflows
- Use real browser/environment
- Slow execution (seconds)
- Focus on critical paths

```javascript
// Example: User signup flow
test('user can sign up and access dashboard', async () => {
  await page.goto('/signup')
  await page.fill('#email', 'test@example.com')
  await page.fill('#password', 'secure123')
  await page.click('button[type=submit]')

  await expect(page).toHaveURL('/dashboard')
})
```

### Phase 4: Test Coverage Strategies

1. **Happy path**: Normal, expected inputs
2. **Edge cases**: Boundary conditions (0, -1, null, undefined, empty)
3. **Error cases**: Invalid inputs, network failures, timeouts
4. **Security**: Injection attempts, unauthorized access
5. **Performance**: Large datasets, concurrent requests

### Phase 5: Test Organization

```
test/
├── unit/
│   ├── utils/
│   │   └── string-helpers.test.js
│   └── models/
│       └── user.test.js
├── integration/
│   ├── api/
│   │   └── auth.test.js
│   └── database/
│       └── migrations.test.js
├── e2e/
│   └── user-flows/
│       └── signup.test.js
└── fixtures/
    └── test-data.json
```

## Tools Required

- Testing framework (Jest, pytest, etc.)
- Mocking library (if not built-in)
- Coverage tool (built into most frameworks)
- CI/CD integration for automated testing

## Examples

### Example 1: TDD Workflow
```
Step 1 (RED): Write failing test
test('validates email format', () => {
  expect(validateEmail('invalid')).toBe(false)
  expect(validateEmail('valid@example.com')).toBe(true)
})
// Test fails: validateEmail not implemented

Step 2 (GREEN): Minimal implementation
function validateEmail(email) {
  return email.includes('@')
}
// Test passes (basic)

Step 3 (REFACTOR): Proper implementation
function validateEmail(email) {
  const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  return regex.test(email)
}
// Test still passes (robust)
```

### Example 2: Testing Async Code
```javascript
test('fetchUser returns user data', async () => {
  // Mock API call
  const mockFetch = jest.fn().mockResolvedValue({
    json: () => Promise.resolve({ id: 1, name: 'Alice' })
  })

  global.fetch = mockFetch

  const user = await fetchUser(1)

  expect(user).toEqual({ id: 1, name: 'Alice' })
  expect(mockFetch).toHaveBeenCalledWith('/api/users/1')
})
```

### Example 3: Testing Error Cases
```javascript
test('handles network failure gracefully', async () => {
  const mockFetch = jest.fn().mockRejectedValue(new Error('Network error'))
  global.fetch = mockFetch

  await expect(fetchUser(1)).rejects.toThrow('Network error')

  // Or with try/catch
  try {
    await fetchUser(1)
  } catch (error) {
    expect(error.message).toBe('Network error')
  }
})
```

## Success Criteria

- [ ] All tests pass (100% pass rate)
- [ ] Coverage meets targets (unit: 90%+, integration: 70%+)
- [ ] Tests are fast (unit: < 1ms, integration: < 100ms)
- [ ] Tests are isolated (no shared state)
- [ ] Tests are maintainable (clear, DRY, well-organized)
- [ ] CI/CD runs tests automatically
- [ ] Flaky tests are fixed or marked as such

## Related Skills

- tdd-workflow: For test-driven development process
- mocking-strategies: For isolating dependencies
- coverage-analysis: For identifying untested code
- performance-testing: For load and stress testing
