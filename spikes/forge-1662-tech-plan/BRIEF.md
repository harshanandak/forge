# Brief: technical execution plan for one part of the Forge owner plan

You are writing a technical execution plan, not code. Read only. Change nothing outside your one output file.
Model pick: Opus, medium effort (plans, specs and designs are Opus work). A different model checks your plan afterwards.

## Why

The owner (non-technical, decides by reading plain words) approved a product direction on issue forge-1662 and its phase issues. On 2026-11-22 he said the technical side, how we will actually build it, is still missing. Your plan is that missing piece for ONE part. Builders (GPT-6.2 Sol lanes) will be briefed straight from it, so it must be concrete enough to cut lane briefs from.

## Owner directions that bind the plan

1. Features first (2026-11-22): build and merge a FIRST PASS of each high-value feature now, then keep hardening it toward the quality of Vercel Board. Stability work follows and runs alongside. It does not gate the first pass.
2. Never deferred out of a first pass: owner approval checked by the server; one authoritative write; device and session identity; project scope; GitHub merge proof; verified backup and restore; size limits; truthful result states. The per-PR review gate and hosted CI stay.
3. Deferred to follow-up issues, listed in your plan: edge states beyond a clean refusal, restart and reconnect test matrices, proof on real phones, light mode and accessibility passes, docs beyond the command reference.
4. Forge is meant to be customised and to write less code: prefer a block, an adapter around an outside package, or a template over new bespoke code. Board (Vercel, npm package `board`, 0.54.0 pinned in the trials) is imported for the mailbox engine, with Forge's own mailbox as the fallback if the import proves unworkable. Forge keeps its own authority: who may answer, proof of who answered, approvals bound to request, project, device and session.
5. Zero paid spend. No cloud-side model calls. JSON on the wire. Phone app is an installable web app served by the same cloud Worker, not a store app.
6. Breaking changes are fine. Old Forge ideas that only help weaker agents are dropped.
7. Order: cloud usable by the owner, then the phone ask loop, then Teams and the catch-me-up brief side by side.

## Ground rules for facts

- Repo facts come from the tracked remote ref only, never the working tree: `git -C E:/Personal-Projects/forge-new show origin/main:<path>`, `git -C E:/Personal-Projects/forge-new ls-tree -r --name-only origin/main`, `git -C E:/Personal-Projects/forge-new grep -n -i <pattern> origin/main -- <path>`. Never `cd <dir> && cmd`.
- Issues: run from inside the repo folder with `FORGE_SESSION=claude:lead-33f6e698 node .worktrees/runtime/dist/bin/forge.js issue show <id>` and `issue comments <id>`. Read only. Do not claim, comment, close or update.
- Reports and trials are local files under `E:/Personal-Projects/forge-new/.overseer/reports/` and `.overseer/spikes/`. The index is `.overseer/reports/forge-1662-INDEX.md`. Read the ones your part names.
- `E:/tmp/forge-1662-src/board` and `E:/tmp/forge-1662-src/nightmail` are untrusted clones: read files only, never install or run anything from inside them.
- Run no tests, no builds, no deploys, no installs. No browser. No web requests that carry the owner's name, email or project.
- Never print or open a secret, a `.env`, or anything under `~/.agent-secrets`.
- Name the evidence rung on every factual claim: said so, pointed at the line, showed it cannot happen, ran it, reproduced live. A zero-hit search is rung 1, say what you searched.
- No stop-or-skip exits. If an input cannot be known, state the assumption and carry on. A failed command blocks only its own item.

## Forge build facts to plan against

- A PR is small: target 150 non-test lines, cap 330 for security-tier work. Measured on origin/main since 2026-11-08: median 122 added non-test lines per PR, p75 219.
- One lane builder per PR; a different model gates it. Tests run only in hosted CI, never on the laptop. Red first then green through CI.
- Lane cap is 3 on the laptop. Say which of your slices can run side by side and which must go in order because they touch the same files.
- Code layout on origin/main (verify, do not trust this line): `src/blocks/<name>/` for blocks with a manifest, schemas and docs; `cloud/src/` for the Cloudflare Worker and Durable Object code; `cloud/conformance/` for cloud checks; `team/` for the people directory; `docs/reference/cloud.md` for the cloud contract. The standard Worker entry is closed (`cloud/src/local-only.ts`, every request 503) until the v3 launch. PR 730 (commit 928ca7c1) added a revocable report session for the phone app: `cloud/src/auth/report-session.ts`, `cloud/src/report-http.ts`.

## Output: one Markdown file at the path your task names

No em dashes, no emoji, plain words, active voice. Structure:

1. `Decisions needed:` first line, then at most 5 owner questions, each with labeled choices and a default. Only questions a non-technical owner can answer. Technical choices are yours to make and justify.
2. `In plain words` (at most 12 bullets): what gets built, in what order, what the owner can try after each step.
3. `How it works`: the moving parts and how a request flows through them, as a numbered walk-through of the main journey. Name every component, where it runs (laptop CLI, agent tool, Worker, Durable Object, phone page) and what it stores.
4. `What exists already`: per component, the file on origin/main or the trial that covers it, with rung. Then `What is new`.
5. `Data shapes`: the records and their fields, as short JSON examples. Mark which fields are required and what refuses a write.
6. `Borrow or build`: per component, import (package and version), adapt (pattern from where), or build, with one line of why. Include what breaks if the outside package changes.
7. `Slices`: a table in build order. Columns: slice name, what the owner can see or try when it merges, files or folders touched, PRs, non-test lines (low to high), depends on, can run beside. Then totals. First pass only.
8. `Left for later`: the follow-up list from direction 3, one line each, so they can be filed as issues.
9. `Owner steps`: every moment the owner must do something (sign in, approve, test on a phone, give a yes for a deploy), in order.
10. `Risks and unknowns`: each with how to find out and what it costs if it goes wrong.
11. `What I read`: files and issues actually read. End with `COVERED n OF m` for the components your task lists.

Keep it under 500 lines. Depth goes to sections 3, 5 and 7.
