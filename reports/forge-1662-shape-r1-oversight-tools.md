# Oversight tools for many coding agents (research R1)

Date: 2026-11-21. Web research only. "V" = vendor claim, "U" = user report, "?" = not verified.

## What exists

| Tool | Screen shows | "What needs me" | Timeline / summary | Multi-project |
|---|---|---|---|---|
| Claude Code agent view (research preview, 2026-05-11) | One row per session: last response, last-touched time, PR indicator (V) | Groups Needs input / Working / Completed; count line; terminal notification (V, docs) | Last response only. No event timeline | Not described in the blog (?) |
| Cursor 3 Agents Window (shipped 2026-04-02) | Sidebar of local, cloud, cross-repo agents | "Needs Attention" group when sidebar is grouped by status (U, forum 2026-09-03) | None found | Yes, across workspaces |
| Devin Desktop Agent Command Center, plus SDK session board | Local and cloud sessions; board columns needs-you / working / done (V) | Columns plus an OS notification, off by default (V, docs) | Not described | Group per workspace |
| Codex app | Projects with threads; review pane per git repo; automations land in a review queue | Notifications page exists; push for approvals was a user request (U) | Not found | One window, many projects (V) |
| T3 Code | Thread sidebar: working, pending approval, completed, PR badges. Sidebar V2 (beta): flat recency list across projects, blocked threads pinned on top | Amber "pending approval" | None found | Yes, across projects |
| Conductor (Mac, free) | Workspace per worktree, Checks tab (Jan 2026), diff review | Dashboard of what needs review (third-party description) | No event timeline found | Yes |
| Vibe Kanban | Kanban of issues and workspaces | Board columns | No | Yes. README says "Vibe Kanban is sunsetting" (date not seen) |
| Superset, cmux, herdr, Agent-Manager | Terminal tabs with state, branch, ports, last notification text | Blue ring, unread jump (cmux); hook notifications (Superset) | No | Per workspace |
| Nimbalyst (replaced Crystal, Feb 2026) | Kanban of sessions: running, waiting, finished (V) | Kanban column | No | Yes |
| Factory Droids desktop (Apr 2026) | Multiple Droid sessions with own history | No attention view found | No | ? |
| Happy, Omnara | Phone remote for sessions. Omnara repo says that version is unmaintained | Push alerts | No | No |
| GitHub Agent HQ / Mission Control (Oct 2025) | All agent sessions, logs, files changed, across GitHub, VS Code, mobile, CLI | Session list | Logs per session | Yes (V) |
| Vercel Board (2026-11-19, experimental) | Channels and threads; tasks ready/claimed/waiting/done; claims are leases | Not mentioned in the launch post | Per-thread record; events log who did what | Multiple boards |

Not found or unverified: Terragon (no 2026 source; a rival page only says "cloud VMs"), Sculptor (Imbue says "not finished"; Docker per agent is third-party), Omnara current status.

## What users praise

- Worktree isolation and cheap parallelism. "very little friction to spinning up a worktree (~2s)" (HN, Superset Show HN).
- Leaving the desk. "I am no longer chained to my laptop." (same thread).
- Status in the sidebar. cmux hit #2 on HN on 2026-02-19 with a notification ring and latest-text sidebar.
- Agent view helps people already at 5+ sessions; one builder said it made delegation "obvious" (secondary).

## What users complain about

- Silent stalls. "Agent finished 35 minutes ago. Or worse, it's been waiting for my approval the entire time." (Product Hunt, about 4 months old).
- Cannot see a blocked agent. "one agent might be waiting for user approval without me knowing it's stuck" (Cursor forum, 2026-09-02).
- Tab sprawl. "couldn't manage more than like 20 terminal tabs without losing track" (HN, Launch HN Superset).
- Content-free alerts. cmux author: macOS alerts said only "Claude is waiting for your input".
- Review is the limit. "The real bottleneck isn't human review per se, it's unstructured review." (HN). Another said they "can't keep up with it all" (HN 47327559).
- Role cost. "The second feels like middle management." (DEV, Cursor 3, April).
- Sidebar bugs: cloud agents missing, unarchived agents vanishing after days (Cursor forum, 2026).
- Reddit: I found no usable r/ClaudeAI, r/ClaudeCode or r/cursor threads. Unverified.
- Study (V, working paper, reported 2026-11-18): PR merge time up 49%, review comments per PR up 35%, completed issues flat.

## Gaps nobody fills

- A timeline built from recorded events (PR, CI, review, merge). Every product above shows state or last message. None shows a history.
- Cross-tool, cross-project inbox. Each vendor covers its own agents. Cursor's own forum reply says a Claude Code blocker needs a separate paid tool.
- "Catch me up since I last looked." Not found in any product.
- Stuck detection beyond "waiting for input". Not found.
- Forecast ("N PRs away"). Not found.
- Request shown with task context so it can be answered without reading the transcript (Nimbalyst CEO, a competitor, says this is incomplete).

## What we can do

- One append-only event log per project, fed by git, CI and review events we already own. This is checkable data, not chat summaries.
- Inbox of human decisions with context attached (PR, check, question).
- Project and main-thread timelines with sub-agents folded in.
- Since-last-look digest keyed to a per-user cursor.
- Stuck rules from event gaps (CI red for N hours, review blocked, no event for N hours).
- Forecast from PR queue and merge history. State the method and show the inputs.

## What we cannot or should not do

- Replace agent UIs. Five vendors ship them, free.
- Read "needs input" from other harnesses without hooks. Needs an adapter per tool.
- Promise a forecast with little history. Merge-time data is noisy.
- Build notification volume. Noise is the complaint, not the cure.
- Treat vendor numbers (Vercel's "over 50% of PRs") as proof.

## Simplify

Ship the inbox plus since-last-look first. Skip forecast and fancy stuck scoring until the log has data.

## Converge

The market is converging on status columns (needs you / working / done): Claude Code, Devin, Cursor, Nimbalyst. Match that vocabulary. Do not invent new states.

## Double down

Recorded events as the source of truth. It is the one thing in the table nobody has, and it is cheap to verify.

## Unknowns

- Whether users want a timeline or only an inbox. No user quote asks for a timeline directly.
- Real Reddit sentiment.
- Whether Agent view or Board adds cross-project history soon. Board is days old.
- Vibe Kanban shutdown date and Terragon status.

## Sources

- [Agent view blog](https://claude.com/blog/agent-view-in-claude-code)
- [Agent view docs](https://code.claude.com/docs/en/agent-view)
- [Vercel Board blog](https://vercel.com/blog/introducing-vercel-board)
- [Board author test](https://flaviocopes.com/vercel-board/)
- [Cursor forum: approval queue](https://forum.cursor.com/t/agents-approval-window/170388)
- [Cursor 3 DEV post](https://dev.to/adioof/cursor-3-turned-my-ide-into-a-management-dashboard-im-not-sure-i-asked-for-that-277j)
- [cmux Show HN](https://cmux.com/blog/show-hn-launch)
- [Superset Show HN](https://news.ycombinator.com/item?id=46368739)
- [Launch HN Superset mirror](https://hn.nuxt.dev/item/48236770)
- [HN: agents that run while I sleep](https://news.ycombinator.com/item?id=47327559)
- [Product Hunt: staying aware](https://www.producthunt.com/p/general/how-do-you-stay-aware-of-what-your-ai-coding-agents-are-doing-2)
- [Nimbalyst CEO: what breaks](https://dev.to/stravukarl/what-actually-breaks-when-you-run-5-claude-code-agents-in-parallel-1lbd)
- [Devin Agent Command Center](https://docs.devin.ai/desktop/agent-command-center)
- [Devin session board](https://docs.devin.ai/sdk/examples/session-board)
- [T3 Code sidebar V2 PR](https://github.com/pingdotgg/t3code/pull/4068)
- [Vibe Kanban README](https://github.com/BloopAI/vibe-kanban)
- [Conductor review](https://thenewstack.io/a-hands-on-review-of-conductor-an-ai-parallel-runner-app/)
- [GitHub Agent HQ](https://github.blog/news-insights/company-news/welcome-home-agents/)
- [Harvard study summary](https://daily.dev/posts/harvard-researchers-find-ai-coding-agents-shifted-the-bottleneck-to-code-review-aeapqg8jp)
- [Codex app docs index](https://learn.chatgpt.com/docs/features.md)
