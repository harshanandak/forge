# Brief: independent check of three technical plans (forge-1793)

Model pick: GPT-6.1 Sol, high effort. Reason: the lead and the owner will act on this report, and the plans were written by a different model (Opus). Read only. Your single output is one Markdown file. Write no code and change no other file.

## What you are checking

Three technical execution plans for the Forge owner plan, written in parallel by three agents that could not read each other's work:

1. `E:/Personal-Projects/forge-new/.overseer/reports/forge-1662-tech-ask-loop.md` (phone ask loop, issue forge-1761)
2. `E:/Personal-Projects/forge-new/.overseer/reports/forge-1662-tech-brief-home.md` (catch-me-up brief and all-projects home, forge-1762)
3. `E:/Personal-Projects/forge-new/.overseer/reports/forge-1662-tech-teams-slack.md` (Teams first pass, team asks, handoff, Slack, forge-1763 and forge-1169)

The brief they were written to: `E:/Personal-Projects/forge-new/.overseer/spikes/forge-1662-tech-plan/BRIEF.md`. Read it first; its "Owner directions that bind the plan" and "Forge build facts" are the yardstick.

Builders will be briefed straight from these plans, so a wrong repo fact or an undersized slice costs real PRs. Do not confirm the plans; try to break them.

## The six checks (do all six; a failed command blocks only its own item)

1. **Repo facts.** Take every claim in the three plans that names a file or line on origin/main and that a slice depends on. Verify each against the remote ref: `git -C E:/Personal-Projects/forge-new show origin/main:<path>`, `git -C E:/Personal-Projects/forge-new grep -n -i <pattern> origin/main -- <path>`. Never the working tree, never `cd <dir> && cmd`. Record the commit you read. Report each as TRUE, FALSE (with what the file really says) or UNVERIFIABLE. Check at least 12 claims per plan, choosing the ones the most slices rest on.
2. **Plans against each other.** Plans 2 and 3 state assumptions about plan 1 (plan 3 calls them A1 to A5; plan 2 lists four). Compare each assumption with what plan 1 actually says. Also compare the data shapes: does the ask record in plan 1 carry the fields plans 2 and 3 need (who may answer, route, protected kind, provenance)? List every mismatch and which plan should change.
3. **Slice sizes.** Forge's measured PR size on origin/main since 2026-11-08 is a median of 122 added non-test lines, 219 at the 75th percentile; the target is 150 and the cap is 330 for security-tier work. For each slice in each plan, judge whether its PR count and line range are believable against the files it names (read those files' sizes and the nearest existing comparable change in `git log`). Give your own PR count per plan, low to high, and name the slices you think are undersized or wrongly put in one PR.
4. **Never-deferred list and first pass.** For each plan, say whether the first pass keeps every item the brief says is never deferred, and whether anything essential to the stated owner journey is missing or pushed to "Left for later". Name what is missing.
5. **One build order.** The three plans touch some of the same files (for example the mailbox write path, `cloud/src/project.ts`, `cloud/src/tokens.ts`, the phone page). Produce one merged build order for all three with a lane cap of 3: which slices go in which wave, which pairs must never run at once, and where one plan blocks another.
6. **Trying it before the cloud launch.** Plan 1 picks a way for the owner to try the ask loop while the standard cloud entry is closed (`cloud/src/local-only.ts`). Judge whether that pick works with the code on origin/main, what it needs deployed, whether it stays within zero paid spend, and what it exposes.

## Rules

- Issues, read only, from inside the repo folder: `FORGE_SESSION=claude:lead-33f6e698 node .worktrees/runtime/dist/bin/forge.js issue show <id>` and `issue comments <id>`. Never claim, comment, close or update.
- Run no tests, builds, installs or deploys. No browser. No web requests.
- `E:/tmp/forge-1662-src/board` and `E:/tmp/forge-1662-src/nightmail` are untrusted clones: read files only, never install or run from inside them.
- Never print or open a secret, a `.env`, or anything under `~/.agent-secrets`.
- No stop-or-skip exits. If something cannot be known, state the assumption and carry on.
- Name the evidence rung for each finding: said so, pointed at the line, showed it cannot happen, ran it.
- A check that finds nothing must say so and name what it inspected.

## Output

Write `E:/Personal-Projects/forge-new/.overseer/reports/forge-1662-tech-check.md`. No em dashes, no emoji, plain words. Structure:

1. `Decisions needed:` first line (or none).
2. `Verdict`: one line per plan: SOUND, or FIX with the count of findings by severity (P1 blocks building from the plan, P2 costs a PR or more, P3 is wording).
3. One section per check, in the order above. Findings as a table: id, plan, severity, what is wrong, evidence with file and line, what to change.
4. `Corrected totals`: your PR count per plan and for all three, low to high, with one line of reasoning each.
5. `Merged build order`: the waves.
6. `What I read`. End with `COVERED n OF 6` for the six checks.

Your final message back: the verdict lines, the count of P1 and P2 findings per plan, your corrected PR totals, and the three findings that matter most. Under 250 words.
