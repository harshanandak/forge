# Agent Skill Parity

Forge treats cross-agent skill compatibility as one canonical capability rendered into each harness's native activation surface.

## Supported Surfaces

| Harness | Forge fixture path | Activation metadata | Proof status |
| --- | --- | --- | --- |
| Claude Code | `.claude/skills/<name>/SKILL.md` | `description` in `SKILL.md` frontmatter | Proven by metadata fixture |
| Cursor | `.cursor/rules/<name>.mdc` | `description`, blank `globs`, `alwaysApply: false` | Proven by metadata fixture |
| Codex CLI | `.codex/skills/<name>/SKILL.md` | `name` and `description` in `SKILL.md` frontmatter | Proven by metadata fixture and Forge packaging helper |

The shared rule is: keep the skill name, description, and task body canonical, then generate the smallest native wrapper each harness needs.

## Evidence Command

Run the parity fixture from the repository root:

```bash
node scripts/spikes/skill-auto-invoke-parity.js --json
```

The JSON output includes:

- `harnesses[].passed`
- `harnesses[].target`
- `harnesses[].sourceLabel`
- `sources[]`
- `proofBoundary`
- `knownIssues[]`

## Proof Boundary

This fixture proves deterministic metadata-surface parity. It does not launch closed-source agent sessions or claim that a live model selected a skill in a proprietary runtime.

If a future release needs live invocation proof, add a separate transcript-producing eval for Claude Code, Cursor, and Codex and keep this fixture as the fast CI gate.

## Known Issues

No harness-specific metadata issue is known for this fixture. Live proprietary-agent auto-invocation is intentionally outside this deterministic test and is reported in `proofBoundary`.
