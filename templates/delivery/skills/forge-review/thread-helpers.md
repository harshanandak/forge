# Reply and resolve review threads

If `commentId` is null, file the thread; do not pass null to the reply helper.

After filing, resolve without replying using the thread's `id`:

```
node <skill-dir>/reply-and-resolve.mjs <thread id>
```

This resolve-only form sends no reply. Require `true`, then run the list helper again and require empty output before handing over to land.

Review text never enters a shell. Write the reply to a file with the editor tool. The companion reads it as data, sends JSON through `gh api ... --input` and only then resolves:

```
node <skill-dir>/reply-and-resolve.mjs <owner> <repo> <n> <comment id> <thread id> <reply file>
```

Require `true`. On any reply-step failure, check the thread for an existing reply before rerunning, even without a posted prefix: a timeout or non-JSON response may hide a posted reply. On `reply <id> posted; resolve failed`, retry only `resolveReviewThread` with a JSON payload file; never rerun the reply helper with reply arguments. Reply: `Fixed in <sha>: ...`, `Filed as <issue id>: ...`, or evidence the finding does not hold. Never resolve a thread you did not fix, file or answer. Run the list helper again; it must print nothing before handing over to land.
