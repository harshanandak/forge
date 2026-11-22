# Forge way forward (forge-1662)

Lead summary, 2026-11-20. Built from two read-only research reports. Nothing was run live.

- Board and phone research: forge-1662-board-research.md
- Simplification audit: forge-1662-forge-simplify-audit.md

## What Forge is today

- 82 block commands plus 23 assembly commands, about 84,000 non-test lines.
- The work block alone is 46 commands and about 12,600 lines.
- First useful result on one machine: 7 commands today, 4 is possible.
- First shared result on two machines: 12 CLI commands, 2 admin HTTP calls, 1 file edit and 3 owner decisions. About 7 commands is possible with a setup and a join flow.

## What Vercel Board teaches

Board is a message board for agents and people: channels, threads, task claims with leases, dependencies, typed message data, watchers that wake an agent on a reply, scheduled follow-ups, and sync with Slack, GitHub and Linear. Released 2026-11-18, experimental, free for now.

Borrow:
1. The question, its options and the answer live with the work item, and the phone gets a short brief and a link.
2. "Wait for this answer" as one command with a cursor, so an agent wakes on a reply and does not poll.
3. One small fixed format for a question and its answer.
4. A clear waiting state: pending, answered, denied, expired, canceled.
5. One reminder with a limit, not a general scheduler.

Do not copy: channel permissions, reactions, file hosting, three sync adapters, a hosted software factory, or treating a chat reply of "approved" as proof of the owner.

Forge is stronger where it matters: owner approval the server checks, one authoritative write with leases, merge proof from GitHub, and restore that does not revive old permissions. Board's documented approval is a person's reply that an agent interprets.

## Proposed direction

A. Thin first release. The promise is: agents on two machines coordinate issues on one shared project, and the owner decides. Finish the two-machine proof and publish.

B. Move out of the default path, as optional packs: accounts (1,262 lines), competing attempts and participant sharing (650 to 1,200 lines), full local autopilot (1,000 to 1,800 lines), the one-time tracker migration tools (2,129 lines), model routing. Remove the "laws" reporting language (about 300 to 400 lines).

C. Keep shared memory sync, advanced runners and archiving parked until a named user need or a measured limit triggers them.

Order after 0.0.1:
1. One first-run guide with a local or shared choice and a generated list of supported commands.
2. Simpler sign-in (forge-1658, design done).
3. Phone decisions, slice 1: a notice through an app the owner already has, opening today's approval page.
4. Setup and join flows that cut the shared first run from 12 commands to about 7.
5. Phone decisions, slice 2: a small answer mailbox so free-text answers come back to the waiting agent.
6. The optional-pack moves in B, one design at a time.

Never simplify away: server-checked owner approval, the single authoritative write, device and session identity, project scope, GitHub merge proof, verified backup and restore, size limits, truthful result states.

## Owner questions

1. Direction: A+B+C (default), or name what to change.
2. Phone app already in use: GitHub Mobile (default), Telegram, Slack, or ntfy/Pushover.
3. What a chat reply may authorize: ordinary questions only, with resume and other protected actions still needing the Forge sign-in (default); or chat may also approve resume; or everything through the browser.
4. Small cloud mailbox for questions and answers only, lane journal stays on the device: yes (default) or no.
5. How long an ordinary question waits: 24 hours then hold (default), 1 hour, or until canceled. Protected approval links stay at 10 minutes, but a fresh one is created when the owner opens the question.
6. What "ring" means: one push and one reminder (default), repeated urgent alerts, or a real phone call for named urgent cases.
7. Laptop off: answers are stored and work resumes when the laptop is back (default), or add an always-on runner as a separate project.

## Limits of this research

- Read from documentation and source only. No live trial of Board or of any phone flow.
- Vercel's "over 50% of PRs merged" figure is the vendor's claim with no published measurement.
- Line counts for moves are estimates that overlap; they are not additive.
- The two-machine evidence has 168 verdict rows, 6 of them failed; the release proof is not complete.
