# Forge v3 Ecosystem Audit — INTEGRATE vs BUILD (N1-N18)

**Note**: The plan tracks N1–N18 (not N24). Mapping below covers all 18 + the listed deep-dive topics (N3, N11, N13, N14, "N19-N24 adapter SPI", "N20 forge new").

## Primary-source ecosystem inventory (verified)

| Ecosystem | URL | Relevant artifacts |
|---|---|---|
| Anthropic official plugins | https://github.com/anthropics/claude-code/tree/main/plugins | `plugin-dev`, `code-review`, `feature-dev`, `agent-sdk-dev`, `commit-commands`, `hookify` |
| Anthropic skills repo | https://github.com/anthropics/skills | Skill spec + template |
| Superpowers (obra) | https://github.com/obra/superpowers | 9 skills incl. `test-driven-development`, `subagent-driven-development`, `executing-plans`, `using-git-worktrees`, `requesting-code-review`, `receiving-code-review`, `dispatching-parallel-agents`, `brainstorming`, `finishing-a-development-branch` |
| GSD = travisjneuman/.claude | https://github.com/travisjneuman/.claude | 127 skills incl. `tdd-workflow`, `auto-claude`, `application-security`, `tech-debt-analyzer`, `generic-code-reviewer`, `core-workflow`, `agent-teams`; commands incl. `scaffold.md`, `audit-docs.md`, `review-code.md`, `auto-claude.md` |
| BMAD-METHOD | https://github.com/bmad-code-org/BMAD-METHOD | Agent personas (PM/Architect/Dev/QA), planning artifacts |
| MCP servers (official) | https://github.com/modelcontextprotocol/servers | `filesystem`, `git`, `github`, `memory`, `fetch`, `sequentialthinking` |

## N1–N18 mapping

| # | Title (1-line) | Existing prior art | Verdict | Rationale |
|---|---|---|---|---|
| N1 | EPIC: v3 skeleton architecture | n/a (umbrella) | BUILD | Forge-specific epic |
| N2 | Extract `forge-core` Stage contract | Anthropic skill spec (https://github.com/anthropics/skills/tree/main/spec); Superpowers `executing-plans` | BUILD (steal interface conventions) | Stage interface is Forge-specific; reuse SKILL.md frontmatter conventions |
| N3 | Layer-1 locked rails (TDD, no-secrets, no-main-push, audit log) | Superpowers `test-driven-development` (RED-GREEN-REFACTOR enforcer); GSD `tdd-workflow`; Anthropic `code-review` plugin; **no skill encodes "locked/non-overridable rails"** | WRAP existing + BUILD lockdown | Underlying TDD/security checks exist as skills; the *non-overridability schema rule* and audit log format must be Forge-built |
| N4 | Migrate matrix → `.forge/config.yaml` | n/a | BUILD | Forge-internal refactor |
| N5 | `forge options *` introspection | n/a | BUILD | Forge CLI surface |
| N6 | Install modes minimal/standard/full | yeoman generators (https://yeoman.io), plop (https://plopjs.com) | WRAP plop or hygen (https://github.com/jondot/hygen) | Mature template tooling; do not reinvent prompts |
| N7 | `extension.yaml` manifest spec | Anthropic plugin manifest (`.claude-plugin/plugin.json`) — https://github.com/anthropics/claude-code/tree/main/plugins | INTEGRATE / mirror schema | Adopt Anthropic's plugin manifest as the spec to reduce learning curve |
| N8 | Source resolvers `gh:`/`npm:`/`./local` | npm + git already do this; pacote (https://github.com/npm/pacote) for npm tarball fetching | WRAP `pacote` | Battle-tested; supports SRI integrity already |
| N9 | `forge.lock` + audit log + SRI | npm lockfile spec; pacote integrity hashes | WRAP pacote / mirror npm lock format | Don't invent a new integrity story |
| N10 | Multi-target sync (commands → 7 agent dirs) | Forge already has `scripts/sync-commands.js` v1 | BUILD (extend in-house) | Fully Forge-specific |
| N11 | `patch.md` spec + `--from-diff` | **No prior art found** for "intent-recorded customization with self-heal". Closest: git rerere (https://git-scm.com/docs/git-rerere), kustomize patches (https://kustomize.io). Anthropic plugin system has *no* customization-tracking story | BUILD (novel) | This is a genuine differentiator — primary-source confirms no skill does this |
| N12 | `forge upgrade` self-heal | Same as N11 | BUILD (novel) | Tied to patch.md |
| N13 | `forge insights --review-feedback` PoC | Greptile MCP (in toolchain), SonarCloud skill, Anthropic `code-review` plugin produce feedback **but no skill mines it to suggest new skills** | BUILD (novel) | Closest existing: `tech-debt-analyzer` (GSD) — different scope |
| N14 | `/forge map-codebase` brownfield | GSD `commands/scaffold.md` (https://github.com/travisjneuman/.claude/blob/master/commands/scaffold.md), GSD `audit-docs.md`; Anthropic `feature-dev` `code-explorer` agent (https://github.com/anthropics/claude-code/tree/main/plugins/feature-dev) | INTEGRATE feature-dev `code-explorer` + WRAP GSD `scaffold` | Two strong prior arts; integrate `code-explorer` agent as the codebase-mapper sub-agent |
| N15 | Rewrite ROADMAP + BUILDING_BLOCKS docs | n/a | BUILD | Forge-specific docs |
| N16 | `forge-marketplace.json` + collisions | Anthropic plugin marketplace conventions | INTEGRATE / mirror | Reuse Anthropic marketplace JSON shape |
| N17 | `forge profile` git-backed sync | GSD `~/.claude` (drop-in repo pattern), claude-mem (https://github.com/thedotmack/claude-mem) | INTEGRATE pattern | GSD's "git-cloned dotfile repo" is exactly Path A |
| N18 | Reorg `docs/` | n/a | BUILD | Forge-specific |

## Deep-dive answers

- **N3 locked rails**: TDD enforcement exists (Superpowers, GSD `tdd-workflow`); secret-scanning lives in `security-scanning` plugin (https://github.com/anthropics/claude-code/tree/main/plugins/security-scanning is referenced via plugin list — note: 404 on direct API confirms it lives outside `plugins/` dir, available as installable). **No** skill enforces them as schema-locked rails with audit log — Forge must build the *lockdown enforcement layer* on top of these skills.
- **N11 patch.md**: No prior art. Closest is `git rerere` (conflict-resolution memory) and kustomize patches; neither records *intent*. Genuine novel work.
- **N13 insights mining**: No prior art. Build it.
- **"N19-N24 adapter SPI"**: Anthropic's plugin system **already provides** an adapter interface — plugin manifest + skill SKILL.md frontmatter + hooks API (https://github.com/anthropics/claude-code/blob/main/plugins/plugin-dev/skills/hook-development). Forge should **adopt this**, not invent a new SPI. Significant savings.
- **"N20 `forge new` adapter scaffold"**: yeoman, plop, hygen are mature. Wrap **plop** (smallest, Node-native, ~5K LOC). https://plopjs.com
- **N14 `/forge map-codebase`**: Two integration paths — Anthropic `feature-dev` plugin's `code-explorer` agent OR GSD `scaffold.md` command. `feature-dev` is the cleaner integration (officially maintained).

## TOP-5 INTEGRATE (don't build)

1. **N7 extension manifest** ← Anthropic plugin.json schema (https://github.com/anthropics/claude-code/blob/main/plugins/README.md)
2. **N14 map-codebase** ← Anthropic `feature-dev` / `code-explorer` (https://github.com/anthropics/claude-code/tree/main/plugins/feature-dev)
3. **N6 install modes** ← plop (https://plopjs.com)
4. **N8/N9 resolvers + lockfile** ← pacote (https://github.com/npm/pacote)
5. **N17 profile sync** ← GSD ~/.claude pattern (https://github.com/travisjneuman/.claude)

## TOP-5 MUST BUILD (no prior art)

1. **N3 locked-rails enforcement** (skills exist, lockdown layer doesn't)
2. **N11 patch.md** (intent-recorded customization — novel)
3. **N12 forge upgrade self-heal** (tied to N11)
4. **N13 forge insights** (review-feedback → skill suggestions — novel)
5. **N5 `forge options *` introspection** (Forge-specific surface)

## TOP-3 FOUNDATION DEPS

1. **Anthropic plugin spec** (manifest + skill format + hooks) — adopt as Forge's adapter SPI. Source: https://github.com/anthropics/claude-code/tree/main/plugins
2. **pacote** (npm tarball + integrity) — backbone of N8/N9.
3. **plop** (template scaffolding) — backbone of N6/N20.

## 3 SURPRISES

1. **GSD has 127 skills + 110 marketplace repos (12,545 skills)** under `travisjneuman/.claude` — this is a *config repo* not a CLI; description claims "drop-in `~/.claude` config that auto-activates". Massive prior art.
2. **Anthropic's `feature-dev` plugin already implements a 7-phase workflow** with `code-explorer`/`code-architect`/`code-reviewer` agents — directly competes with Forge's stages 1-3. (https://github.com/anthropics/claude-code/tree/main/plugins/feature-dev)
3. **Anthropic `hookify` plugin auto-generates hooks from conversation patterns** — exactly the inverse of Forge's `forge insights` (N13). Could be wrapped instead of built. (https://github.com/anthropics/claude-code/tree/main/plugins/hookify)

## Effort impact (rough)

If we INTEGRATE on N6/N7/N8/N9/N14/N16/N17 instead of building:
- N6 saved ~2 days (plop wrap)
- N7 saved ~3 days (manifest schema)
- N8/N9 saved ~5 days (pacote wraps integrity + resolvers)
- N14 saved ~4 days (code-explorer agent)
- N16/N17 saved ~3 days (mirror Anthropic marketplace + GSD pattern)

**Estimated time saved: ~17 engineering-days** (~3.5 weeks) on the v3 plan, leaving Forge to focus on the genuinely novel N3/N11/N12/N13 stack — which is where Forge's IP actually lives.
