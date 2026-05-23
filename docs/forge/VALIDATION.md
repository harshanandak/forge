# Validation Reference

This consumer-installed copy mirrors `docs/reference/VALIDATION.md`.

## Project Validation

```bash
bun run check
```

The default validation script runs:

1. `bun run typecheck`
2. `bun run lint`
3. `bun audit`
4. `node scripts/test.js --validate`

## Stage Validation

`/validate` is an agent workflow stage. It is not the same as `bun run check` or `forge-preflight`.

## Evidence

Record fresh command output before claiming validation passed. If validation fails, fix the first failing stage and rerun the full command.

