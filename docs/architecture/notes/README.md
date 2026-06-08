# Architecture Notes

Use this directory for architecture-significant observations that do not yet belong in a scoped subsystem file.

## Template

```markdown
# AN-YYYYMMDD-short-slug — Title

```yaml
id: AN-YYYYMMDD-short-slug
record_type: architecture_note
topic: domain.subsystem.detail
scope: subsystem-or-component
status: observed | reviewed | accepted | stale | superseded | conflict
confidence: low | medium | high
source:
  - path: path/to/source
    lines: 1-20
supersedes: []
conflicts_with: []
```

## Statement

What architectural fact, rule, behavior, or constraint was discovered?

## Evidence

- Source links, code paths, tests, docs, issues, PRs, sessions.

## Implications

What should future humans/agents know before changing this area?
```
