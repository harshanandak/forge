# Decisions

- Use pure CommonJS plus checked-in JSON; do not touch existing evidence,
  replay, adapter, routing, merge, comment, or gate code.
- Use SHA-256 over canonical JSON for packet and manifest binding.
- Use explicit manifests rather than deriving tier membership from runtime
  timestamps, random state, model output, or trial results.
- Treat all malformed, missing, extra, leaked, mismatched, or unsafe evidence as
  a failed oracle result; the evaluator must never repair or infer it.
- Keep trial indices zero-based (`0`, `1`, `2`) so the three attempts are
  explicit and easy to bind identically across arms.
