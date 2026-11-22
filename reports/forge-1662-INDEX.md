# Owner plan library (forge-1662): research, trials, mocks, plans

Kept by the forge-1662 side chat. Last updated 2026-11-22. Everything here is a local file on the laptop under `E:/Personal-Projects/forge-new/.overseer/`. The folder is excluded from git on the main branch. Since 2026-11-22 the library is published in the Forge repo itself, on the branch `research/owner-layer-2026-11` (owner: "push everything in the repo as research, saved and parked", then "not a private repo, in the Forge repo"). It is a separate branch and not part of main, because main's checks reject the material as it stands: the retired-names guard rejects 25 of the 57 documents, and the code lint rejects the trial source and scripts. Files that list open security faults are not published (see "Not published" below).

Status words: current (use it), superseded (kept for history), raw (reader output, not reviewed line by line).

## Parked on 2026-11-22: resume here

Owner, 2026-11-22T07:19Z: "It's okay, we will refine more once we reach that stage, after the cloud work is done. Park and save the work and research properly."

- Parked until the cloud work is done: the phone ask loop (forge-1761), the brief and all-projects home (forge-1762), team asks, handoff and Slack (forge-1763), the technical plans (forge-1793) and the mock (forge-1794). No lanes were started for any of them.
- Not parked: the cloud work and the do-first fixes, which the main thread owns.
- To resume, in this order: (1) read `reports/forge-1662-tech-corrections.md`; (2) re-check the three plans against the main branch as it is then, because the cloud work will have changed the files they cite (they were written against origin/main 34c6c477); (3) put the six open owner questions at the end of the corrections file to the owner again; (4) get his reaction to mock v8 and refine it; (5) only then cut lane briefs, following the build order in `reports/forge-1662-tech-check.md`.
- Still open: six owner questions (corrections file); the owner has not yet reacted to mock v8.
- Published copy (forge-1795, 2026-11-22): branch `research/owner-layer-2026-11` of the Forge repo, https://github.com/harshanandak/forge/tree/research/owner-layer-2026-11. It holds the reports, mocks, plans, briefs and trial source and logs. The working copy that was pushed is `.overseer/research-public/`; to add later files, copy them there, commit and push that branch. It is a snapshot, not a live mirror. In the published copy the laptop's user folder name is replaced by `<user>`.
- Not published: the issue triage files (`spikes/forge-1780-triage/`, 93 files) and four reports (`forge-1780-inventory-pending.md`, `forge-1780-ranked-issues.md`, `forge-1780-ranked-top.html`, `forge-1780-inventory-old-forge.md`). They list the 72 open security issues with what each fault is, and the security policy says such details stay private until fixed. They are kept on the laptop and in the private repository `harshanandak/forge-research` (branch `research`, working copy `.overseer/research-repo/`).
- Left out of both copies: downloaded packages, build output and the trials' local database folders (`state/`, up to 353 MB each, made by running the trials and not needed to read them). They are in the laptop zip.
- Second copy: `C:/Users/<user>/Reports/backups/forge-owner-plan-2026-11-22.zip` (422 files: every report, mock, plan, brief, triage file and trial source listed below; downloaded packages left out). C: and E: are different physical disks. It is a snapshot; files changed after 2026-11-22 are not in it.
- Triage scripts that were in a temporary folder are now in `spikes/forge-1780-triage/scripts/`.

## Start here

| File | What it is | Status |
|---|---|---|
| reports/forge-1662-final-shape.html | The finished product on one page: four promises, five layers, a day with Forge | current |
| reports/forge-1780-whole-picture.html | What is built, unfinished and pending in 13 areas, with the owner's directions | current, counts from 2026-11-21 |
| reports/forge-1662-plan-pr-count.html | The plan counted in pull requests, careful version | current |
| reports/forge-1780-ranked-issues.md | All 919 open Forge issues in order of value, then speed | current |
| reports/forge-1780-ranked-top.html | The 29 quick high-value items | current |

## Mocks (what the app looks like)

| File | What it is | Status |
|---|---|---|
| reports/forge-1662-shape-mock-v8.html | Latest mock, phone first: 20 screens and states, team and Slack views, first and later markers (forge-1794) | latest, awaiting the owner's reaction; only screen 1 viewed by the lead |
| reports/forge-1662-shape-mock-v7.html | All-projects home, project home, asks, ladder, snooze, sleep window, flow map, two layouts | superseded by v8, NOT final (owner 2026-11-22) |
| reports/forge-1662-shape-mock.html, -v2 to -v6 | Earlier versions | superseded |

## Research

| File | What it answers | Status |
|---|---|---|
| reports/forge-1662-board-research.md | What Vercel Board is and how phone approvals work elsewhere | raw |
| reports/forge-1662-research-r2.md | Second round: mailbox, notifications, Slack, teams (part C) | raw |
| reports/forge-1662-board-x-impressions.md | What people say about Board on X, about 50 posts | raw |
| reports/forge-1662-eval-board.md | Board judged against Forge's 8 needs, by reading its source | current |
| reports/forge-1662-eval-nightmail.md | Nightmail judged the same way | current |
| reports/forge-1662-eval-building-blocks.md | Recommended stack: Durable Object, alarms, web push, sign-in, Slack | current |
| reports/forge-1662-remote-runners.md | Agents running on cloud machines | raw |
| reports/forge-1662-forge-simplify-audit.md | Where Forge can be simpler | raw |
| reports/forge-1662-way-forward.md | Lead summary of 2026-11-20 | superseded by the final shape |
| reports/forge-1662-shape-r1-*.md (6 files) | Round 1 on shape: blocks and timelines, decision models, decisions, front desk, oversight tools, rules and laws | raw |
| reports/forge-1662-shape-r2-owner-summary-style.md | How to write summaries for the owner | raw |
| reports/forge-1662-shape-r3-owner-workflow.md | The owner's day and workflow | raw |
| reports/forge-1672-research.md | Phone app as an installed website | raw |
| reports/forge-quality-vs-board.md | Forge quality against Board (forge-1770) | current |

## Trials (things that were run on the laptop, nothing deployed)

| File | What was proven | Spike folder |
|---|---|---|
| reports/forge-1761-board-on-do.md | Board's engine runs inside a Cloudflare Durable Object locally; 86 of Board's own checks pass | spikes/forge-1761-board-on-do |
| reports/forge-1761-board-slack.md | Board's Slack sync runs in the same object against a fake Slack; 20 of 20 replies woke the agent | spikes/forge-1761-board-slack |
| reports/forge-1761-wait-trial.md | Waiting for an answer and waking on it | spikes/forge-1761-wait-trial |
| reports/forge-1761-board-copy-audit.md | What can be imported or copied from Board and under what licence | none |

Source clones read for these, untrusted and read-only: `E:/tmp/forge-1662-src/board`, `E:/tmp/forge-1662-src/nightmail`.

## Designs and technical plans

| File | What it is | Status |
|---|---|---|
| reports/forge-1658-signin-design.md, -r2.md | One-command sign-in | current |
| reports/forge-1672-slice1-design.md | Phone app slice 1: the owner session | current, PR 730 merged |
| reports/forge-1662-tech-corrections.md | START HERE for building: 15 binding corrections, corrected size (72 to 110 PRs), build order, 6 owner questions | current |
| reports/forge-1662-tech-check.md | Independent check of the three plans by GPT-6.1 Sol: 10 blocking faults, merged build order in 27 waves | current |
| reports/forge-1662-tech-ask-loop.md | Technical plan: phone ask loop (forge-1761) | current, read with the corrections |
| reports/forge-1662-tech-brief-home.md | Technical plan: brief and all-projects home (forge-1762) | current, read with the corrections |
| reports/forge-1662-tech-teams-slack.md | Technical plan: Teams first pass, team asks, handoff, Slack (forge-1763) | current, read with the corrections |
| repo docs/work/2026-11-10-teams-phase1/plan.md | Teams phase 1 plan, in the repo | current |

## Inventory and triage (forge-1780)

| File | What it is |
|---|---|
| reports/forge-1780-inventory-built.md | Everything built, by reading the code |
| reports/forge-1780-inventory-cloud-team.md | Cloud and teams: state and gaps |
| reports/forge-1780-inventory-guards-tools.md | Guards and tools |
| reports/forge-1780-inventory-old-forge.md | 80 old Forge features compared |
| reports/forge-1780-inventory-pending.md | All pending issues |
| spikes/forge-1780-triage/ | Reader briefs, inputs, verdicts and ranked.json |

## Where the decisions are

The issue is the record. Owner decisions and lead answers are comments on forge-1662 (plan), forge-1761, forge-1762, forge-1763 (phases), forge-1754 (open data), forge-1764 (parked ideas), forge-1780 (triage). Forge memory device/note-1035 carries the features-first direction.
