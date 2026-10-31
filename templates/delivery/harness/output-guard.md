# Tool output guard

Run `forge agent guard claude` or `forge agent guard codex` and merge the printed entries, preserving existing settings and hooks. Forge never installs them. Claude Code needs 2.1.121 or later; Codex needs `features.hooks` enabled. Review and trust the entries with `/hooks`.

Use this as a warning-only guard. Local process-inclusive p95 exceeded 50 ms, and live filtering is unverified. Promotion requires fixtures passing in both installed harnesses, a representative corpus with at most one false positive per 1,000 results, and process-inclusive p95 under 50 ms. Recorded payload tests alone do not establish model-context protection.

PostToolUse scans provider prefixes, password-bearing connection URIs and long hex/base64 assignments to credential names. Warnings name only a short adjacent identifier, otherwise `unknown key (<family>)`, and ask for rotation and a rerun without printing credentials. Claude Bash results retain their shape with matched string values replaced by `[REDACTED]`; unknown shapes are warned about without replacement. Codex requests whole-result replacement using `decision: "block"`. Claude PostToolUseFailure can only warn: no documented error replacement exists.

The boundary is the post-tool payload. It cannot hide terminal display, streamed chunks, telemetry or unhooked tools. Malformed or oversized payloads fail open with a value-free note. Split, transformed and unsupported credential formats can escape detection. Keep the command guard and harness permission rules.
