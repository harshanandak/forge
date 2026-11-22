# How the owner runs long projects with one lead agent, and what Forge Desk must do for him

Research round 3 for forge-1662. Source: his own typed messages, his answers to question cards, the lead thread's replies, the overseer files and Forge memory. Quotes are verbatim, typos kept (he dictates by voice). Times are UTC unless marked IST (his local time, UTC+5:30). Change numbers are replaced by "change A", "change B". Anything that looked like a secret or an account id is left out.

This report builds on round 2 (forge-1662-shape-r2-owner-summary-style.md) and does not repeat its quote lists.

## 1. Method and limits

**Files read (all streamed line by line with node scripts kept in the session scratchpad):**
- 285 transcript files in folders whose name contains "forge" (about 2.0 GB): 43 under `.claude/projects/e--Personal-Projects-forge`, 236 under `.claude_sub2/projects/E--Personal-Projects-forge`, 6 in other forge folders.
- 30,132 typed-text user entries in total. 16,006 were pull request watch notices and 9,154 were delegated-task relays. After dropping relays, hook output, compaction summaries, skill text and lead-to-builder briefs, and removing duplicates across forked files, 924 remained. Dropping text that speaks of "the owner" or "the lead" in third person left 816.
- The lead is one T3 thread that ran across five Claude session files on two accounts (33f6e698, 73e5d9e1, 075251b0, f134d6a7, 47cf8802; the forks repeat the same history). Keeping that thread plus six small sessions where he typed directly gives **689 owner messages from 2026-10-03 to 2026-11-21**, on 38 distinct days.
- 66 question cards he answered in the lead thread, holding 157 answers (these are tool results, not typed text, so they are counted separately).
- 26,987 distinct text entries of the lead thread (owner and lead), used to see what he read before and after each message.
- GitHub: the list of 652 merged changes in the Forge repository (2026-10-18 to 2026-11-21), read once.
- `.overseer/`: inputs.md (24 numbered lead standing rules, about 40 open owner items), closed.md, release.tsv (169 rows, 41 backup copies), ledger.jsonl (1,352 events, 187 overseer suggestions), gates.tsv (277 rows), 42 overseer reports from 2026-11-12 to 2026-11-21.
- Forge memory (device level, scopes general and forge): about 30 notes read in full.
- The mock forge-1662-shape-mock-v4.html (read only).

**Limits:**
- Messages he typed into Codex threads are not in these files. Codex builders also do not appear in the activity counts, so "agent active" time below is a floor.
- A visit is a run of messages with no gap over 45 minutes. A different cut changes the counts a little, not the shape.
- I classified inputs with keyword rules, then corrected by reading every message of the busiest two weeks. Treat class counts as plus or minus 10 percent.
- A few relays may remain (pasted lead text). I removed the ones I found by hand.
- He often answers inside a question card or a quote comment (67 of his 689 messages comment on a quoted sentence). Those are short and depend on what they quote.
- I could not tell from the files what screen he looked at first. "What he saw first" below means the last lead message before his first message of the visit.
- He says one lead merged "around 500+ PRs under a week" (2026-11-21). In the Forge repository I count at most 225 merges in any 7-day window (2026-11-07 to 2026-11-14) and 302 in the 10 days from 2026-11-03. The 500 may include other projects or a longer span. I could not confirm 500 in one week from this repository.

## 2. Findings

### A. Rhythm

**When he writes (689 messages, hour in IST):**

| IST hours | Messages |
|---|---:|
| 00:00 to 02:59 | 53 |
| 03:00 to 09:59 | 6 |
| 10:00 to 13:59 | 197 |
| 14:00 to 18:59 | 221 |
| 19:00 to 20:59 | 136 |
| 21:00 to 23:59 | 76 |

He sleeps roughly from 01:00 or 02:00 to 10:00 IST. The two peaks are late morning (11:00 to 12:59 IST, 128 messages) and evening (19:00 to 20:59 IST, 136).

**Visits:** 155 visits on 38 days, about 4 a day.

| Measure | 10th pct | 25th | Median | 75th | 90th | Max |
|---|---:|---:|---:|---:|---:|---:|
| Messages per visit | 1 | 1 | 2 | 5 | 10 | 36 |
| Visit length (minutes) | 0 | 0 | 8 | 40 | 84 | 167 |
| Gap before the next visit (hours) | 1.0 | 1.3 | 2.6 | 8.5 | 12.9 | 290 |
| Time between any two messages (minutes) | 0.6 | 1.4 | 5.6 | 38 | 184 | |

- 56 visits (36 percent) are a single message. 33 visits last over 30 minutes.
- 59 gaps are 4 hours or more; 37 of those are 8 hours or more (nights and workdays).
- Message length: median 78 characters, 75th percentile 164, 90th 332. Half his messages are one line.

**How long the agent runs alone:** across the 59 gaps of 4 hours or more, Claude-side agents were active in 16 percent of the minutes (39 of the 59 gaps had at least an hour of activity). The longest stretches were 10.8 hours of activity in a 16.6-hour gap (2026-11-14) and 10.7 in 15.9 (2026-11-03). Merges tell the same story better, since builders run on Codex: **310 of the 652 merges (48 percent) happened while he was away 8 hours or more.** Up to 2026-11-08 an 8-hour absence produced a median of 2 merges; from 2026-11-09 to 2026-11-14, after the size rule, the overseer and the pending list, each such absence produced 13 to 31 merges. From 2026-11-15 on it dropped to 1 to 12, because the remaining work needed his sign-ins and approvals (see F).

**Sleep handoffs.** He announces leaving in 9 messages, always with the same two asks: keep going on defaults, and ask what you need now. "If you need any more questions that needs to be answered, ask now. I won't be available till morning." (2026-11-09). "now I'm going to sleep and you can work on the pending things ... Otherwise park those things for me when I wake up" (2026-10-25). "I would like to see most of the work get done by tomorrow morning so work on it properly do quality work. Throw away the code if something is not right." (2026-11-20).

**Three visits after a long gap:**

*Visit 1, 2026-11-15 05:55 to 06:23 (11:25 IST), after 16.6 hours away.* What he saw first: a lead message about a security review returning two P1 findings, with file and line numbers, and a new veto item. He wrote "whast the progress how far are we". The lead answered with "Decisions needed: 3", "15 lead calls (V31 to V44) are on the veto list", "about 5,520 of an estimated 8,000 non-test lines are merged, roughly 70 percent", and a release checklist table. He did not react to any of it. He asked three more questions in six minutes, each one something the report had not said: "how much more time for good stable realease of 0.0.1", "by when can we shift our forge flow from local to cloud for intyernal projects", "find way to amke it faster". The lead gave "about 2 days" and "about 2.5 days from now, maybe 3", and then a question card with three speed-up options, which he answered. He also answered one card on a stall watcher ("no i have account limits temp so i cant change that maybe in future"). He stayed 28 minutes.

*Visit 2, 2026-11-18 07:55 (13:25 IST), after 11.6 hours away.* What he saw first: eight lead messages in 17 minutes, each ending "Decisions needed: none", naming six open changes, five issue ids and "Seven lanes are working". He wrote one message: "Forge currently has too many open PRs, which is always a wrong thing. We have already set up the things last time ... Either they should be closed or they should be open. The drafts shouldn't be there for more than a little time." The lead closed six stale drafts within a minute. He left. That evening he made it a number: "we shoudl never ahve more than 4 open open prs its tooeasy to get lost with 6 with one lead" (2026-11-18). It became lead rule 19. He stayed about one minute.

*Visit 3, 2026-11-20 06:05 to 08:10 (11:35 IST), after 14.8 hours away.* What he saw first: "Decisions needed: source sign-ins, A `READY` or B hold (default) ... The rehearsal waits on your `READY`." Nothing had run for hours: sign-in codes issued at 23:02 had expired ten minutes later while he slept. He did not answer the waiting item first. He sent four directions in five minutes (pick models per task; make sign-in simple; "we had a lot prs wromngly times and wokred and re parked adn closed which is time and effocrts wasted"; release fast because a competitor just launched), then a complaint ("why do we need to launch this from admin permissions that is bad that is red flag"). The lead replied "Work was stopped for 131 minutes (03:54Z to 06:05Z) waiting on your sign-in approval; nothing ran in that time", answered the admin question, filed both requests as issues within four minutes, and posted an audit of wasted work (79 items, 187 PR-open hours lost to design flaws found only at the merge gate) with three new standing rules. He approved sign-ins through two cards, gave a new product idea (a phone app to answer decisions), switched models to start research, rejected approval links ("Why does it need a separate link for the approval?"), answered a decision page, and left after about two hours and 18 typed messages.

### B. The first two minutes back

**What he opens with.** The first message of the 59 visits after a gap of 4 hours or more:

| First message | Visits |
|---|---:|
| New direction or idea for the work | 21 |
| Answer to something waiting (a letter, "defaults", a quote comment) | 13 |
| "continue" or similar | 10 |
| Status ask ("progress", "how far", "can we release now?") | 8 |
| Complaint about pace or process | 7 |

So he does not always ask for status. More often he arrives with something on his mind, or answers what waits. The brief must be there without being asked, and must not block him from typing.

**Follow-up questions right after a status report.** Each one marks something the report left out:

| Gap in the report | Count | Dated quotes |
|---|---:|---|
| Time to the goal, as a date | 6 | "how much more time for good stable realease of 0.0.1" (2026-11-15); "by when can we shift our forge flow from local to cloud" (2026-11-15); "how long until 0.0.11 is ready to release?" (2026-11-21); "by when are going toi release teh cloud how many prs awway?" (2026-11-21); "How close are we to deleting the old Forge" (2026-10-20); "Are we close to changing our codes from the old one to the new thing? If not, what more is pending?" (2026-10-21) |
| Work that stopped or was paused without a word | 4 | "I haven't got any update on it" (2026-10-22); "also i still didnt get any replyu or update on our workflow resrach" (2026-10-23); "What happened to the research I have asked to do on Twitter?" (2026-11-16); "what are u waiting for" (2026-11-08) |
| What is abnormal, and why it is slow | 4 | "i think somethings wring ... rivet shoudlnt be stuck for so long" (2026-10-31); "whya re tehse comamnd takings so long" (2026-11-01); "I feel teh speed of prs mergeing has slaowed down" (2026-11-16); "we ahvent really moved forward s far today" (2026-10-20) |
| How to go faster, with options | 3 | "find way to amke it faster" (2026-11-15); "would changuing teh terra to sol make it afster" (2026-11-01); "is our release speed going to increase if we drop the release of 0.0.1 locally" (2026-11-20) |
| What a number or id means | 4 | "What is Forge955? Elaborate so that I can take a decision on it" (2026-11-07); "Can you elaborate and explain what the ratios are, instead of just numbers" (card, 2026-11-11); "You can't just randomly give me numbers and assume that I can understand what information is behind those numbers" (card, 2026-11-11); "are we talking about ram?" (card, 2026-11-13) |
| What exists now and whether it is good enough | 2 | "Give me a clear understanding of the capabilities of Forge that we have built until right now so that I can see ... whether it is good enough" (2026-11-04); the four-line spec of 2026-11-21 below |
| Cost and limits used | 2 | "i will do it but how did we use up so many limits" (2026-11-17); "everything that matters is how much of a limit we have in our plan" (2026-10-23) |
| Whether the planned work is still worth doing | 2 | "Why do we need to build PR status, etc., when those things are already being built and can be used from T3 Code" (2026-10-20); "dont we have more important features taht adds large value" (2026-11-05) |

Visit 1 above is the clearest case: a report full of line counts, veto counts and a table, followed by three questions about time and speed.

His own statement of the need, 2026-11-21: "The user would have planned some XYZ features and when he comes he would be expecting: what the progress is, how, where, we are, what has been done, how we are going to move forward, whether there are any issues ... The clean summary would be shown to him. It will be under 3 to 4 lines."

### C. His inputs

**Busiest two weeks:** 2026-10-16 to 2026-10-29, 339 messages (half of all 689). Classified by keyword rules and then corrected by reading each one:

| Class | Count | Share | Example |
|---|---:|---:|---|
| New idea (product or design) | about 95 | 28% | "make it in a way that user can select even 1 or upto 4 max" (2026-10-23) |
| Direction for the current work | about 85 | 25% | "[change A] and [change B] are almost ready to merge also chek on them" (2026-10-21) |
| Approval or refusal | about 48 | 14% | "1.A, 2.A, 3.A, 4.A" (2026-10-27); "deafults" (2026-10-25) |
| Question | about 33 | 10% | "why is gpt 6 sol used when 6.1 is better" (2026-10-18) |
| Standing rule | about 30 | 9% | "dont use any types in ts" (2026-10-18); "coding standards shudl be in coding standards not in agnets.md" (2026-10-18) |
| Correction of behaviour (one-off) | about 25 | 7% | "u have gone in a plan loop" (2026-10-22); "close teh unecesary backend process" (2026-10-22) |
| Complaint | about 22 | 6% | "Whatever you are giving me is sounding like jargon and/or simple baby stuff." (2026-10-25) |

Across all 689 messages: 60 are one-word approvals or letter lists, 12 are "continue", and 67 are comments on a quoted sentence of the lead's text.

**Where each class should land, and whether it did:**

| Class | Should land in | Did it? |
|---|---|---|
| Direction | The running lead thread | Yes, by construction. |
| Approval or refusal | A decision record, then the work resumes | Mostly. The pending list in inputs.md became the record from 2026-11-12. Before that, answers sat in chat; on 2026-10-19 the lead kept re-listing nine answered-by-default items and he called it noise (memory note 52). |
| Standing rule | A project or device rule, with his words and date, at the scope he meant | Mostly yes, in memory: no `any` types (note 523), no tests on the laptop (note 712), throw away instead of patching (notes 230, 1007), size rule (note 873), plain words with ids in brackets (note 933). Some churned: "dont use fable" (2026-10-24), then "take fabel helps" for the overseer (2026-11-11), then Fable retired again for cost (note 968, 2026-11-17). "dont use max high or ectra high is more tha neough" (2026-10-23), then "run the initial rounds of testing with Terra 6.1 at max" (2026-10-27). Nothing showed him that a new rule contradicted an old one. |
| Correction of behaviour | The running thread; promoted to a rule when it repeats | Late. Open-change sprawl was corrected on 2026-10-18, 2026-10-19, 2026-10-21, 2026-11-09 and 2026-11-18 before it became a hard limit of 4. The change description format was set on 2026-10-18 and lost again by 2026-11-04: "I feel like we are losing the format on how we need to write a PR description." |
| New idea | A new item in the plan (an issue under the right parent), not started, without diverting current work | Usually filed fast (sign-in and wasted-work issues filed 4 minutes after he asked on 2026-11-20). But ideas compete with current work: on 2026-11-11 he had to say "dont get diveretd". And research he asked for twice (the X feed, 2026-10-28 and 2026-11-16) was dropped silently in between. |
| Question | Answered in place; if it shows a gap in the brief, the brief changes | Answered. The brief rarely changed until the overseer started writing rules (see E). |
| Complaint | A correction plus an overseer item that checks for repeats | From 2026-11-12 yes (ledger.jsonl). Before that, no. |

He asked for this routing in his own words on 2026-11-21: "when a thing has been said thinking whether that should be a decision made for this particular thread or for a particular period or for a particular project or for a particular device and how it needs to be implemented should that be a decision or a rule".

### D. Long projects

**Structures in use, and who asked for them:**

| Structure | Asked for by him? | Evidence |
|---|---|---|
| One lead thread that dispatches builder threads | Yes | "we wil be having mutiple worktreess and lanes buuilt proeplry" (2026-10-16); "only have a lane builder where you can say person API and get it moved" (2026-11-03) |
| Issues with parents, sub-issues and tags | Yes | "our issue management shoudl be betetr with main issue and sub issues to not blot teh the size" (2026-11-02) |
| Size limit per change | Yes, as a soft rule | "We can't have a hard cap. It could be 10% either way." (card, 2026-11-11) |
| Limit on open changes | Yes, after four repeats | "we shoudl never ahve more than 4 open open prs" (2026-11-18) |
| Overseer, an independent reviewer every 6 hours | Yes | "consider as a overlooker in session threds athat cheks every 6 hours on teh progression and gives susugetion if thinsg are going wrong" (2026-11-11) |
| Release checklist (release.tsv) | No, the lead built it; he asked for the release | 169 rows, 41 backups in four days |
| Merge gates, gate log, hooks that refuse actions | No, lead and overseer | 277 gate rows; three guard hooks |
| Pending owner list and 24 standing rules (inputs.md) | No, overseer suggestion forge-S20 | 67 KB, re-read after every compaction |
| Heartbeat every 30 minutes | No | slowed to 120 minutes on 2026-11-14, then deleted on 2026-11-15 |
| Question cards for decisions | Yes | "ask me blcoked deciosn using question tool" (2026-11-13) |

**What he stopped trusting:**
- Custom watchers: "with t3 code watcher and claude monitor i feel this is less of an impotance or priority to ahve our own watcher" (2026-10-19).
- The heartbeat: "why cant overseerer do this think this is a improvemnt and overserer shoudl found this itself" (card, 2026-11-14); "im not sure if ittsa adding value aprt from overseer" (card, 2026-11-15).
- The overseer's own threads: "they are starting a new thread instead of teh projectrs runing thread which quicly piles to many new uncesary thread outside teh project" (2026-11-12).
- Built-in agent memory: "We should not use memory of agents. We should use Forge memory" (2026-10-25).
- Approval links: "link is bad in my opmnion no maater what link is not teh right way and if they are alredy in teh chat adn then text message shoud suffice" (2026-11-20).
- The lead's own status script: "Why are you using the `status` command?" (2026-10-20).

**What broke when context ran out or sessions restarted.** The lead thread was compacted 175 times in seven weeks (up to 11 a day) and moved between providers 22 times; T3 restarted 6 times mid-work. What went wrong:
- Paused work was forgotten: "Nothing was running, and that's on me. The last workflow research run finished at about 11:57 today. After that I paused it ... and never restarted it or told you." (lead, 2026-10-23).
- The lead went idle with work ready: "I sat idle overnight with [change A] ready to merge." (lead, 2026-10-20).
- Decided items came back: on 2026-11-17 a report re-asked a backup choice he had settled the day before (inputs.md item S7-reading).
- A question card held the whole turn for 8 hours while one change sat green and another went red (inputs.md item stop-8h, 2026-11-18 to 2026-11-19).
- Account limits stopped the lead 5 times in one week, 8 hours 23 minutes lost (card D28, 2026-11-15).

What survived was state written to files: the pending list, release.tsv, the ledger and memory. From 2026-11-12 the lead re-read them after every compaction (rule from overseer suggestion forge-S20).

**What he repeated more than twice** (messages on distinct days, whole period):

| Theme | Messages | Days | First and last |
|---|---:|---:|---|
| Keep it simple and easy, not bloated | 65 | 24 | 2026-10-04 to 2026-11-21 |
| Which model to use for which job | 50 | 22 | 2026-10-16 to 2026-11-21 |
| Cost and usage limits | 38 | 18 | 2026-10-16 to 2026-11-21 |
| Research and borrow proven work first | 34 | 17 | 2026-10-19 to 2026-11-21 |
| Progress, how far, by when | 22 | 15 | 2026-10-16 to 2026-11-21 |
| Do not load my machine; let CI test | 21 | 14 | 2026-10-16 to 2026-11-21 |
| Merge faster, too many open changes | 12 | 8 | 2026-10-18 to 2026-11-18 |
| Throw away and redo, no patchwork | 11 | 9 | 2026-10-20 to 2026-11-20 |
| Agents should do every step, not me | 8 | 7 | 2026-10-18 to 2026-11-19 |

The overseer ledger shows the agent side of repetition: 45 "recurred" events across its 187 suggestions, the same problem coming back after a fix.

### E. Summaries

**How the status format changed, and the quote behind each change:**

| Date | Change | Trigger |
|---|---|---|
| 2026-10-03 | Reports open with "Decisions needed:" and end questions with lettered choices and a default (note 342) | Owner preference recorded on that date |
| 2026-10-18 | Change descriptions get before and after numbers and proof | "pr descrition also need to be simple ina udnersatdble way and it shoudl have before after metrics proeplrty fro imoroivemnts and proofs" |
| 2026-10-19 | Stop re-listing open defaults in every reply (note 52) | He called the repeated D1 to D9 list noise |
| 2026-10-23 | Plain-language rewrite skill on every report | "Also I hope you would have used the unslop skill to write this and explain this in a better way" |
| 2026-10-24 | Absolute, clickable paths; no "see the doc" (note 545) | He pasted back a summary pointing to "the plan (2,400 words)" and wrote "its not opening tehse" |
| 2026-10-25 | Balanced, honest, with real examples | "Whatever you are giving me is sounding like jargon and/or simple baby stuff." |
| 2026-11-08 | Absolute numbers, not bare percentages; directional decisions only, 5 to 10 at a time (notes 792, 797, 801) | "Owner approves DIRECTION only ... he is not technical" (owner, relayed from a sibling project) |
| 2026-11-11 | Every status opens with the open decisions, most blocking first (overseer forge-S2) | Card answers: "You can't just randomly give me numbers and assume that I can understand what information is behind those numbers" |
| 2026-11-13 | Names in plain words, ids only in brackets (note 933) | His answer to question D5 |
| 2026-11-13 | Decisions go in question cards | "ask me blcoked deciosn using question tool" |
| 2026-11-14 | One line for the most blocking item plus a count; veto items listed once (rule 1) | Overseer finding that statuses buried the blocking item |
| 2026-11-15 | Show the release checklist and any date with its arithmetic (rule 5) | His "how much more time" and "by when" questions that morning |
| 2026-11-20 | Approvals by chat text, no links | "text message shoud suffice not link" |
| 2026-11-21 | Home speaks in outcomes and value; timeline explains, not logs | "Humans care about output not the numbers"; "the timeline was stupid"; "the summary and all those things look too AI" |

**What he accepted without comment.** Lettered choices with a stated default: 98 of his 157 card answers (62 percent) took the recommended option, and 60 typed messages are bare letters or "defaults". Tables with before and after numbers (the wasted-work audit, 2026-11-20; release checklist tables). Estimates that show their arithmetic (2026-11-15, where he asked follow-ups about the goal, not about the method).

**Agent-speak he rejected or did not understand:**
- Role labels: "Planned: owner task brief. Implemented: Codex implementation worker. these need to be more clear with exact model name" (2026-10-21).
- Invented terms: "i dont undertsand teh concept of cahirman and checker and why uis thereca budget" (2026-10-23); "in dont undertasn teh raters thing" (2026-10-23); "is kernel the right word to use" (2026-10-16); names that "don't match the vibe" (2026-10-22).
- Bare ids: "What is Forge955?" (2026-11-07); "work-285 i feel this naming system is wrong as it shoydl be project name" (2026-10-21).
- Numbers without meaning: "explain what the ratios are, instead of just numbers" (2026-11-11).
- System strings typed back to the lead as complaints: "Lande approval not available" (2026-11-20), "Device login invalid_request" (2026-11-13).
- Output written for an agent: "the outputs and information that are being shown to the user are shown as if they are being shown for an agent" (2026-11-21).

Measured on the lead's side: change numbers appear in 78 to 93 percent of the lead's messages each week from week 2, commit hashes in 53 to 74 percent, and value words (faster, cheaper, saves, users can) in only 3 to 6 percent.

**Outcomes versus activity (his 2026-11-21 rule), earlier evidence:**

For outcomes on the home view:
- 2026-10-18: before and after metrics with proof in every change description.
- 2026-11-04: "Give me a clear understanding of the capabilities of Forge that we have built ... whether it is good enough".
- 2026-11-05: "Don't try to go for perfection. Try to go for the best value"; "dont we have more important features taht adds large value".
- 2026-11-07: he pasted a before and after table back (102,043 ms to 89,854 ms) with "still huge need to imprve more". He judged the outcome, not the work.
- 2026-11-02: "check which adds most value and gets us ecloser to release and sppeeds upda our flow".

Against, or rather a second place for activity:
- He measures agent throughput by merges himself: "we ahve alsomotmerged 250+ prs in a single thread" (2026-10-19), "we havent merged much work in last few days" (2026-11-18), "the speed of prs mergeing has slaowed down" (2026-11-16), "500+ PRs under a week" (2026-11-21).
- His analytics tab (2026-11-21) lists merge time per change, average lines, CI failures and blockers.

Reading: outcomes belong on the home view; activity belongs in an analytics view, compared with normal, as a health signal. He never asked for activity counts on the home view, and he complained twice that activity reports hid lack of progress ("we ahvent really moved forward s far today", 2026-10-20).

### F. Waiting

**How often work waited on him:**
- 91 items in the overseer ledger were routed to him (56 lead calls open for veto, 16 items where the lead took the default, 9 veto items, 10 direct questions). Only 26 got an answer: median 3.6 hours, 90th percentile 11.3 hours, longest 18.8 hours. **65 were never answered and ran on their default.** closed.md records that "Veto items V1 to V30 lapsed without an owner veto."
- Real stalls caused by him being away: 131 minutes on 2026-11-20 (sign-in approval), about 7 hours the night before (sign-in codes expired 10 minutes after issue while he slept), 8 hours on 2026-11-18 to 2026-11-19 (a question card held the turn), and about 1.5 days for a sign-in account id on 2026-11-11 ("I can't send you the clerk thing right now. I'm on my phone and I'm going to sleep.").
- From 2026-11-15 the merges during his nights fell from 13 to 31 to between 1 and 12, as the release work moved to steps only he could do.

**Questions with an obvious default he always took:** merge a change once its gates pass; accept a size overrun within the leeway (V32 to V54, all lapsed); rerun a flaky test once; simplify or park at review round 2; update a branch; which model runs a lane (once routing existed); close stale drafts; keep pacing evaluations one at a time. In cards, 98 of 157 answers were the recommended option.

**Questions that were truly his:**
- His identity and accounts: sign-in approvals, account ids, OAuth app setup, token rotation ("Rotated", 2026-11-16), which repositories an app may read ("its okay to tets on all my re[pos", 2026-11-14).
- Money: the paid Cloudflare plan ("i ahve paid plan of cloudlfare now", 2026-11-17); a pilot cap ("i dont knwo what the 25$ even is what is it for", 2026-11-20).
- Publishing: "u dont publish i do that" (2026-11-08); the version name and unpublishing old versions (2026-11-21).
- Scope and direction: local-only first release ("I would like to ship local only", 2026-11-20); teams open source and enterprise closed (2026-11-11).

Of his 59 non-default card answers, about 13 asked for an explanation first ("Show me each", "are we talking about ram?", "not sure which is teh best way im not very technical find reasons search adn rate teh best one"), about 12 reported an action he took, and the rest set a new direction. So when a question was his, it often lacked the plain explanation he needed to answer it.

### G. Trust

**Where he gave more freedom, and the trigger:**

| Date | Freedom given | Trigger |
|---|---|---|
| 2026-10-16 | "U can auto merge" | Leaving for the night |
| 2026-10-18 | "u can megre on ur own once it passes all conditions" | He had merged by hand that morning ("i have merged for now") |
| 2026-10-20 | "it's okay to throw away PRs and start fresh" | Work stuck on old changes |
| 2026-10-29 | Agents change memory on his words (option A) | "human dont sit ans chaange anything now they handle everything by agents" |
| 2026-11-08 | Approves direction only; agents settle evidence-backed calls (notes 792, 801) | Too many questions at once from a sibling project |
| 2026-11-13 | "anything shoudl be abel to be done by an agenst tahts what forge is for" | Being asked to run a login command himself |
| 2026-11-16 | "controlled, not restricted" (note 959); "take more risks for longer stabilty" | Speed of merges had slowed |
| 2026-11-20 | "u can use opus or sonnet or sol base don task" | Model rules were blocking work |
| 2026-11-21 | Offer "default mode" once he keeps accepting the default | His own observation, quoted in H below |

**Where he took it back, and the trigger:**

| Date | Freedom taken back | Trigger |
|---|---|---|
| 2026-10-18 to 2026-11-18 | Open changes capped, finally at 4 | Changes opened and dropped ("we'd be losing a lot of work") |
| 2026-10-24, 2026-11-03 | Model choice: "dont use fable"; "why is terre build we wnated to use only sol or sonnet or opus" | Usage cost and quality |
| 2026-10-28 | "you locking too many tasks to certain models" | Rules aging as models change |
| 2026-11-03 | Wants rules "that can't be broken" | Agents bending config rules |
| 2026-11-03 | "Don't put the load on your machine" | Laptop CPU and memory at the ceiling (2026-10-22 and 2026-10-23) |
| 2026-11-08 | "u dont publish i do that" | Publishing to npm |
| 2026-11-20 | Admission rules before any build lane (rules 22 to 24, from an audit he asked for) | "a lot prs wromngly times and wokred and re parked adn closed" |
| 2026-11-20 | No admin shell, no approval links | Security and friction ("that is bad that is red flag") |

Pattern: he widens freedom over **how** the work is done (merging, rewriting, models, memory, steps) and narrows it over **waste and exposure** (open changes, laptop load, cost, publishing, credentials). Every narrowing followed a visible loss: dropped work, a slow machine, spent limits, or a security smell. None followed a bad merge.

His own statement of the end state, 2026-11-21: "if their user is doing it too many times he could get it red then we can also give him an option like based on his actions we could find the patterns ... where he is always accepting the default option ... the way the UI AI tools are built is they need to build confidence and get into default mode modes where it could work on its own".

## 3. What the product must do

Each item names the finding that supports it. Items marked **Idea** are mine, not his.

### 3.1 The return brief

Shown at the top whenever he opens a project after 30 minutes or more away, without being asked (B: he asks for status in only 8 of 59 returns, but follows up on gaps every time a report is given).

Order and content, at most 4 lines, about 60 words, with "More" for detail (B, his 2026-11-21 spec):
1. **Waiting on you:** how many items, the most blocking one in plain words, its default, and how long work has been held by it. Say "Nothing waits on you" when true. (F: 131 minutes and 8 hours of real stalls; E: rule 1.)
2. **Since you left:** what now exists or works better, each with one before and after number. Not merges. (E: outcomes rule; 2026-11-07 table reaction.)
3. **Distance to the goal:** the next milestone with a date or hour range, how it changed since the last visit, and one line of arithmetic behind it on "More". (B: 6 follow-ups on time to goal.)
4. **Anything wrong:** what is slower than normal or stopped, why, and the option that speeds it up; also any work paused or dropped since the last visit. (B: 4 follow-ups on abnormal pace, 4 on silent pauses.)

Rules for the words: names first, ids only in brackets (E: note 933); every number says what it means (B: "explain what the ratios are"); no role labels or system strings (E); one sentence per line.

### 3.2 The input router

Every message he types is classified and sent to one place, and the brief shows where it went (C; his 2026-11-21 routing ask):

| Input class (share in his busiest two weeks) | Goes to | Must also |
|---|---|---|
| Answer to a waiting item (14%) | The decision record, then resume the held work at once | Close the item everywhere it is listed (C: re-listing was "noise") |
| Direction for current work (25%) | The running lead thread | Nothing else |
| New idea (28%) | A new item in the plan under the right feature, not started | Not divert running work (C: "dont get diveretd"); appear in the next brief as "added to plan" |
| Standing rule (9%) | A rule at the scope he meant: thread, period, project or device, with his words and date | Flag any older rule it contradicts and ask once which wins (C: the Fable and effort reversals) |
| Correction of behaviour (7%) | The running thread | Count repeats; on the second repeat propose a standing rule (D: open-change sprawl corrected 5 times) |
| Question (10%) | Answered in place | If the question is one of the B gaps, add that line to the brief template |
| Complaint (6%) | A correction plus an overseer item | Show it in "Anything wrong" until fixed |
| Status ask | The return brief, regenerated now | |

**Idea:** pick the scope by default (thread for a correction, project for a rule) and show the choice in the brief with a one-tap change, instead of asking each time. Evidence that he dislikes per-item ceremony: 2026-10-29 "human dont sit ans chaange anything", and the memory-accept loops in inputs.md.

### 3.3 What runs without him, and what always asks

Runs without him (F: defaults he always took; G: freedom over how):
- Merging when gates pass; updating branches; one rerun of a flaky test; simplify or park at review round 2.
- Model choice per task within the routing profile.
- Filing issues, closing stale drafts, parking work with a named pickup trigger.
- Size exceptions within the leeway, listed once in the brief.
- Research he asked for, until it finishes, with its result shown as an outcome.

Always asks, and never by link, by plain text in chat or a card (F: truly his; G: narrowing on exposure):
- Publishing or unpublishing anything users install.
- Anything with his identity, accounts or credentials; anything that spends money.
- Scope of a release, and the open versus closed source line.
- Deleting user data.

Rules for asking (F, D):
- Ask only while he is present; when he is away, take the default, keep working, and list the item (rule 9).
- Before he leaves, offer "anything I need from you before you go?" with every item that will block within 12 hours (A: sleep handoffs; F: expired sign-in codes). **Idea.**
- Never let a question hold other work (D: stop-8h).
- Explain each question in plain words with an example, and say what waiting costs (F: 13 of 59 non-default answers asked for an explanation).
- After he takes the same default several times in a row for a reversible kind, offer to stop asking (G: his 2026-11-21 words). The number of repeats is unproven; see question 2.

### 3.4 The few numbers worth showing

On the brief: items waiting on him and hours held; date range to the next milestone; one before and after number per finished feature. (B, E, F)

On an analytics view, each against the project's own median (his 2026-11-21 list; A):
- Time from open to merge (median was 1.3 hours in the last week; 90th percentile 7.3).
- Things taking longer than normal, and failures that repeat.
- Time work waited on him.
- Usage of model limits per feature (B: "how did we use up so many limits").
- Merges and size per change, as throughput, here and not on the home view.

### 3.5 What to leave out

- Commit hashes, change numbers and issue ids on the home view (E).
- Review round counts, P1 and P2 counts, gate names, veto lists (A: visit 1 showed 15 veto items; he ignored them).
- "Decisions needed: none" lines and per-wake notices (A: visit 2, eight such messages).
- Lines of code as a measure of progress (B: he asked for time instead).
- Approval links and admin steps (G).
- A raw 15-minute log on the home view (E: "the timeline was stupid").

## 4. The current mock direction against the evidence

1. **Supported:** home summary of 3 to 4 lines, refreshed every 30 minutes, with "More". It is his own spec (B) and matches the median visit of 8 minutes and 2 messages (A).
2. **Contradicted:** the lead thread's summary line opens with "Lead has merged 512 changes this week" and timeline entries carry "2 merged · 1 issue". That is activity on the home view (E). Move merge counts to analytics.
3. **Supported:** feature cards with before, after, "How we know" and parts done. This is the outcome form he asked for on 2026-10-18 and 2026-11-21 (E).
4. **Unproven:** the 15-minute timeline with Happening, Closed and Faced lines. He specified it on 2026-11-21, but nothing in seven weeks shows him reading a log; his questions after reports were about time, stalls and value (B). Keep it one level down, and make its top entry a plain story of the period.
5. **Supported:** "Needs you" cards with options and a marked default. 62 percent of his card answers took the default, and he asked for decisions as cards (F, E).
6. **Supported:** publish always asks and cannot be made automatic (F: "u dont publish i do that").
7. **Supported, threshold unproven:** "You took the default 6 times. Let it happen on its own?" matches his 2026-11-21 words and the 65 items that ran on default (G, F). The count of 6 has no evidence behind it.
8. **Supported:** analytics compared with the project's median, including "Time waiting on you". It matches his 2026-11-21 list and the stalls in F. The mock's "Taking longer than normal" panel answers his "rivet shoudlnt be stuck for so long" question before he asks it (B).
9. **Partly contradicted:** placement and memory cards that ask "Where should it apply?" and "Keep this for later?" for each prompt. Routing is right (C), but a card per item is the per-item ceremony he pushed back on (note 792: decisions in batches, direction only). Default the scope and show it; ask only on a conflict with an older rule.
10. **Unproven:** the rules and laws panel with enforced, held and broken states and dry runs. His 2026-11-03 wish for rules "that can't be broken" supports enforcement, and D shows rules repeating until enforced. Nothing shows he wants to read rule states on a regular visit; put the broken ones into "Anything wrong" and keep the panel one level down.

Also supported: thread grouping by running, needs me and closed (his 2026-11-21 spec); the idea flow that files an idea into the plan without starting it (C). Missing from the mock: a line for work that paused or stopped silently (B), and a "before you go" step (A, F).

## 5. Open questions only he can answer

1. **Where do you read the brief: phone or laptop?** He once answered from a phone at night. Default: write for a phone, 4 lines, nothing that needs a wide table.
2. **After how many identical default answers may a kind of question stop asking?** Default: 5 in a row for reversible kinds; never for publishing, credentials, money or deleting user data.
3. **Do merges appear on the home view at all?** Default: no; only in analytics, compared with the median.
4. **Should a security-sensitive merge ask you, or only pass its stricter review?** Early on (2026-11-07) the lead asked; later it merged after review without asking. Default: review only, listed once in the next brief.
5. **When something blocks all work while you are away, should it reach your phone?** Default: a phone alert only when every lane is blocked for over 30 minutes and you were active in the last 12 hours.
6. **Which scope should a new rule get when you do not say?** Default: corrections apply to the thread, rules to the project; the brief shows the scope and you can move it.
7. **Is the goal for each absence "most work done by morning", or a specific milestone?** Default: the next milestone in the plan, with the brief saying how far the night moved it.
