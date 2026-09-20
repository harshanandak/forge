# Delivery budget decisions

No specification gaps encountered.

- Keep `--shards N` as the public spelling and treat `N` as a resource budget across the validate and full-suite boundaries.
- Reject an explicit budget that cannot fund one required lane worker before any child process starts.
- Normalize only an automatically selected default up to the required lane cost; never widen an operator-requested budget.
- Report successful runs as requested/effective and rejected runs as requested/minimum/rejected, because a rejected run has no effective execution budget.
- Validate every repeated `--shards` occurrence and keep the last valid value, matching the standalone full-suite parser.
- Reject `--shards` for consumer repositories because their package-owned test command has no Forge resource-budget contract.
- Record requested and effective budgets in full-suite run output; keep validation receipt identity and schema unchanged.
