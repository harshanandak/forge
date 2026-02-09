# Greptile Quality Gate Setup Guide

This guide walks you through enforcing a **minimum Greptile score of 4.0** before PR merge.

---

## Prerequisites

- GitHub repository with Actions enabled
- Admin access to repository settings
- Greptile account (free tier available)

---

## Step 1: Get Greptile API Key

1. **Sign up/Login**: Visit [https://app.greptile.com](https://app.greptile.com)

2. **Navigate to API Settings**:
   - Click your profile → Settings → API Keys

3. **Create API Key**:
   - Click "Generate New Key"
   - Name: `forge-github-actions`
   - Permissions: `code:review`, `pr:write`
   - Copy the key (you won't see it again!)

---

## Step 2: Add Secret to GitHub

1. **Navigate to Repository Secrets**:
   ```
   https://github.com/harshanandak/forge/settings/secrets/actions
   ```

2. **Click "New repository secret"**

3. **Add Secret**:
   - Name: `GREPTILE_API_KEY`
   - Value: [paste your API key]
   - Click "Add secret"

---

## Step 3: Verify Workflow File

The workflow file should already exist at [`.github/workflows/greptile.yml`](../.github/workflows/greptile.yml).

**Key configuration**:
```yaml
- name: Check Greptile Score
  run: |
    SCORE=${{ steps.greptile.outputs.score }}
    if (( $(echo "$SCORE < 4" | bc -l) )); then
      exit 1  # Fails the check
    fi
```

**Customize threshold** (optional):
- Change `4` to your desired minimum (e.g., `3.5`, `4.5`)
- Range: 0-5

---

## Step 4: Enable Branch Protection

1. **Navigate to Branch Protection**:
   ```
   https://github.com/harshanandak/forge/settings/branches
   ```

2. **Edit rule for `main` branch** (or create if doesn't exist)

3. **Enable Required Status Checks**:
   ```
   ✅ Require status checks to pass before merging
      ✅ Require branches to be up to date before merging

      Required status checks:
      ✅ test
      ✅ eslint
      ✅ CodeQL
      ✅ dependency-review
      ✅ greptile-review  ← ADD THIS
   ```

4. **Save changes**

---

## Step 5: Test the Setup

### Create a Test PR

```bash
# Create a branch with intentionally low-quality code
git checkout -b test/greptile-gate

# Create a complex, problematic file
cat > test-quality.js << 'EOF'
function doEverything(a, b, c, d, e) {
  if (a) {
    if (b) {
      if (c) {
        if (d) {
          if (e) {
            return a + b + c + d + e;
          }
        }
      }
    }
  }
  return 0;
}

// Magic number
if (user.age > 18) {
  // No error handling
  const result = fetch('https://api.example.com/data');
  console.log(result);
}
EOF

git add test-quality.js
git commit -m "test: verify Greptile quality gate"
git push -u origin test/greptile-gate

# Create PR
gh pr create --title "Test: Greptile Quality Gate" \
  --body "Testing minimum score enforcement"
```

### Expected Behavior

1. **Greptile workflow runs** (~1-2 minutes)
2. **Score calculated** (likely < 4.0 for the test code)
3. **PR comment posted** with score and feedback
4. **Merge blocked** if score < 4.0

### Verify Blocking

1. Go to PR page
2. Scroll to merge button
3. Should see: "Merging is blocked - greptile-review check failed"

### Fix and Re-test

```bash
# Improve the code
cat > test-quality.js << 'EOF'
const LEGAL_AGE = 18;

/**
 * Safely sums up to 5 numbers
 */
function sumNumbers(...numbers) {
  return numbers.reduce((sum, num) => sum + (num || 0), 0);
}

async function fetchUserData() {
  try {
    const response = await fetch('https://api.example.com/data');
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error('Failed to fetch user data:', error);
    throw error;
  }
}
EOF

git add test-quality.js
git commit -m "refactor: improve code quality for Greptile"
git push
```

**Expected**:
- New Greptile run
- Score ≥ 4.0
- Merge button enabled ✅

---

## Step 6: Clean Up Test

```bash
# Close and delete test PR
gh pr close test/greptile-gate --delete-branch
```

---

## Customization Options

### Adjust Score Threshold

Edit [`.github/workflows/greptile.yml`](../.github/workflows/greptile.yml):

```yaml
# Current: Minimum 4.0
if (( $(echo "$SCORE < 4" | bc -l) )); then

# Option 1: Stricter (4.5)
if (( $(echo "$SCORE < 4.5" | bc -l) )); then

# Option 2: More lenient (3.5)
if (( $(echo "$SCORE < 3.5" | bc -l) )); then
```

### Exclude Certain Files

Add to workflow:

```yaml
- name: Run Greptile Analysis
  with:
    exclude-paths: |
      test/**
      docs/**
      **/*.md
```

### Custom Greptile Config

Create `.greptile.yml` in repo root:

```yaml
version: 1
checks:
  complexity:
    max_cyclomatic: 10
  security:
    enabled: true
  style:
    enforce: true
ignore:
  - "*.test.js"
  - "*.spec.js"
  - "dist/**"
```

---

## Troubleshooting

### "Greptile check not appearing"

**Cause**: Workflow hasn't run yet.

**Fix**:
1. Create a test PR
2. Wait for workflow to run once
3. Then it will appear in branch protection options

### "GREPTILE_API_KEY not found"

**Cause**: Secret not configured.

**Fix**:
1. Verify secret exists: Settings → Secrets → Actions
2. Name must be **exactly** `GREPTILE_API_KEY`
3. Re-run workflow

### "Score always 0.0"

**Cause**: API key invalid or rate limit hit.

**Fix**:
1. Check API key is valid
2. Check Greptile account status
3. Review workflow logs for error messages

### "Merge blocked but score is 4.2"

**Cause**: Branch protection cached old status.

**Fix**:
1. Refresh PR page
2. Make a trivial commit to trigger re-check
3. Verify check is actually passing (green ✓)

---

## Monitoring & Metrics

### View Greptile Trends

```bash
# Check recent scores
gh pr list --json number,title --jq '.[] | .number' | while read pr; do
  gh pr view $pr --json number,title,comments \
    | jq -r '.comments[] | select(.body | contains("Greptile")) | .body' \
    | grep -oP 'Score: \K[0-9.]+'
done
```

### Team Dashboard

Consider creating a dashboard to track:
- Average Greptile score over time
- PRs blocked by quality gate
- Most common issues flagged
- Time to resolution

---

## Best Practices

### 1. Review Feedback, Don't Just Hit 4.0

Greptile's feedback is valuable even if score passes. Read it!

### 2. Use as Learning Tool

- Share high-scoring PRs as examples
- Discuss low scores in team meetings
- Identify patterns to avoid

### 3. Balance with Velocity

- Start with 3.5 threshold, increase gradually
- Don't let perfect be enemy of good
- Emergency bypasses should be rare (< 1%)

### 4. Combine with Human Review

- Greptile catches technical issues
- Humans review business logic, UX, architecture
- Both are needed for quality code

---

## Migration Strategy

If adding to existing repo with many open PRs:

### Week 1: Observe Only
```yaml
continue-on-error: true  # Don't block merges yet
```

### Week 2: Soft Enforcement
- Make Greptile check required
- But only require 3.0 score
- Team learns to address feedback

### Week 3: Increase to 3.5
- Most PRs should pass
- Address patterns causing failures

### Week 4: Full Enforcement at 4.0
- Team is familiar with expectations
- Code quality has improved
- Gates are effective

---

## Cost Considerations

**Greptile Pricing** (as of 2026):
- Free tier: 100 PR reviews/month
- Pro: $29/month - 500 reviews
- Team: $99/month - Unlimited

**Estimate for forge**:
- ~20-30 PRs/month → Free tier sufficient
- If exceeding, consider Team plan

---

## Alternative Approaches

### Option 1: Advisory Only

Don't block, just comment scores:

```yaml
- name: Check Greptile Score
  continue-on-error: true  # Never fails
```

### Option 2: Gradual Threshold

Start lenient, tighten over time:

```yaml
# Month 1: 3.0
# Month 2: 3.5
# Month 3: 4.0
```

### Option 3: File-Level Gates

Only enforce for critical files:

```yaml
if [[ "$CHANGED_FILES" == *"src/auth"* ]] && [[ "$SCORE" < 4.5 ]]; then
  exit 1
fi
```

---

## Support

**Greptile Issues**: https://github.com/greptile-apps/greptile-action/issues

**Forge Issues**: https://github.com/harshanandak/forge/issues

**Questions**: See [.github/BRANCH_PROTECTION_GUIDE.md](../.github/BRANCH_PROTECTION_GUIDE.md)

---

## Summary Checklist

```
[ ] Got Greptile API key from app.greptile.com
[ ] Added GREPTILE_API_KEY secret to GitHub
[ ] Verified .github/workflows/greptile.yml exists
[ ] Enabled greptile-review in branch protection
[ ] Tested with sample PR
[ ] Verified blocking works
[ ] Configured team/communicated changes
[ ] Set up monitoring (optional)
```

**Once complete**: All PRs require Greptile score ≥ 4.0 to merge ✅
