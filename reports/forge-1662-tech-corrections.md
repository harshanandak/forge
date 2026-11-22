Decisions needed: 6 owner questions, listed at the end. Each has a default; silence means the default.

# Corrections that bind the three technical plans (forge-1793)

Lead decisions, 2026-11-22. Read this together with:

- `forge-1662-tech-ask-loop.md` (phone ask loop, forge-1761)
- `forge-1662-tech-brief-home.md` (brief and all-projects home, forge-1762)
- `forge-1662-tech-teams-slack.md` (Teams, team asks, handoff, Slack, forge-1763 and forge-1169)
- `forge-1662-tech-check.md` (independent check by GPT-6.1 Sol, high effort, against origin/main 34c6c477)

The three plans were written in parallel by Opus and could not read each other. The check found 10 faults that block building (P1) and 15 that cost a PR or more (P2). No plan was rewritten. Where a plan and this file disagree, this file wins. Where this file is silent, the check's "What to change" column wins over the plan.

Evidence: the check verified repo claims by pointing at the line (rung 2). Nothing was run. PR counts are estimates (rung 1).

## Binding rules

1. **One place accepts an answer.** The project's own cloud authority (the Project object) checks the person and commits the answer in one step with no wait in between. The mailbox running Board's engine is a projection: delivery, history, Slack. It never decides who may answer. This replaces the "membership mirror" in the Teams plan (check X-T1) and applies to handoff and removal too.
2. **A device token is not a person.** An agent's device token may create an ask, comment on it and withdraw it. A human answer needs a verified person session (phone or web) or, for ordinary asks only, a linked Slack account. An answer typed in the terminal is kept only as a "device answer": allowed for ordinary asks in a single-owner project, labelled as not proven to be a person, refused in a team project and refused for every approval (check X-1; owner question 1).
3. **Approvals get their own consumer.** Today's lane path consumes a relayed reply against a pending request; it cannot consume an already-approved phone record, and the browser approval page was removed in PR 701. Build a separate verified-session approval decision and consumer in Project: grant or deny, exact operation and scope, requester token, device and session, ask digest, current control generation, single use. Fresh sign-in proof is required; no proof means refusal. Teams adds the current member and role check at the same point (check R-A1, R-T1).
4. **Commands are dispatched per block.** Ask operations live in their own manifest, so appending names to the work list is not enough. Slice 1 of the ask loop adds a block-aware dispatcher with the ask manifest, input and output validation, context and effects. Work dispatch stays unchanged (check R-A2).
5. **Board is imported through one maintained adapter entry.** The trial imports three private Board files and patches two build files. The product bundles one adapter entry that exports everything needed, pinned at `@vercel/board` 0.54.0, with licence notices. Hosted CI exercises the production import path and Board's own conformance checks. If this proves unworkable, Forge's own mailbox replaces it (about 2 PRs, per the plan) (check R-A3).
6. **One ask and answer contract, frozen first.** Ask slice 1 fixes a versioned contract that already carries what the brief and Teams need: stable person ids, who may answer as a set, route (personal or team), current target, semantic kind kept apart from protected operation (computed by the server from the operation, never a flag an agent sets), verified identity and proof, requester binding, accepted time and sequence, and room for member epoch and Slack ids. One mailbox read and list API serves the home; the home never reads Board tables (check X-T2, X-H2).
7. **The home reads current cloud facts through typed reads.** For a cloud-bound project the laptop's tracker is not current. Add bounded typed reads and a feed at Project for the admitted work facts, plus a local adapter for unbound projects. Add a registry-list capability that returns both the device registry id and the shared project id and pages past eight projects. Test a bound project that still has an old local tracker (check R-H1, R-H2).
8. **The since-last-look marker is written only by the signed-in person.** It lives outside the namespace that device tokens can write, behind a typed session-only operation (check N-H1).
9. **Summaries carry citations per line.** Each summary line has its own list of cited events; a missing or unknown citation rejects that summary. The page says plainly that a citation shows the event exists, not that the sentence is fair (check N-H2).
10. **Defaults taken for you and undo are a separate record.** The original human answer stays immutable. A provisional-action record has execute, acknowledge, reversal-request and reversal-result steps, with refused and uncertain states. It is built last (wave 25) (check X-H1).
11. **Cloud code reaches team code by injection.** Public membership and storage contracts live in public code; team code implements them; a team-owned composition injects the implementation. The team boundary test is not weakened or exempted (check R-T2).
12. **A restore never brings a person back in.** Restore marks every non-owner membership inactive and the owner approves each again. Old tokens stay dead. Test a fresh login as well as an old token (check N-T1).
13. **Backup covers both objects.** The ask loop's recovery slice defines the export and restore unit across the Project object, the mailbox and its outbox: restore cancels open asks, drops push subscriptions and never resends old side effects. One hosted round trip is in the first pass (check N-A1).
14. **Say only what was measured about phone alerts.** Forge records sent, failed or uncertain for each reminder step. "Loud" and "replaces the old notification" are requests to the phone until measured on a real iPhone and Android phone (check N-A2).
15. **Trying it early uses a separate rehearsal copy.** A distinct Worker with its own storage, its own sign-in settings, a fresh unbound test project and a written list of the routes it serves. The standard entry stays closed. It serves more than the phone pages (device login, typed commands, admin routes with their own token checks), so it is "a separate test copy", not "only your phone session can open it". Free plan only; Board's size against the free limits is unmeasured. Each deploy needs the owner's yes (check P-A1).

## Corrected size

| Part | Plan said | Check says | Use |
|---|---|---|---|
| Phone ask loop | 19 to 21 PRs | 25 to 39 | 25 to 39 |
| Brief and all-projects home | 17 to 21 | 25 to 36 | 25 to 36 |
| Teams, team asks, handoff, Slack | 13 | 22 to 35 | 22 to 35 |
| All three | 49 to 55 | 72 to 110 | 72 to 110 |

Cloud usable by the owner is outside these numbers. The lead's earlier first-pass estimate for these three parts (65 to 85) was too low.

First thing the owner can try on the phone: after the ask loop's waves 1 to 6, which is 14 to 22 PRs, and after the rehearsal copy is deployed with his yes.

## Build order

The check's "Merged build order" (27 waves, lane cap 3) is binding, with its list of pairs that must never run together. Most waves use one or two lanes because the steps share files. Home and Teams start side by side at wave 13, after the ask loop's first pass. An empty lane slot is for independent work such as the do-first fixes, not for a second writer on the same files.

Teams scope note: this is a first pass of the Teams epic (forge-1169). The attempt queue, shared lane capacity, offline cache and shared memory wait, so the epic stays open when this merges.

## Owner questions (plain words, default first)

1. **An answer typed in the terminal.** A: counts for ordinary questions when you work alone, marked "from the terminal, not proven to be you"; never for approvals, never in a team (default). B: phone or Slack only, for everything.
2. **Trying the phone asks before the cloud launch.** A: on a separate test copy of the cloud (default). B: open the phone pages on the main cloud. C: wait for the launch. This is the same question the main thread holds as Q-forge-1672-deploy.
3. **Which projects appear on the phone.** A: only the ones you switch on (default). B: every project on the laptop. C: every project except the ones you switch off.
4. **Who may approve a publish, merge or deploy that a teammate's agent asks for.** A: only you (default). B: that teammate. C: any member except that teammate.
5. **Who may invite and remove people.** A: only you (default). B: any member.
6. **After a restore, people other than you must be approved again before they can sign in.** A: yes (default; safer). B: no, restore brings back the member list as it was.

Smaller defaults taken without asking, change any by naming it: phone stays signed in 15 minutes; the lock screen shows counts only, no question text; an unanswered ask expires after 24 hours and the work stays stopped; you can still answer after handing an ask on, first answer counts; Slack is linked by sending a one-time code to the Forge bot; an ask moves to your backup at the 15 minute reminder; summaries are rewritten every 30 minutes only when something changed; "new since you left" resets when you open the project; a default can be undone for 24 hours; finished work is shown by name, with no before and after numbers in the first pass.
