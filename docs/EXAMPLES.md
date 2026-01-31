# Forge Workflow Examples

Real-world examples showing how to use Forge for different scenarios.

---

## Table of Contents

- [Example 1: Simple Feature](#example-1-simple-feature)
- [Example 2: Bug Fix with Security](#example-2-bug-fix-with-security)
- [Example 3: Multi-File Refactor](#example-3-multi-file-refactor)
- [Example 4: Architecture Change](#example-4-architecture-change)
- [Example 5: Team Collaboration](#example-5-team-collaboration)

---

## Example 1: Simple Feature

**Task**: Add a health check endpoint

**Estimated Time**: 15 minutes

**Workflow**: Tactical (no OpenSpec needed)

### Step-by-Step

```bash
# ═══════════════════════════════════════════════════════════
# STAGE 1: STATUS - Where are we?
# ═══════════════════════════════════════════════════════════
/status

# Output:
# ✓ Branch: main
# ✓ Clean working directory
# ✓ No active work

# ═══════════════════════════════════════════════════════════
# STAGE 2: RESEARCH
# ═══════════════════════════════════════════════════════════
/research health-check-endpoint

# Creates: docs/research/health-check-endpoint.md
# Contains:
# - REST health check conventions
# - HTTP 200 vs 503 debate
# - Security: avoid exposing internal details
# - TDD scenarios: 200 OK test, optional dependencies

# ═══════════════════════════════════════════════════════════
# STAGE 3: PLAN
# ═══════════════════════════════════════════════════════════
/plan health-check-endpoint

# Creates:
# - Branch: feat/health-check-endpoint
# - Beads issue: PROJ-42

# ═══════════════════════════════════════════════════════════
# STAGE 4: DEV (TDD)
# ═══════════════════════════════════════════════════════════
/dev

# RED: Write failing test
# File: tests/health.test.js
describe('GET /health', () => {
  it('returns 200 OK with status', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});
# Run → ❌ Fails

# GREEN: Minimal code
# File: routes/health.js
router.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});
# Run → ✅ Passes

# REFACTOR: (none needed)
git commit -m "feat: add health check endpoint"

# ═══════════════════════════════════════════════════════════
# STAGE 5: CHECK
# ═══════════════════════════════════════════════════════════
/check

# ✓ Type check passed
# ✓ Linter passed
# ✓ Tests passed (1 test)
# ✓ Security scan passed

# ═══════════════════════════════════════════════════════════
# STAGE 6: SHIP
# ═══════════════════════════════════════════════════════════
/ship

# Created PR #42
# URL: https://github.com/you/project/pull/42
```

**Result**: Feature shipped in 15 minutes with tests and documentation.

---

## Example 2: Bug Fix with Security

**Task**: Fix SQL injection vulnerability in search endpoint

**Estimated Time**: 30 minutes

**Severity**: High (security vulnerability)

### Step-by-Step

```bash
# ═══════════════════════════════════════════════════════════
# STAGE 1: STATUS
# ═══════════════════════════════════════════════════════════
/status

# If Beads installed:
bd create "SQL injection in search endpoint" \
  --type bug \
  --priority 0 \
  --label "security,critical"

# ═══════════════════════════════════════════════════════════
# STAGE 2: RESEARCH
# ═══════════════════════════════════════════════════════════
/research sql-injection-fix-search

# Research includes:
# - OWASP A03:2021 Injection analysis
# - Parameterized queries vs prepared statements
# - Input validation best practices
# - Testing for SQL injection (sqlmap patterns)

# ═══════════════════════════════════════════════════════════
# STAGE 3: PLAN
# ═══════════════════════════════════════════════════════════
/plan sql-injection-fix-search

# Branch: fix/sql-injection-search
# Updates issue: PROJ-123

# ═══════════════════════════════════════════════════════════
# STAGE 4: DEV (TDD for security)
# ═══════════════════════════════════════════════════════════
/dev

# RED: Write test for SQL injection attempt
describe('POST /search security', () => {
  it('prevents SQL injection via search param', async () => {
    const maliciousInput = "'; DROP TABLE users--";
    const response = await request(app)
      .post('/search')
      .send({ query: maliciousInput });

    expect(response.status).toBe(200);
    // Verify database still intact
    const users = await db.query('SELECT COUNT(*) FROM users');
    expect(users.rows[0].count).toBeGreaterThan(0);
  });
});
# Run → ❌ Fails (database affected)

# GREEN: Fix with parameterized query
// Before (vulnerable):
const results = await db.query(
  `SELECT * FROM products WHERE name LIKE '%${req.body.query}%'`
);

// After (safe):
const results = await db.query(
  'SELECT * FROM products WHERE name LIKE $1',
  [`%${req.body.query}%`]
);
# Run → ✅ Passes

# REFACTOR: Add input validation
const { query } = req.body;
if (!query || typeof query !== 'string') {
  return res.status(400).json({ error: 'Invalid query' });
}
if (query.length > 100) {
  return res.status(400).json({ error: 'Query too long' });
}

git commit -m "fix: prevent SQL injection in search endpoint

- Use parameterized queries
- Add input validation
- Add security test

OWASP A03:2021 Injection"

# ═══════════════════════════════════════════════════════════
# STAGE 5: CHECK
# ═══════════════════════════════════════════════════════════
/check

# ✓ Type check passed
# ✓ Linter passed
# ✓ Tests passed (including security test)
# ✓ Security scan: SQL injection vulnerability FIXED

# ═══════════════════════════════════════════════════════════
# STAGE 6: SHIP
# ═══════════════════════════════════════════════════════════
/ship

# PR description includes:
# ## Security Fix
# - Fixed SQL injection in search endpoint
# - OWASP A03:2021 Injection
# - Severity: High
#
# ## Changes
# - Parameterized queries
# - Input validation (type + length)
# - Security test added
#
# ## Verification
# - ✓ Manual sqlmap testing
# - ✓ Automated security scan passed
```

**Result**: Security vulnerability fixed with tests in 30 minutes.

---

## Example 3: Multi-File Refactor

**Task**: Extract authentication logic to separate service

**Estimated Time**: 2-3 hours

**Files Affected**: 5-6 files

### Step-by-Step

```bash
# ═══════════════════════════════════════════════════════════
# STAGE 1: STATUS
# ═══════════════════════════════════════════════════════════
/status

bd create "Extract auth logic to service" \
  --type chore \
  --priority 2

# ═══════════════════════════════════════════════════════════
# STAGE 2: RESEARCH
# ═══════════════════════════════════════════════════════════
/research auth-service-extraction

# Research covers:
# - Service layer patterns
# - Dependency injection
# - Testing strategies for services
# - File organization

# Codebase analysis finds:
# - Auth logic scattered across 3 route handlers
# - 15 references to inline JWT code
# - No service layer exists yet

# ═══════════════════════════════════════════════════════════
# STAGE 3: PLAN
# ═══════════════════════════════════════════════════════════
/plan auth-service-extraction

# Branch: refactor/auth-service
# Issue: PROJ-85

# Plan includes:
# 1. Create AuthService class
# 2. Extract login logic
# 3. Extract signup logic
# 4. Extract token validation
# 5. Update all references
# 6. Add service tests

# ═══════════════════════════════════════════════════════════
# STAGE 4: DEV (TDD for each method)
# ═══════════════════════════════════════════════════════════
/dev

# RED: Test for AuthService.login()
describe('AuthService', () => {
  describe('login', () => {
    it('returns JWT for valid credentials', async () => {
      const result = await authService.login('user@test.com', 'password123');
      expect(result.token).toBeDefined();
      expect(jwt.verify(result.token, SECRET)).toBeTruthy();
    });
  });
});
# Run → ❌ Fails (AuthService doesn't exist)

# GREEN: Create AuthService
class AuthService {
  async login(email, password) {
    const user = await db.findUserByEmail(email);
    if (!user || !(await bcrypt.compare(password, user.password))) {
      throw new Error('Invalid credentials');
    }
    return {
      token: jwt.sign({ userId: user.id }, SECRET, { expiresIn: '24h' })
    };
  }
}
# Run → ✅ Passes

# REFACTOR: Update routes to use service
// Before:
app.post('/login', async (req, res) => {
  const user = await db.findUserByEmail(req.body.email);
  // ... inline JWT logic
});

// After:
app.post('/login', async (req, res) => {
  const result = await authService.login(req.body.email, req.body.password);
  res.json(result);
});

git commit -m "refactor: extract login to AuthService"

# Repeat for signup, token validation, etc.
# 5-6 commits total

# ═══════════════════════════════════════════════════════════
# STAGE 5: CHECK
# ═══════════════════════════════════════════════════════════
/check

# ✓ Type check passed
# ✓ Linter passed
# ✓ Tests passed (15 new service tests + existing route tests)
# ✓ Security scan passed

# ═══════════════════════════════════════════════════════════
# STAGE 6: SHIP
# ═══════════════════════════════════════════════════════════
/ship

# PR #85
# - Created AuthService class
# - Extracted 3 route handlers
# - 15 service tests
# - All existing tests still pass
```

**Result**: Clean refactor with full test coverage in 2-3 hours.

---

## Example 4: Architecture Change

**Task**: Add user authentication system (strategic)

**Estimated Time**: 2-3 days

**Approach**: OpenSpec proposal first

### Step-by-Step

```bash
# ═══════════════════════════════════════════════════════════
# STAGE 1: STATUS
# ═══════════════════════════════════════════════════════════
/status

# ═══════════════════════════════════════════════════════════
# STAGE 2: RESEARCH
# ═══════════════════════════════════════════════════════════
/research user-authentication

# Comprehensive research:
# - JWT vs session-based auth
# - Password hashing (bcrypt vs argon2)
# - OWASP A07:2021 Authentication Failures
# - OAuth 2.0 for social login
# - Rate limiting for login attempts
# - Database schema for users table
# - Migration strategy

# Research doc: 500+ lines

# ═══════════════════════════════════════════════════════════
# STAGE 3: PLAN (with OpenSpec)
# ═══════════════════════════════════════════════════════════
/plan user-authentication

# Because this is strategic (architecture change):
# OpenSpec proposal created

# In AI assistant (Claude, Cursor, etc.):
/opsx:new
# Describe: "Add user authentication with JWT"

/opsx:ff
# Generates:
# - openspec/changes/user-authentication/proposal.md
# - openspec/changes/user-authentication/design.md
# - openspec/changes/user-authentication/tasks.md
# - openspec/changes/user-authentication/specs/ (delta specs)

# Review proposal.md:
## Proposal: User Authentication

**Intent**: Add secure authentication system

**Scope**:
- User registration (email + password)
- Login with JWT tokens
- Password reset flow
- Rate limiting
- Email verification

**Rationale**:
- Users need private accounts
- Security: bcrypt, JWT, rate limiting
- Follows OWASP guidelines

**Alternatives Considered**:
1. Session-based (rejected: scalability)
2. OAuth only (rejected: want email/password too)

# Create PR for PROPOSAL APPROVAL first
git checkout -b proposal/user-authentication
git add openspec/
git commit -m "proposal: user authentication system"
git push
gh pr create --title "Proposal: User Authentication"

# Wait for approval before implementation

# ═══════════════════════════════════════════════════════════
# AFTER PROPOSAL APPROVED
# ═══════════════════════════════════════════════════════════

# Create implementation branch
git checkout -b feat/user-authentication

bd create "User authentication (see openspec/changes/user-authentication)" \
  --type feature \
  --priority 1

# ═══════════════════════════════════════════════════════════
# STAGE 4: DEV (TDD for each task in tasks.md)
# ═══════════════════════════════════════════════════════════
/dev

# OpenSpec tasks.md has 12 tasks:
# 1. Create users table migration
# 2. Create User model
# 3. Hash passwords with bcrypt
# 4. POST /auth/signup endpoint
# 5. POST /auth/login endpoint
# 6. JWT middleware
# 7. POST /auth/refresh endpoint
# 8. POST /auth/forgot-password endpoint
# 9. POST /auth/reset-password endpoint
# 10. Rate limiting middleware
# 11. Email verification
# 12. Update all protected routes

# Each task: RED → GREEN → REFACTOR → COMMIT

# Example for task 4 (signup):

# RED:
describe('POST /auth/signup', () => {
  it('creates user with hashed password', async () => {
    const response = await request(app)
      .post('/auth/signup')
      .send({ email: 'test@example.com', password: 'secure123' });

    expect(response.status).toBe(201);
    expect(response.body.token).toBeDefined();

    const user = await db.findUserByEmail('test@example.com');
    expect(user.password).not.toBe('secure123'); // hashed
  });
});
# Run → ❌ Fails

# GREEN:
app.post('/auth/signup', async (req, res) => {
  const { email, password } = req.body;
  const hashedPassword = await bcrypt.hash(password, 10);
  const user = await db.createUser(email, hashedPassword);
  const token = jwt.sign({ userId: user.id }, SECRET, { expiresIn: '24h' });
  res.status(201).json({ token });
});
# Run → ✅ Passes

# REFACTOR: Extract to AuthService, add validation
git commit -m "feat: add user signup endpoint

- Bcrypt password hashing
- JWT token generation
- Input validation
- Rate limiting

Task 4/12 in openspec/changes/user-authentication/tasks.md"

# Repeat for all 12 tasks
# ~1-2 days

# Update OpenSpec progress:
/opsx:apply

bd update PROJ-90 --status in_progress --comment "8/12 tasks complete"

# ═══════════════════════════════════════════════════════════
# STAGE 5: CHECK
# ═══════════════════════════════════════════════════════════
/check

# ✓ Type check passed
# ✓ Linter passed
# ✓ Tests passed (45 new tests)
# ✓ Security scan passed
# ✓ Migration runs successfully

# ═══════════════════════════════════════════════════════════
# STAGE 6: SHIP
# ═══════════════════════════════════════════════════════════
/ship

# PR #90 includes:
# - Link to OpenSpec proposal
# - All 12 tasks completed
# - 45 tests
# - Security scan results
# - Migration instructions

# ═══════════════════════════════════════════════════════════
# STAGE 7: REVIEW
# ═══════════════════════════════════════════════════════════
/review 90

# Address feedback from:
# - Security team
# - Architecture review
# - CI/CD failures

# ═══════════════════════════════════════════════════════════
# STAGE 8: MERGE
# ═══════════════════════════════════════════════════════════
/merge 90

# After merge:
/opsx:sync  # Merge delta specs into main specs
/opsx:archive user-authentication

bd close PROJ-90

# ═══════════════════════════════════════════════════════════
# STAGE 9: VERIFY
# ═══════════════════════════════════════════════════════════
/verify

# Check:
# - API docs updated
# - README has auth examples
# - Migration in changelog
```

**Result**: Complete authentication system with proposal approval, TDD, and documentation in 2-3 days.

---

## Example 5: Team Collaboration

**Task**: Multiple developers working on same project with Beads

### Scenario

Team of 3 developers:
- **Alice**: Working on payment integration
- **Bob**: Working on email notifications
- **Charlie**: Working on admin dashboard

### Workflow

```bash
# ═══════════════════════════════════════════════════════════
# PROJECT SETUP (Once per project)
# ═══════════════════════════════════════════════════════════
bd init --prefix SHOP
bd sync  # Commit .beads/ to git

# ═══════════════════════════════════════════════════════════
# ALICE: Payment Integration
# ═══════════════════════════════════════════════════════════

# Morning: Check what's available
bd ready
# Output:
# SHOP-1: Payment integration (ready)
# SHOP-3: Admin dashboard (ready)

# Claim work
bd update SHOP-1 --status in_progress
/status
/research stripe-payment-integration
/plan stripe-payment-integration
/dev

# Midday: Progress update
bd comments SHOP-1 "Stripe SDK integrated, working on webhooks"

# Afternoon: Blocked on API keys
bd update SHOP-1 --status blocked --comment "Need production Stripe API keys"

# Create dependency
bd create "Get Stripe API keys from DevOps" --type chore --priority 1
bd dep add SHOP-1 SHOP-5  # SHOP-1 depends on SHOP-5

bd sync  # Push to git

# ═══════════════════════════════════════════════════════════
# BOB: Email Notifications (Same Time)
# ═══════════════════════════════════════════════════════════

# Morning: Pull latest, check work
git pull
bd sync  # Sync with Alice's updates

bd ready
# Output:
# SHOP-3: Admin dashboard (ready)
# SHOP-2: Email notifications (ready)

# Claim different feature
bd update SHOP-2 --status in_progress
/research sendgrid-email-notifications
/plan email-notifications
/dev

# No conflicts with Alice (different files)

# End of day: Complete
bd close SHOP-2 --reason "Implemented with SendGrid"
/ship
bd sync

# ═══════════════════════════════════════════════════════════
# CHARLIE: Admin Dashboard (Next Day)
# ═══════════════════════════════════════════════════════════

# Morning: Check dependencies
git pull
bd sync

bd show SHOP-3
# Output:
# Status: ready
# Depends on: (none)

bd update SHOP-3 --status in_progress

# Discovers overlap with Bob's work
bd comments SHOP-3 "Need Bob's email service for user notifications"
bd dep add SHOP-3 SHOP-2  # SHOP-3 depends on SHOP-2

# Bob's work already merged, so can proceed
/research admin-dashboard
/plan admin-dashboard
/dev

# ═══════════════════════════════════════════════════════════
# COLLABORATION PATTERNS
# ═══════════════════════════════════════════════════════════

# Check what teammates are working on:
bd list --status in_progress

# Check blocked work:
bd blocked
# Output:
# SHOP-1: Payment integration (blocked by SHOP-5)

# Find work with no blockers:
bd ready

# See full project status:
bd stats
# Output:
# Total issues: 12
# Open: 8
# In Progress: 3 (Alice, Bob, Charlie)
# Blocked: 1 (SHOP-1)
# Done: 4

# Always sync at end of session:
bd sync
```

**Result**: Team can work in parallel, track dependencies, and avoid conflicts.

---

## Key Takeaways

### 1. Simple Features (15-30 min)
- Use `/research` even for small features
- TDD keeps scope focused
- No OpenSpec needed

### 2. Bug Fixes with Security (30-60 min)
- OWASP research in `/research` stage
- Security tests are mandatory
- Priority 0 for critical vulnerabilities

### 3. Multi-File Refactors (2-4 hours)
- TDD for each extracted method
- Commit after each GREEN cycle
- All existing tests must pass

### 4. Architecture Changes (2-5 days)
- Always use OpenSpec proposal
- Get approval BEFORE implementation
- Tasks.md breaks down work
- Frequent progress updates

### 5. Team Collaboration
- Beads tracks dependencies
- `bd ready` finds available work
- `bd sync` at end of every session
- Comments keep teammates informed

---

## Next Steps

📚 **New to Forge?** → [QUICKSTART.md](../QUICKSTART.md)

📖 **Learn workflow** → [WORKFLOW.md](WORKFLOW.md)

🛠️ **Setup tools** → [SETUP.md](SETUP.md)

💬 **Questions?** → [GitHub Discussions](https://github.com/harshanandak/forge/discussions)
