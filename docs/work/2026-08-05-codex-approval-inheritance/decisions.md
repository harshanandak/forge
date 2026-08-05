# Decisions

- Preserve safety by deferring to Codex built-ins and explicit user/launch policy,
  not by committing a repository-wide override.
- Delete the policy-only config instead of adding another local override layer.
- Keep this fix independent from the Sol/Luna evaluation PR wave.
