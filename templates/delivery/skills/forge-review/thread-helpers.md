# Reply and resolve review threads

If `commentId` is null, file the thread; do not pass null to the reply helper.

Review text never enters a shell. Write the reply to a file with the editor tool. The companion reads it as data, sends JSON through `gh api ... --input` and only then resolves:

```
node <skill-dir>/reply-and-resolve.mjs <owner> <repo> <n> <comment id> <thread id> <reply file>
```

Require `true`. On any reply-step failure, check the thread for an existing reply before rerunning, even without a posted prefix: a timeout or non-JSON response may hide a posted reply. On `reply <id> posted; resolve failed`, retry only `resolveReviewThread` with a JSON payload file; never rerun the reply helper. Reply: `Fixed in <sha>: ...`, `Filed as <issue id>: ...`, or evidence the finding does not hold. Never resolve a thread you did not fix, file or answer. Run the list helper again; it must print nothing before handing over to land.
