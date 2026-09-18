# Delivery lint portability decisions

No specification gaps encountered.

- Reuse `secureExecFileSync` as `runLint`'s default executor so Windows local `.cmd` shims use the existing hardened path.
- Preserve injected executors for focused unit tests and preserve the existing missing-ESLint consumer skip.
- Do not change lint arguments, success criteria, validation receipt rules, or dependencies.
