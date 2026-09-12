# Fail closed when validation shards fail

Issue: `58aa811a-fdbe-459a-8e9a-c71e3dd634ee`

## Intent

`forge validate` must report failure and exit nonzero whenever the Forge full-suite child fails, times out, lacks a terminal aggregate, or returns an unknown result. A failed run must not create a validation receipt.

## Approach

Keep the existing shard aggregate contract. Fix the shared command-error classifier so only a real missing executable is treated as `ENOENT`; child diagnostics containing ordinary words such as `not found` remain failures. Exercise the real `runAllTests` and `executeValidate` result paths.

## Constraints

- Do not weaken or skip tests.
- Do not increase timeouts.
- Keep real missing-runner behavior portable across Windows and POSIX.
- Reuse the existing receipt completeness gate.

## Ambiguity policy

Fail closed for any result that is not a structurally proven successful aggregate.
