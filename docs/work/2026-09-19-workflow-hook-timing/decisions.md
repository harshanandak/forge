# Workflow hook timing decisions

- Keep the real `protected-state-check.js` subprocess because it is the commit-boundary integration proof.
- Use the authority function's existing reader seams for the second assertion. The full hook already reads the real Git projection; repeating that scan adds Windows subprocess cost without adding coverage.
- Preserve the staged template bytes, unchanged generated workflow bytes, rejected result, and zero kernel read/write assertions.
- Do not change production code, timeouts, retry behavior, workflow artifacts, manifests, or dependencies.
- Measured on a quiet host: fixture setup 325 ms, staging 44 ms, real hook 1,084 ms, duplicate direct authority scan 873 ms, and cleanup 11 ms. Isolate only the duplicate scan because canonical saturation expanded the unchanged test beyond its 15-second deadline.
- Independent spec review and root quality review passed with the real hook, exact fixture state, intended mismatch reason, and zero kernel activity intact.
