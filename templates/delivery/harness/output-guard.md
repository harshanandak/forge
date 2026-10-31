# Tool output guard

Run `forge agent guard claude` or `forge agent guard codex` and merge the printed entries, preserving existing settings and hooks. Forge never installs them. Claude Code needs 2.1.121 or later; Codex needs `features.hooks` enabled. Review and trust the entries with `/hooks`.

The guard is warning-only. It never redacts, replaces or blocks a tool result. The credential still reaches the model; a post-tool hook cannot take it back. A false positive adds one warning and leaves the result intact.

PostToolUse scans provider prefixes, password-bearing connection URIs and long hex/base64 assignments to credential names. It stops at the first match and emits one fixed warning asking the model to avoid repeating the credential and tell the user to rotate it. Claude uses `additionalContext`; Codex uses `systemMessage`. Claude PostToolUseFailure uses the same warning. No input-derived text appears in the warning.

The boundary is the post-tool payload. It cannot hide terminal display, streamed chunks, telemetry or unhooked tools. Malformed, oversized or over-budget payloads fail open silently. Split, transformed and unsupported credential formats can escape detection. Keep the command guard and harness permission rules. Live harness delivery remains unverified; recorded payload tests do not establish model-context protection.
