# How the owner asks for summaries and status, and what he rejects

Source: his own typed messages in Claude Code transcripts for the Forge project folders. Dates are UTC, taken from the transcript timestamps. Quotes are verbatim, typos kept. Anything that looked like a secret was replaced with [redacted]. No change numbers are written here; "change A", "change B" and so on stand in for them.

## 1. Files read

All five are under C:/Users/<user>/.claude/projects/ or .claude_sub2/projects/, in folders named for the Forge repo. Each was streamed line by line.

| File | Size (bytes) | Typed-text entries, first pass (includes relays) | Matched, first pass | Owner messages after dropping relays | Matched after dropping relays |
|---|---|---|---|---|---|
| 33f6e698-15ee-4449-9744-69526ccb1794.jsonl | 436,947,253 | 4,805 | 2,470 | 414 | 41 |
| f134d6a7-943b-4529-8620-95725697c17f.jsonl | 322,283,761 | 6,003 | 2,739 | 319 | 26 |
| 47cf8802-7e17-4064-b225-2ed2a2c8b42f.jsonl | 229,254,248 | 5,934 | 2,699 | 328 | 27 |
| 73e5d9e1-837b-429b-82f1-bebc5397a269.jsonl | 199,920,094 | 5,471 | 2,481 | 286 | 25 |
| 075251b0-5178-4e79-891b-969b38604cb9.jsonl | 175,502,890 | 4,943 | 2,208 | 260 | 24 |

How to read the counts:
- The first pass kept every typed-text entry that did not start with "<". Most of those were not him: delegated-task relays, pull-request watch updates, heartbeats and scheduled kicks (about 12,400 of the 12,597 matches).
- The second pass also dropped lines that start like relays ("From the ... lead", "Owner decision", "Standing instruction", "Harsha's answers", "forge-NNNN ..." worker reports, JSON pastes, skill text). What is left still contains some relays I could not tell apart by prefix, so the "owner" column is an upper bound.
- Four of the files (f134d6a7, 47cf8802, 73e5d9e1, 075251b0) are forks of one conversation and repeat the same messages. Across all five files there are 58 distinct matching messages. About 20 of those are real asks about progress, summaries or readability. The rest are design directions that happened to contain words like "simple" or "report".
- The file 47cf8802 is the session that launched this task, so its last message (2026-11-21T14:03) is the freshest evidence.

## 2. Quotes

### Asks for a summary or status
1. 2026-10-16: "so whast teh progress now"
2. 2026-10-20: "What's the progress of our rebuild right now? Where are we stuck?"
3. 2026-10-22: "Also what happened to the working of the whole workflow based on Theos videos, all the research you got, and all the agents that you passed on? I haven't got any update on it, on how we are going to revamp it"
4. 2026-10-31: "progress"
5. 2026-11-01: "where are we stuck now"
6. 2026-11-04: "What is the progress and what are the next pending things that we have in forts to build? Are we close to a good release?"
7. 2026-11-04: "Give me a clear understanding of the capabilities of Forge that we have built until right now so that I can see and I can understand what we have built so far and whether it is good enough"
8. 2026-11-12: "What's the progress? How far along are we with testing forge and releasing it as a 0.0.1 release? What are we still pending to make the release?"

### Asks for it to be simpler or shorter
9. 2026-10-18: "pr descrition also need to be simple ina udnersatdble way and it shoudl have before after metrics proeplrty fro imoroivemnts and proofs proeplrt assigned"
10. 2026-10-23: "yeah do taht nad write teh file using html report skill adn unlsop it neds to be easy for to read"
11. 2026-11-21: "It needs to be very free and easy to read, very easy to understand in the least number of words possible."
12. 2026-11-21: "You can have tabs inside sections to have different options shown properly."

### Complains about a summary
13. 2026-10-20: "Why are you using the `status` command? We are rewriting everything that was not working previously so try to find it yourself"
14. 2026-10-23: "Also I hope you would have used the unslop skill to write this and explain this in a  better way"
15. 2026-10-24 (about a summary with links to the full plan and sources): "its not opening tehse"
16. 2026-10-25: "Whatever you are giving me is sounding like jargon and/or simple baby stuff."
17. 2026-11-16: "What happened to the research I have asked to do on Twitter?"
18. 2026-11-21: "the summary and all those things look too AI."
19. 2026-11-21: "Again the timeline was stupid, the way you have given it."

### Says what a good one looks like
20. 2026-10-25: "I wanted to have a balanced understanding of the end-to-end workflow that we are developing: - What are the options? - How would they be working in optional terms? ... - How is our workflow adding on top of it? - How is it using it properly? It should add real value and that should come with an example of something that has already worked in a real case"
21. 2026-10-25: "Everything should be an honest opinion rather than siding with us"
22. 2026-11-08: "share me the reasoning properly on those things so that I can answer them properly with a clear understanding of example cases and not randomly"
23. 2026-11-11: "take fabel helps and reviw with fabewl on extra high to cehck course on how ee are moving forward if anything need to be fixed or changed if anyd ecions are wrong cosnider as a overlooker in session threds athat cheks every 6 hours on teh progression and gives susugetion if thinsg are going wrong"
24. 2026-11-20 (comment on assistant text): "also teh framing to get right deatil adn questioninga dn and vusisation if posible issimporatnt"
25. 2026-11-21: "The timeline should be a summary or things need to be explained, like how Opus does or Google Neon does."

## 3. Patterns

How often he asks. 14 distinct progress or status asks between 2026-10-16 and 2026-11-16, about one every two days. They land at the start of a work session, mostly in the morning hours UTC (03:44 to 07:43) or in the evening (14:47, 20:29). Two more complaints are about the lack of an update he did not get ("I haven't got any update", "What happened to the research I have asked to do"). So silence is also a failure: about 3 of his complaints are "you never told me".

What he wants first. A one word or one line question, "progress", "where are we stuck". Seven of the 14 asks add a second question aimed at the goal: "where are we stuck" (2), "what is pending" (3), "how far are we" (4), "are we close to a good release" (1). The order in his longer asks is always: progress, then stuck or pending, then how far from release.

How long. He never gives a word count. The only length instruction is "in the least number of words possible" (quote 11). Roughly half his asks are under 60 characters, so the answer should be small too. He rejects the opposite: a summary that points to "the plan (2,400 words)" and links he cannot open.

Words for states. His own words: progress (9 uses), stuck (3), pending (3), "how far" (4), "close to a release" (2), "what happened" (2), "update" (2), "done" and "good enough". Never "blocked", "risk", "RAG" or "health". The status colours in the text he pasted back were the assistant's wording (green done, amber attention, grey not started); he complained only that the links did not open, not about the colours.

What he rejects, with counts from the 19 relevant messages:
- Jargon or "baby stuff", no middle: 1 explicit, plus "too AI" and "too raw" on 2026-11-21.
- Not using the readability skills (the "unslop" skill, the html report skill): 2.
- Making him run or read a command or a long file himself instead of getting the answer ("try to find it yourself"): 1.
- A timeline written as a raw log: 1, and it is the newest complaint.
- Missing proof: PR text should have "before after metrics" and proofs (quote 9).
- Bias: wants an honest opinion, not "siding with us" (quote 21).

What he accepts. Real examples that already worked; before and after numbers; reasoning with example cases; tabs and sections instead of one long page; a visual page when it is easy to read (quotes 10, 24). He answers "sounds good" or "yeah do that" to proposals; he rarely says a summary was good.

## 4. Proposed templates

### Project summary, refreshed every 30 minutes (4 lines, plain words)

```
Progress: <done> of <planned> planned items; <one phrase on how far from the goal or release>.
Done: <what closed since the last summary, with one real number each>.
Next: <what happens in the next 30 minutes, and what is waiting on what>.
Stuck: <the problem and the one thing needed, or "Nothing stuck.">
```

Rules and the quotes behind them:
- Progress comes first and is a count against the plan, with "how far" in the same line (quotes 2, 6, 8: progress, then how far, then pending).
- Use his labels "Progress", "Done", "Next", "Stuck" and the word "pending" for waiting items (quotes 2, 5, 6, 8).
- Each line is one sentence, no ids, no jargon, no links to long files (quotes 11, 15, 16).
- Numbers are absolute and said plainly (quote 9: before and after, with proof). Where something improved, say before and after.
- "Stuck" always appears, even when empty, so silence never reads as an unknown (quotes 3, 17).
- Honest tone: if progress is behind, say so on line one (quote 21).

### Timeline entry, written every 15 minutes (up to 3 short lines, about 40 words)

```
HH:MM  Happening: <what is going on now, one clause>.
       Closed: <what finished in this window, or "nothing">.
       Problem: <what went wrong> -> <how it was handled, or "still open">.
```

Rules and the quotes behind them:
- Read like a story of the window, not a log: "a summary or things need to be explained" (quote 25) and "least number of words possible" (quote 11).
- "Closed" mirrors his "done" and "what happened" asks (quotes 3, 17).
- "Problem -> handled" gives the stuck line its fix, which matches his wish for reasoning with a real example (quotes 20, 22).
- An empty window is written as such. A quiet window is information, not a gap (quote 17).
- In the page, entries sit inside a tab or section so the project view does not look like one raw list (quotes 12, 18).

## 5. Worked example: 2026-11-18, 18:00 to 19:00 UTC

Source: the largest transcript (33f6e698). I read the assistant text and tool calls for that hour. Context for the hour: the owner had just asked (18:01) for a controlled test of two ways of choosing models, and one code change (change A, the first part of the lane dispatch work) was heading to merge. Change B is another open change, change C is the first draft change of the model test, change D is a stale change, and the 0.0.1 release is the goal.

Timeline entries:

```
18:00  Happening: Model test started; change A finished a size fix and went to review on a different model.
       Closed: Change A is under its size cap (314 lines, was over).
       Problem: Change A tests failed (off-by-one count, help listing) -> fixes sent to its builder. The test lead could not start at an old commit -> lead built 12 replay checkouts by 18:14.

18:15  Happening: Change A fixes pushed and re-reviewed; the model test built its first run.
       Closed: First review of change A passed with no findings; the audit of 891 tests is filed.
       Problem: Mac jobs on change B never got a runner, so no test failed -> one rerun allowed and logged. Owner set a new limit of 4 open changes (was 6) -> change D closed, 5 open.

18:30  Happening: Change A got its last review while CI ran.
       Closed: Both reviews of change A passed, and the outside review found nothing.
       Problem: One Windows test on change A timed out at 45 seconds. It is the only failure in 67 Windows runs, and it passed on other jobs -> logged as a flake.

18:45  Happening: Waiting on CI for change A and change B.
       Closed: Nothing.
       Problem: None new. Mac runner cancels on change B are still queued.
```

30-minute summary at 19:00 (covers 18:30 to 19:00, progress counted across the hour):

```
Progress: Change A has 2 of 2 reviews clear but CI is not green, so it is not merged. The model test has 1 of 12 replays built; none judged yet.
Done: 12 replay checkouts made, change A under its size cap with 3 fixes in, 891-test audit filed, open changes cut from 6 to 5 with the new 4 limit written into the checks.
Next: Wait for CI on change A and B; rerun the cancelled Mac jobs once; change A must catch up with main before it can merge; the first replay's CI result goes to the test lead.
Stuck: Mac runners are not being assigned (2 jobs on change B, 1 on change A) and one Windows test flaked; no code fault found in either.
```

## 6. What I could not determine

- Which summaries he actually accepted. He almost never says a summary was good; "sounds good" and "yeah do that" answer proposals, not summaries. Acceptance is inferred from the absence of a complaint.
- What "like how Opus does or Google Neon does" means in detail. I did not find where he showed an example, so the exact shape of that timeline style is unknown.
- Any word or line limit. He says "least number of words possible" and nothing numeric. The 3 to 4 lines and 40 words are my proposal, not his rule.
- Whether he reads these on a phone or a laptop. He mentioned phone use once for approvals, not for summaries.
- Whether 30 minutes and 15 minutes are right. His only cadence statement is a six-hour overseer check (quote 23); asking every two days is the observed rate.
- A standing instruction relayed by a coordinator on 2026-11-08 says to give absolute before and after numbers and say plainly whether a person would notice. It is relayed text, so I did not count or quote it, but it agrees with quote 9.
- Messages he wrote that avoid my keywords (for example "tldr" or "explain this") would be missed. The keyword filter is a floor, and the owner column still holds some unrecognised relays.
- The worked example comes from assistant text and tool calls, which I read in shortened form; some detail inside long messages was not read.
