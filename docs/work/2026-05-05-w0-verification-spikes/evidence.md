# Wave 0 Verification Evidence

Date: 2026-05-05

## Sources

| Label | Source | Use |
|---|---|---|
| S1 | https://docs.cursor.com/en/context/rules | Cursor project rules, `.cursor/rules`, `.mdc` metadata, `alwaysApply`, `globs`, `description`, AGENTS.md limitations. |
| S2 | https://docs.cursor.com/en/cli/reference/output-format | Cursor Agent CLI JSON and `stream-json` event schema. |
| S3 | https://developers.openai.com/codex/cli/slash-commands | Codex CLI built-in slash commands. |
| S4 | OpenAI Codex source clone at `C:\Users\harsha_befach\AppData\Local\Temp\codex-source-w0-spikes`, HEAD `9d579813bbcafde0abd4010f57ac93eea0b1be2b` | Local primary source search for custom prompt/slash command discovery. |
| S5 | `docs/work/2026-04-28-skeleton-pivot/v3-redesign-strategy.md` and `n1-moat-technical-deep-dive.md` | Local v3 gate requirements, D10/D11, anchor alias risk and performance budget. |

## Spike Results

### 1. Cursor `.mdc` frontmatter

Result: feasible.

Cursor documents project rules under `.cursor/rules`, with each rule as `.mdc` supporting metadata and content. The documented metadata fields are `description`, `globs`, and `alwaysApply`. The documented rule types map to these fields: `Always` includes the rule in model context, `Auto Attached` uses glob matches, `Agent Requested` requires a description, and `Manual` requires explicit mention.

Implementation implication: Forge should emit `.cursor/rules/<skill>.mdc` for Cursor project rules. For always-on rules, set `alwaysApply: true`; for requested/manual rules, keep `alwaysApply: false` and supply `description`.

### 2. Cursor agents/Composer format

Result: partially feasible, with a boundary.

Cursor documents `AGENTS.md` as a plain markdown root-level alternative to `.cursor/rules`, without metadata or complex configuration. Cursor also documents Agent CLI output formats: `json`, `stream-json`, and `text`; `stream-json` is newline-delimited JSON with typed events and a terminal `result`.

No primary Cursor source found for a separate stable "Composer file format" that Forge can write. Treat the modern Cursor file surfaces as `.cursor/rules/*.mdc` and root `AGENTS.md`; treat Cursor Agent CLI structured output as an integration surface, not a skill file format.

### 3. Codex CLI slash command file location

Result: not feasible as a stable custom slash-command file target from primary sources.

OpenAI documents built-in Codex CLI slash commands but does not document a user-authored slash-command prompt directory on the official slash-command page. The current OpenAI Codex source clone contains built-in slash-command handling and review custom prompt UI code, but the targeted source search did not find a stable custom slash prompt discovery path to rely on.

Implementation implication: do not make `~/.codex/prompts/*.md` or a project slash-command directory a required Forge v3 target. Prefer Codex skills/instructions surfaces already used by this repo, such as `.codex/skills/<name>/SKILL.md`, until OpenAI documents a stable custom slash-command file convention.

### 4. `patch.md` anchor stability bench

Executable check:

```sh
node scripts/spikes/patch-anchor-stability-bench.js --json
```

Default result: 50 patches, 50 renamed anchors, 2 unmapped aliases, orphan rate `4%`, target `<10%`, pass.

Quality implication: Wave 1 should require an `anchor_aliases` index on upgrades. Missing aliases should surface as orphans in `forge doctor`, not silently drop patches.

### 5. Cross-machine/concurrent race test

Executable check:

```sh
node scripts/spikes/config-race-bench.js --json
```

Default result: 50 two-machine trials, 1 manual resolve, manual resolve rate `2%`, target `<5%`, pass.

Quality implication: machine-local effective config must be namespaced by machine, while shared global keys should be treated as team policy and conflict when two machines set different values concurrently.

## `forge-2si5` Cross-Harness Parity Impact

This changes feasibility for `forge-2si5`: Cursor remains feasible through `.cursor/rules/*.mdc` plus optional root `AGENTS.md`, but Codex CLI custom slash-command parity is not primary-source supported as of this spike. Cross-harness parity should not require every harness to expose slash commands as files. The parity contract should compare capability classes:

- persistent instructions/rules
- command invocation where documented
- structured output where documented
- skill/package format where documented

For Codex, persistent skill parity should target Codex skills/instructions, not undocumented slash prompt files.
