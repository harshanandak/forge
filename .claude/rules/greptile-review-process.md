# Greptile Review Handling Process

**Purpose**: Standardized process for AI agents to systematically handle Greptile review comments.

**Critical**: This process has been problematic for days. AI agents MUST follow these exact steps for EVERY Greptile comment.

---

## Problem Background

**Previous Issues:**
- ❌ AI agents replied to PR with general comments instead of replying directly to each Greptile review thread
- ❌ AI agents didn't mark conversation threads as "resolved" after fixing issues
- ❌ No systematic process for tracking which Greptile comments are addressed vs pending
- ❌ Caused confusion and manual tracking overhead for maintainers

**Why This Matters:**
- Branch protection blocks merge when threads are unresolved
- Maintainers must manually verify all issues are addressed
- Inconsistent handling across different AI sessions

---

## Critical Distinction

**Replying vs Resolving:**

1. **Replying** = Adding a comment to the review thread
   - Uses REST API: `/repos/{owner}/{repo}/pulls/{pr}/comments/{comment_id}/replies`
   - Creates a threaded response within the review comment
   - Does NOT change the thread's resolved status

2. **Resolving** = Marking the thread as complete
   - Uses GraphQL API: `resolveReviewThread` mutation
   - Changes thread status to "Resolved"
   - Shows who resolved it and when

**Both are required** by this project's workflow:
- Reply explains what was fixed and why
- Resolve marks the thread as addressed

---

## For AI Agents: Mandatory Steps

When Greptile Quality Gate fails (score < 4/5) or when review comments exist:

### Step 1: List All Unresolved Threads

```bash
bash .claude/scripts/greptile-resolve.sh list <pr-number> --unresolved
```

**Output shows:**
- Thread ID (for resolving)
- Comment ID (for replying)
- File path and line number
- Issue description

**Example:**
```
✗ UNRESOLVED | docs/ROADMAP.md:282
  Thread ID: PRRT_kwDORErEU85tuh6I
  Comment ID: 2787717459
  Author: greptile-apps
  Issue: Leaking local Windows paths
```

### Step 2: For EACH Unresolved Thread (Systematic)

**Process each thread one at a time:**

1. **Read the comment** and understand the issue
   - Use the file path and line number to locate the code
   - Understand what Greptile is flagging

2. **Fix the issue** if the comment is valid
   - Make the necessary code changes
   - Commit the fix with a clear message

3. **Reply to the thread** with explanation
   ```bash
   bash .claude/scripts/greptile-resolve.sh reply <pr-number> <comment-id> "✅ Fixed: [description]

   Changed: [what was changed]
   Reason: [why this fixes the issue]
   Commit: [commit-sha]"
   ```

4. **Resolve the thread**
   ```bash
   bash .claude/scripts/greptile-resolve.sh resolve <pr-number> <thread-id>
   ```

5. **Track progress**: Mark comment as addressed in your notes

**Alternative (all-in-one):**
```bash
bash .claude/scripts/greptile-resolve.sh reply-and-resolve <pr-number> <comment-id> <thread-id> "✅ Fixed: [description]

Changed: [what was changed]
Reason: [why this fixes the issue]
Commit: [commit-sha]"
```

### Step 3: Verify All Threads Resolved

```bash
bash .claude/scripts/greptile-resolve.sh list <pr-number> --unresolved
```

**Should show**: "No unresolved comments" or empty list

**Confirm with stats:**
```bash
bash .claude/scripts/greptile-resolve.sh stats <pr-number>
```

**Should show**: "✓ All Greptile threads resolved!"

### Step 4: Push Changes & Wait for Re-review

```bash
git push
```

**Greptile will automatically:**
- Re-analyze the PR
- Update the confidence score
- Re-run the Quality Gate check

---

## Example Workflow

```bash
# 1. List unresolved threads
$ bash .claude/scripts/greptile-resolve.sh list 24 --unresolved

✗ UNRESOLVED | docs/ROADMAP.md:280
  Thread ID: PRRT_kwDORErEU85tuh6I
  Comment ID: 2787717459
  Issue: Leaking local Windows paths

# 2. Fix the issue (edit files, commit changes)
$ git add docs/ROADMAP.md
$ git commit -m "fix: replace Windows absolute paths with relative paths"

# 3. Reply and resolve in one step
$ bash .claude/scripts/greptile-resolve.sh reply-and-resolve 24 2787717459 PRRT_kwDORErEU85tuh6I \
  "✅ Fixed: Replaced Windows absolute paths with repo-relative paths

Changed: C:\\Users\\...\\plans\\... → .claude/plans/*.md
Reason: Absolute paths don't exist for other contributors
Commit: abc123"

✅ Reply posted successfully
✅ Thread resolved successfully

# 4. Verify all resolved
$ bash .claude/scripts/greptile-resolve.sh stats 24

Greptile unresolved: 0
✓ All Greptile threads resolved!

# 5. Push changes
$ git push
```

---

## Critical Rules

### ✅ DO:
- **Reply to EACH comment thread** using the script (not as separate PR comment)
- **Mark EACH thread as resolved** after fixing using the script
- **Track progress** (X of Y fixed) in your notes
- **Wait for Greptile re-review** after pushing fixes
- **Use comment ID for replies**, thread ID for resolving
- **Commit fixes BEFORE replying** so you can reference commit SHA

### ❌ DON'T:
- Post general PR comments about fixes (use threaded replies)
- Assume threads are auto-resolved (they're not)
- Skip replying to threads (explain what you fixed)
- Make multiple commits without resolving threads between them
- Reply without actually fixing the issue
- Resolve threads that haven't been fixed yet

---

## Script Commands Reference

### List Threads
```bash
# All threads
bash .claude/scripts/greptile-resolve.sh list <pr-number>

# Only unresolved
bash .claude/scripts/greptile-resolve.sh list <pr-number> --unresolved
```

### Reply to Thread
```bash
bash .claude/scripts/greptile-resolve.sh reply <pr-number> <comment-id> "<message>"
```

### Resolve Thread
```bash
bash .claude/scripts/greptile-resolve.sh resolve <pr-number> <thread-id>
```

### Reply and Resolve (Recommended)
```bash
bash .claude/scripts/greptile-resolve.sh reply-and-resolve <pr-number> <comment-id> <thread-id> "<message>"
```

### Batch Resolve (After all issues fixed)
```bash
bash .claude/scripts/greptile-resolve.sh resolve-all <pr-number>
```
**⚠️ Warning**: Only use after ALL issues are fixed and replied to

### Statistics
```bash
bash .claude/scripts/greptile-resolve.sh stats <pr-number>
```

---

## Integration with `/review` Command

The `/review` command should now include these steps:

1. Run `/review` as usual to analyze PR feedback
2. For Greptile comments, use the script to:
   - List unresolved threads
   - Fix each issue
   - Reply and resolve systematically
3. Verify all threads resolved before declaring review complete
4. Push changes and wait for Greptile re-review

---

## Troubleshooting

### Script fails with "404 Not Found"
**Cause**: Comment ID or thread ID is incorrect
**Solution**: Re-run `list` command to get correct IDs

### Reply appears as separate PR comment
**Cause**: Using wrong API endpoint
**Solution**: Script handles this automatically, don't manually comment

### Thread not showing as resolved after script
**Cause**: GitHub UI caching
**Solution**: Refresh page, or check with GraphQL query

### Greptile score not updating after fixes
**Cause**: Must push commits to trigger re-analysis
**Solution**: `git push` and wait 2-3 minutes for Greptile re-scan

---

## Success Criteria

**A review is complete when:**
- ✅ All Greptile threads are resolved (verified with `stats` command)
- ✅ All threads have replies explaining fixes
- ✅ Greptile Quality Gate passes (≥4/5 score)
- ✅ Branch protection allows merge
- ✅ No manual tracking needed by maintainers
