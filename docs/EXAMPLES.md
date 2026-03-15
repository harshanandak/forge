# Forge Workflow Examples

Real-world examples showing how to use Forge for different scenarios.

---

## Table of Contents

- [Example 1: Simple Feature](#example-1-simple-feature)
- [Example 2: Bug Fix with Security](#example-2-bug-fix-with-security)
- [Example 3: Multi-File Refactor](#example-3-multi-file-refactor)
- [Example 4: Team Collaboration](#example-4-team-collaboration)

---

## Example 1: Simple Feature

**Task**: Add a health check endpoint

**Estimated Time**: 15 minutes

**Workflow**: Tactical

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
# STAGE 2: PLAN (includes design + research in Phase 2)
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
/validate

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
# STAGE 2: PLAN (includes research in Phase 2)
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
/validate

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
# STAGE 2: PLAN (includes research in Phase 2)
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
/validate

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

## Example 4: Team Collaboration

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
- `/plan` includes design intent + research (Phase 2)
- TDD keeps scope focused

### 2. Bug Fixes with Security (30-60 min)
- OWASP research happens in `/plan` Phase 2
- Security tests are mandatory
- Priority 0 for critical vulnerabilities

### 3. Multi-File Refactors (2-4 hours)
- TDD for each extracted method
- Commit after each GREEN cycle
- All existing tests must pass

### 4. Team Collaboration
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
