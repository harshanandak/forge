# Decision inbox: human-in-the-loop UX research (R1)

Date: 2026-11-21. Web research only. Vendor claims and user reports are marked. "Unverified" means I could not open the primary source.

## What exists

| Product | What it does | Evidence type |
|---|---|---|
| HumanLayer | SDK. `require_approval` decorator and `human_as_tool`. Routes to Slack, email; SMS/Discord planned. | Vendor README |
| LangChain Agent Inbox | UI for LangGraph `interrupt()`. Per-interrupt flags: accept, edit, respond, ignore. Newer middleware names: approve, edit, reject, respond. | Vendor docs |
| Vercel Board (2026-11) | Shared message board for agents. Agents post "Can I get a review?" with a PR link. Grants and per-event identity log. No documented approval gate or timer. | Vendor blog. Note: I found no "approval guidance" in the Board post itself |
| Vercel + NanoClaw + OneCLI (2026-04-17) | Approve/deny cards inside 15 chat apps (Slack, Teams, WhatsApp). Policy example: read mail freely, approve to delete or send. | Press coverage. Rollout unconfirmed |
| Vercel Agent in Slack | Approval required for all write operations. | Vendor docs |
| Claude Code | Prompts per action. Auto mode (classifier) is the default mode in v2.1.283+ per docs. | Vendor docs |
| Codex | Auto-review agent replaces sandbox-boundary prompts. Mobile approvals in the ChatGPT app since 2026-05-14 (preview, Mac host only). | Vendor + press |
| Cursor | "Ask Question" dialogs since 2.4 (non-blocking). | Vendor + forum |
| Devin | Agency setting: proceeds with plan without approval when on. No documented ask-in-Slack flow found. | Vendor release notes |
| Omnara, Happy Coder | Phone mirror and push for Claude Code/Codex. Happy is end-to-end encrypted. | Vendor pages, Show HN |
| Pushary | Sends only the decision to the phone lock screen, no terminal mirror. | Vendor |
| Dial, Dylamo | Agent gets a phone number and calls you. Dial is a vendor claim. Dylamo is a hackathon project. | Vendor, unverified |
| PagerDuty, incident.io | Ordered levels, acknowledge stops escalation. Community examples: 5 min, 10 min, 15 min steps. | Vendor docs, tutorials |

I found no first-party Anthropic or OpenAI voice-call feature.

## What users praise

- Phone approval from the lock screen is the main draw of Codex mobile (blog commentary, not survey data).
- Pushary and similar tools: sending only the decision, not the whole session, is called out as the cleaner design (vendor claim).
- Cursor staff reply that the user can skip a question and the agent is just waiting. Non-blocking questions were a deliberate fix.
- Auto-review claims: Codex stops for a human about 200x less often, and denials come with a reason so the agent finds another route. More than half of denied cases later succeeded (OpenAI, vendor).
- Batching: reviewers judge a whole change better than one atomic action (Hugging Face / Data & Society paper via BankInfoSecurity; tianpan.co essay).

## What users complain about

- Too many prompts. Anthropic's own number: users accept 93% of manual prompts. Many switch to `--dangerously-skip-permissions` instead (Anthropic, vendor, but self-damaging, so credible).
- Bad questions. Cursor forum, Aug 2026: "ask structured questions on EVERY new chat", "should be rare, like 1% of the time", typing "analyze first" in Other did not stop it, one prompt had two options that both read "continue finishing." Staff confirmed the bug (user reports, primary thread).
- Missed or invisible questions. A permission prompt shows only in the terminal. A finished agent and a blocked agent look the same. Cursor sometimes fails to render the approval dialog and hangs on "waiting for approval" (forum, dev.to posts).
- Agents stuck while the user is away. Most tooling here is DIY: hooks, notifiers, remote-approval plugins.
- Platform limits: Codex mobile is Mac-host only. Data residency concerns about the relay (one commentator).
- I could not find the Reddit or X threads. Search returned dev.to, Product Hunt and forum posts instead. HN content: Happy Coder Show HN found (26 points at capture), comments not read. A claim of a 197-point HN thread on a destructive shell expansion is secondary and unverified.

## Risks

Rubber-stamping:
- 93% accept rate (Anthropic). Codex auto-review approves 99.1% of escalated actions (OpenAI).
- Secondary, unverified: reviewers of agent PRs approved more over time (30.1% to 36.8%) with 22% fewer comments. Another claim: humans caught 13.6% of dangerous commands vs 89% for a classifier. I could not find either primary study.
- Classifier is not a fix: Anthropic reports 17% false negatives on real overeager actions and calls it "the honest number."
- WorkOS reports attackers now write prompts meant to cause approval fatigue (vendor blog, unverified).

Identity:
- OpenClaw trusted mutable display names for allowlist decisions. Spoofing a trusted user's name bypassed it. Patched; Telegram first, same flaw reported on Slack, Discord, Teams (security vendor write-ups, an arXiv analysis of 190 advisories names identity mutability as a recurring flaw).
- I found no confirmed incident of a spoofed "approve" button specifically. Say so plainly.
- The out-of-band approval write-up (dev.to) never explains how approver identity is verified. Common gap.

Timers:
- Common practice is fail closed. SafeAI and Microsoft's governance toolkit deny on timeout (Microsoft default 5 min). Veto defaults to block. Auto-approve is framed as a low-risk choice only. Escalate-on-timeout is the third option (Cloudflare example).
- No source I found recommends "silence means consent" for risky actions. Our "take option A, reversible until merge" is defensible only when the action really is reversible.
- Phone calls: a muted phone or a meeting pauses the loop (one write-up).

## What we can do

1. Card format with question, options, default, evidence, timeout outcome. Matches the Agent Inbox shape (accept/edit/respond/ignore) plus a default and a deadline, which Agent Inbox does not have as a first-class field.
2. Per-card "if nobody answers" rule. Auto-take default only if the card's own tag says reversible. Otherwise hold or escalate.
3. Ladder modeled on PagerDuty: card, push, call. Acknowledge stops escalation. Use short steps for urgent cases (5 to 10 min is the community range) and 15 to 30 min for the rest.
4. Batch review of many pending cards at once, grouped by agent or branch.
5. Ledger of answers with decision latency, accept rate, and what each answer caused. Use it to watch for decay, as the essays advise: falling latency plus rising accept rate.
6. Bind each answer to a verified device or account, never to a display name.

## What we cannot or should not do

- Do not auto-accept on silence for irreversible or credential-touching actions.
- Do not accept approvals from chat identity alone (display name, username without stable ID).
- Do not claim approval prevents harm. The 93% and 17% figures say it does not by itself.
- Do not build a generic voice-agent platform. Calls are an alert channel here, not a product.
- Do not trust a vendor's reduction claim (200x fewer prompts) as a measure of safety. It measures fewer interruptions.

## Simplify

- Cut the ladder to three states: pending, answered, expired-with-outcome.
- One card schema. Rendered HTML (side-by-side options) is an optional attachment, not a requirement.
- Start with card plus push. Add the phone call after the ledger shows which cases justify it.

## Converge

- Every source ends at the same design: decide policy in advance, ask only for judgment calls, batch the rest, fail closed by default, log everything.
- Anthropic, OpenAI, Hugging Face / Data & Society, WorkOS and tianpan.co all name approval fatigue as the failure mode.
- Notifier tools (Pushary, Happy, Omnara, DIY hooks) converge on "tell me when it is blocked."

## Double down

- The "what happens if nobody answers" field. Agent Inbox, HumanLayer, Omnara and Pushary do not appear to put it on the card (not exhaustively verified). Cloudflare, SafeAI and Microsoft have it only as config.
- The ledger as an oversight monitor. Essays recommend tracking latency and approval rate; no product I found ships it for coding-agent decisions.
- Question quality. Cursor users hate vague, constant questions. A card that must carry options, a default and evidence forces better questions and gives us a way to reject bad ones.
- Blocked-vs-finished visibility across many agents. This is the most repeated user pain.

## Unknowns

- Real HN, Reddit and X reaction volume. Not found.
- Whether Vercel Board has any approval feature. The Board post and docs show none. The New Stack heading "Agents request human approval" had no detail I could read (the page returned 403).
- Primary sources for the 30.1% to 36.8% and 13.6% vs 89% figures.
- Whether NanoClaw/Vercel approval cards shipped to enterprise.
- Whether any product calls you by phone in production and how users rate it.
- GitHub Mobile approvals: not researched in depth.
- Devin's ask-the-user flow details.
- Slack and Telegram bot approval spoofing: no confirmed incident of a forged approve action.

## Sources

- [Anthropic: Claude Code auto mode (engineering)](https://www.anthropic.com/engineering/claude-code-auto-mode)
- [OpenAI: Codex auto-review](https://openai.com/safety-alignment/auto-review/)
- [Vercel: Introducing Vercel Board](https://vercel.com/blog/introducing-vercel-board)
- [The New Stack: Vercel Board coverage](https://thenewstack.io/?p=22844193)
- [VentureBeat: NanoClaw and Vercel approval dialogs](https://venturebeat.com/orchestration/should-my-enterprise-ai-agent-do-that-nanoclaw-and-vercel-launch-easier-agentic-policy-setting-and-approval-dialogs-across-15-messaging-apps)
- [BankInfoSecurity: AI agents make human oversight less reliable](https://www.bankinfosecurity.com/ai-agents-make-human-oversight-less-reliable-a-32768)
- [tianpan.co: approval fatigue](https://tianpan.co/blog/2026-06-25-approval-fatigue-how-human-in-the-loop-gates-decay-into-rubber-stamps)
- [WorkOS: approval fatigue and agent governance](https://workos.com/blog/approval-fatigue-agent-governance)
- [Cursor forum: asking questions on every turn](https://forum.cursor.com/t/total-non-starter-cursor-is-asking-me-questions-on-every-turn/167453)
- [Cursor forum: stuck on waiting for approval](https://forum.cursor.com/t/coding-agent-gets-stuck-on-planning-waiting-for-approval-when-using-chrome-devtools-mcp-playwright-mcp/152002)
- [crystl.dev: Claude Code stuck on permission prompt while away](https://crystl.dev/blog/claude-code-stuck-on-permission-prompt-afk/)
- [Axios: Codex on your phone](https://axios.com/2026/05/14/openai-brings-codex-to-your-phone)
- [Show HN: Happy Coder](https://hn.svelte.dev/item/44904039)
- [HumanLayer on Y Combinator](https://ycombinator.com/companies/humanlayer)
- [LangChain Agent Inbox docs index](https://docsearch.algolia.com/mcp/docs/repo/langchain-ai/agent-inbox)
- [LangChain human-in-the-loop docs](https://docs.langchain.com/oss/python/langchain/human-in-the-loop)
- [OpenClaw security analysis (arXiv)](https://arxiv.org/pdf/2603.27517)
- [Cloudflare: human-in-the-loop patterns](https://developers.cloudflare.com/agents/guides/human-in-the-loop)
- [SafeAI approval workflows](https://safeai-sdk.github.io/safeai/guides/approval-workflows)
- [incident.io: escalation policy best practices](https://incident.io/blog/escalation-policy-best-practices)
- [PagerDuty: escalation policy basics](https://support.pagerduty.com/docs/escalation-policies)
- [dev.to: out-of-band human approval](https://dev.to/mightbesaad/the-missing-primitive-out-of-band-human-approval-for-ai-agents-7bo)
