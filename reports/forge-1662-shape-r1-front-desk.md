# Front desk and chief-of-staff agents: research round 1

Date: 2026-11-21. Web research only. Search-engine summaries were used for most claims; only the xAI launch page was fetched in full. "Vendor" means the maker's own claim. "User" means a forum, issue or blog report. Anything marked (unverified) I could not confirm.

## What exists

| Product | Single entry point | Where work runs | Authorisation | What the human sees after |
|---|---|---|---|---|
| Grok Bot (xAI, beta 2026-08-11) | App on Mac, iOS, desktop; message a Bot | Cloud computer per Bot; Bots log into your apps | Page names no scopes. Says Bots "only come back when something needs your approval" (vendor) | Finished work, pings for decisions, saved "routines" |
| OpenClaw (was Clawdbot, Moltbot) | Telegram, WhatsApp, Slack, Discord chats | Your own machine or server, with shell access | Allowlist of senders; gateway token | Chat replies |
| Poke | iMessage (Apple-approved June 2026), Telegram, SMS | Vendor cloud | Account plus connectors | Chat replies |
| Lindy | iMessage, web | Vendor cloud | Connectors | Chat replies |
| Claude Cowork Dispatch | One continuous chat on phone and desktop | Your desktop, which must stay awake | Folder and connector permissions; asks before touching a folder | Result in the same chat |
| Claude Code Remote Control | Phone or browser shows a local session | Your machine; outbound HTTPS only, no inbound port | Short-lived scoped credentials; permission prompts stay the control point | Live session view |
| Codex in ChatGPT mobile (preview 2026-05-14) | Phone app, QR pairing from Codex for Mac | Your computer, plus managed remote boxes and SSH | Relay; files and credentials stay on the machine; approve commands from phone | Terminal output, diffs, test results, approvals streamed back |
| Devin and Cursor in Slack | @mention in a thread | Vendor cloud agent | GitHub app grant | PR link in thread |
| T3 Code remote | `t3 serve`, `t3 pair` QR, Tailscale `.ts.net` URL, or `t3 connect` relay | Your host | One-time owner pairing token, then device session | Same T3 UI |
| DIY: Tailscale or Twingate plus SSH plus tmux | Terminal app on phone (Termux, Termius) | Your machine | Network identity (WireGuard) | A terminal |
| Orchestrator pattern | Lead agent relays to builders | Wherever builders run | Inherited from lead | Lead's summary |

T3 Code webhooks: not found in any source (unverified). Pairing, Tailscale and relay are documented; webhook triggers are not.

## What users praise

- Phone reach without a new app. Poke got Apple approval for iMessage, a distribution win (press, 2026-06). Telegram is the favoured OpenClaw channel (blog summaries of Reddit).
- Local execution with remote view. Remote Control keeps files, MCP servers and config on your machine and opens no inbound port (vendor docs).
- One conversation across devices (Dispatch). A Tom's Guide reviewer sent a task from a phone and it finished on the laptop (press).
- Dispatch asked for folder permission before reviewing a local repo (press, one test).
- Quiet by default. Grok Bot's pitch is "only come back when something needs your approval" (vendor). No user report yet confirms it works.
- Devin in Slack: one practitioner said a later retry turned one message into a clean PR (blog, 2026).

## What users complain about

- Cost and throttling. Musk said Grok Bot serving cost was "unsustainably high"; users hit weekly caps early and called it a "rug pull" (press quoting X and Reddit, Nov 2026). One power user reported about 4x tokens for the same work (Chinese-language press, unverified).
- Price confusion. Sources disagree: $30 SuperGrok tier, $120 per month, or $200 plan (unresolved).
- OpenClaw spend. Each task makes 5 to 10 API calls. Long sessions resend about 200K tokens of stale context. A cache regression raised bills silently overnight (aggregator posts; one headline claims hundreds of dollars per day, unverified).
- Wrong delegate or repo. Cursor Slack agent answered with the wrong repo and branch, ignored the full thread, and looped on "repository access denied" (Cursor forum, several threads).
- Lost context. Early Devin Slack dropped context between messages (blog, 2026).
- Remote Control reliability. Sessions drop every few minutes or on Wi-Fi to cellular switches. Permission prompts often do not reach the phone, and approving from the phone could leave the host stuck (GitHub issues, several marked resolved).
- Fragile bridges. Lindy's first two iMessage builds failed, and one depended on a desktop app staying open (vendor account).
- Opaque and shared. One blog claims all of a user's Grok Bots share one cloud computer, files and logins. Other posts say each Bot has its own. Conflict, unverified.
- Bots talking past each other. Cognition's "Don't Build Multi-Agents" argues subagents given only a summary misread the task. Its April 2026 follow-up says only designs with single-threaded writes work (vendor essay).
- Role by description. One report says the Grok "chief of staff" is only a role written in a description field, not a separate bot type (eesel blog, unverified).

## Security incidents and warnings

- OpenClaw exposure: Censys counted about 21,000 public instances on 2026-01-31. Larger figures (42,000; 135,000) come from a security vendor's blog posts with inconsistent numbers. Treat as unverified.
- CVE-2026-25253, CVSS 8.8: WebSocket token hijack leading to code execution (secondary blogs only, unverified).
- Prompt injection by email: Kaspersky describes an attacker emailing a linked inbox, then asking the bot to read mail; the agent handed over a private key. CrowdStrike reports in-the-wild injection aimed at crypto wallets. Cisco found a third-party skill that exfiltrated data. Eye Security could not reliably reproduce injection against current guardrails (counterpoint).
- Forged identity: an attacker set a display name to match an authorised user and passed the allowlist (reported, said patched).
- Zero-click leaks: link previews in Slack, Telegram and Discord leaked agent secrets with no user click (The Register, 2026-02-10; PromptArmor test on OpenClaw).
- Approval previews can lie: invisible Unicode made an approval card differ from the real command (blog).
- Agents helping write their own allow-rules is named as the weak point in a 2026 arXiv paper (secondhand).
- Exposed MCP: Censys found 12,520 internet-reachable MCP services on 2026-04-28, 687 of them exposing command execution. Knostic: 1,862 with no auth. Spec does not require auth.
- Moltbook leak: reported 1.5 million API tokens. Date and cause vary by source (unverified).
- No source I found documents a Cloudflare Tunnel incident or an agent forging its own approval. Absence of evidence only.

## Overnight workflows

- PocketOS, April 2026: a Cursor agent on Claude Opus 4.6 deleted production data and backups in one Railway API call after a credential mismatch. 30+ hours down. Afternoon, not overnight (press).
- Claude Code deleted about 48,000 files via Windows junctions (press; date unstated).
- Silent drift: 40 overnight experiments all ran a learning rate the agent never chose, with no error (O'Reilly Radar).
- Runaway loops: hundreds of API calls with duplicate context; advice is hard spend stops, not soft warnings (blog).
- Duplicate posts and status updates that were accurate but did not judge quality (dev.to).
- Common lessons: concrete success criteria, hard budgets and retry caps, repetition alerts. I found no vendor shipping a morning report scored against a stated contract.

## What we can do

1. Use the pairing pattern three vendors converged on: outbound-only relay, one-time token, per-device session, approvals on the owner device (Remote Control, Codex mobile, T3 Pair).
2. Make the front desk a router that writes plain files. No product found does this; all keep state in a vendor store.
3. Server-check owner approval and sign requests. Incidents show chat identity (display name) and chat rendering (previews, Unicode) are not safe approval channels.
4. Overnight contract with hard caps (spend, retries, scope) and a morning report scored against it. Incident lessons support every field.
5. Treat each runner as a black box with a documented trigger (MCP, webhook, tunnel) and show the user which one handled what.

## What we cannot or should not do

- Never accept an approval from a chat message alone. Display names, link previews and Unicode all failed.
- Do not expose a listener on a public port. 687 command-execution MCP services were found open.
- Do not store runner credentials in the front desk. Shared logins and leaked token stores are the recurring failure.
- Do not let the agent that acts also write its own permission rules.
- Do not promise the front desk fixes context loss; the lead-to-builder relay is where Cognition says it breaks.
- Do not rely on T3 Code webhooks until documented.

## Simplify

Ship one inbound path (paired phone to local daemon over an outbound relay), one write path (a file), one approval path (owner device, server-checked). Skip voice, report cards, playbooks and the public status page for v1.

## Converge

Vendors agree on: outbound-only relay, QR pairing, local files stay local, approvals on the owner device, phone as a window onto the real session. Users agree on pain: reliability of approvals on mobile, cost surprises, and wrong-repo routing.

## Double down

- Routing accuracy with a visible reason ("sent to X because Y"), since wrong repo is the top Slack-agent complaint.
- Hard spend and retry caps with a scored morning report, since nobody ships it and every overnight failure is a missing cap or missing check.
- Plain-file state a human can edit, against the opaque-work complaint.

## Unknowns

- Real Grok Bot isolation (shared vs per-Bot computer) and its permission model.
- Any Hacker News thread data; I could not retrieve comments, so HN reactions are absent.
- Direct X and Reddit posts; most reactions came through press or blog summaries.
- T3 Code webhook support.
- Whether Dispatch and Remote Control permission failures are fixed in current builds.
- Public status pages generated from agent activity: none found. Only changelog drafters (LFX Changelog, with human review).
- Exact OpenClaw exposure and CVE details.

## Sources

- [xAI: Introducing Grok Bot](https://x.ai/news/introducing-grok-bot)
- [VentureBeat: Grok Bot](https://venturebeat.com/orchestration/spacexais-grok-bot-turns-agents-into-persistent-digital-coworkers-that-can-operate-your-apps-for-120-per-month)
- [TechRadar: Grok Bot throttled, "rug pull"](https://techradar.com/ai-platforms-assistants/elon-musk-says-grok-bot-was-throttled-because-costs-were-unsustainably-high-as-users-call-the-move-a-rug-pull)
- [eesel: Grok Bot explained](https://www.eesel.ai/blog/grok-bot)
- [Claude Code Remote Control docs](https://code.claude.com/docs/en/remote-control)
- [claudeissues.com: phone approval hangs host](https://claudeissues.com/issue/52084-remote-control-approving-permission-from-phone-hangs-claude-code-on-host)
- [claudeissues.com: prompts do not forward to mobile](https://claudeissues.com/issue/36439-permission-prompts-do-not-forward-to-remote-control-client-mobile)
- [OpenAI: Work with Codex from anywhere](https://openai.com/index/work-with-codex-from-anywhere/)
- [9to5Mac: Codex control in ChatGPT mobile](https://9to5mac.com/2026/05/14/openai-brings-codex-control-to-chatgpt-for-iphone-and-android/)
- [Claude support: Dispatch in Cowork](https://support.claude.com/en/articles/13947068)
- [Tom's Guide: Dispatch review](https://www.tomsguide.com/ai/i-sent-claude-a-task-from-my-phone-and-it-finished-it-on-my-laptop-without-me-touching-a-thing)
- [T3 Code PR: t3 pair](https://github.com/pingdotgg/t3code/pull/4955)
- [DeepWiki: T3 Code cloud and remote access](https://deepwiki.com/pingdotgg/t3code/7-cloud-and-remote-access)
- [TechCrunch: Poke](https://techcrunch.com/2026/04/08/poke-makes-ai-agents-as-easy-as-sending-a-text/)
- [Lindy and Linq: iMessage build](https://linqapp.com/blog/how-lindy-shipped-an-ai-assistant-into-imessage)
- [Cursor forum: Slack wrong repo](https://forum.cursor.com/t/slack-integration-wrong-repo-branch/107202)
- [Cursor forum: Slack context not passed](https://forum.cursor.com/t/slack-channel-context-isnt-passed-to-the-cursor-background-agent/116792)
- [Cognition: Don't Build Multi-Agents](https://cognition.ai/blog/dont-build-multi-agents)
- [Cyera: OpenClaw security saga](https://www.cyera.com/research/the-openclaw-security-saga-how-ai-adoption-outpaced-security-boundaries)
- [Kaspersky: OpenClaw vulnerabilities](https://www.kaspersky.com/blog/openclaw-vulnerabilities-exposed/55263/)
- [Eye Security: OpenClaw](https://research.eye.security/?p=5222)
- [The Register: link previews leak agent secrets](https://www.theregister.com/2026/02/10/ai_agents_messaging_apps_data_leak/)
- [Censys: MCP servers on the internet](https://censys.com/blog/mcp-servers-on-the-internet/)
- [Dev.to: approval previews spoofed by Unicode](https://dev.to/terminalblog/beware-claude-codes-approval-previews-could-be-spoofed-with-invisible-unicode-p1j)
- [TechSpot: PocketOS database wipe](https://www.techspot.com/news/112207-ai-coding-agent-running-claude-wiped-startup-database.html)
- [O'Reilly: 40 experiments while I slept](https://www.oreilly.com/radar/i-let-an-ai-agent-run-40-experiments-while-i-slept/)
- [Dev.to: OpenClaw cost on Reddit](https://dev.to/zacvibecodez/openclaw-cost-what-reddit-users-actually-spend-2026-42fl)
- [Tailscale and Termux for Claude Code](https://dev.to/skeptrune/how-i-use-claude-code-on-my-phone-with-termux-and-tailscale-nge)
