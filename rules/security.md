---
description: "OWASP Top 10 security checks"
alwaysApply: false
globs: []
---

# Security Scanning Guidelines

Thin pointer — full security analysis is documented in the plan design doc
(OWASP Top 10 pass during `/plan`) and enforced in the `validate` skill. Do not
duplicate the checklist here.

For every feature, analyze the **OWASP Top 10 (2021)**: broken access control,
cryptographic failures, injection (SQL/XSS/command), insecure design, security
misconfiguration, vulnerable components, auth failures, integrity failures,
logging/monitoring gaps, and SSRF.

- Parameterize queries; sanitize output; validate all inputs.
- Never store secrets or keys in code; reference env vars.
- Run dependency audits (`npm audit`) and add security test cases.

Load the `validate` skill and see `AGENTS.md` for the enforced gates.
