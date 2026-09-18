# Delivery budget decisions

No specification gaps encountered.

- Keep `--shards N` as the public spelling and treat `N` as a resource budget across the validate and full-suite boundaries.
- Reject an explicit budget that cannot fund one required lane worker before any child process starts.
- Reject `--shards` for consumer repositories because their package-owned test command has no Forge resource-budget contract.
- Record requested and effective budgets in full-suite run output; keep validation receipt identity and schema unchanged.
