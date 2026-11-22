# forge-1662 shape r1: blocks and timelines

Date: 2026-11-21. Method: web search plus page fetches. Vendor claims are marked [V]. User reports are marked [U]. Anything I could not confirm is marked [UNVERIFIED]. I found no usable X or Reddit posts with quotable text. The user voices below come from Hacker News, vendor forums and blogs. Treat that as a gap.

## Block interfaces that worked and why

- **Raycast.** Extensions are submitted as pull requests to one public repo, reviewed by staff, and the team features three per month. More than 100 extensions existed during beta [V]. Why it worked: one shared language (TypeScript/React), one review gate, one place to install from. The sources do not give an install count, so the growth story is [UNVERIFIED].
- **Grafana.** Panels, data sources and apps are separate plugin types. Plugins carry a signature state (signed, modified, unsigned). Only admins can use the catalog, and unsigned plugins are not supported in Grafana Cloud [V]. Why it worked: a narrow contract (query in, panel out) and a trust label on every plugin.
- **Home Assistant.** Stock cards give a working dashboard "in an afternoon" [U, blog]. Custom cards come through HACS. Mushroom says its goal is not deep customisation and points to button-card for that [V]. Why it worked: good defaults first, power tools one layer down.
- **Notion.** Templates cut blank-page paralysis. One writer claims people who start from templates stay longer [U, anecdote, no data].
- **Linear.** Pulse (April 2025) is a generated feed with a daily or weekly schedule, now with a one-sentence takeaway on top [V]. The June 2026 "Write with Agent" drafts project updates from issue, doc and Slack activity since the last update. A human edits and publishes [V]. This is the closest match to our "event-derived, human-gated" shape.

## Block interfaces that failed and why

- **Almost nobody changes defaults.** Jared Spool (2011, informal): "Less than 5% of the users we surveyed had changed any settings at all." Programmers and designers changed 40% or more. Old data, one product. An encrypted-DNS study found 71.7% kept defaults (arXiv 2208.04991). Retirement plans are a counterexample: 59% changed defaults within a few years (US DOL). Defaults stick when stakes are low.
- **Empty canvas.** Notion write-ups describe "Blank Page Paralysis" [U, blogs]. No hard figure on share of Notion users who build their own layouts. I did not find one for Retool or Home Assistant either. [UNVERIFIED]
- **Obsidian plugins.** No sandbox. Obsidian's own help says it "cannot reliably restrict plugins to specific permissions." In an HN thread (about a 2026 shared-vault malware campaign), one user: "99% of Obsidian plugins don't need full disk access, or internet access for that matter." The CEO: "People should be able to do powerful things if they choose to. But that will always come with the risk of misuse." The ecosystem is big, and the trust model is the weak point.
- **Settings pages as the only path.** HA's custom cards are described as "extremely time consuming" to set up [U, blog].

## Agent-rendered UI and its risks

- **MCP Apps** (announced 2026-01-26, built with MCP-UI maintainers) render UI in a sandboxed iframe with a default CSP. UI talks to the host over postMessage JSON-RPC, and the host proxies tool calls. Hosts can review HTML first and log UI messages [V, spec and blog]. A claim of a July 2026 spec revision came from one blog only [UNVERIFIED].
- **Known attacks in 2026.** A Cloud Security Alliance note (June 2026) describes injected Markdown rendered in the ChatGPT panel as phishing. A Copilot flaw used hidden HTML and CSS [V, researchers]. One blog argues that in generative UI "the interface itself becomes the phishing vector," and says to require host-drawn confirmation for irreversible actions [U, opinion].
- **Claude artifacts and v0 sandbox details**: not found. [UNVERIFIED]
- **Takeaway:** a block that only runs a query and draws it is safe by construction. A block that ships HTML is code from a stranger, or from a model reading untrusted logs. Event logs contain text from web pages and tool output, so they are an injection path.

## Timeline and summary prior art

- **Linear Pulse** and agent-assisted updates (above) [V].
- **incident.io** Suggested Summaries (January 2024): the AI proposes an updated summary and you accept, skip or edit. The stated problem: summary updates "can fall by the wayside" [V]. No freshness metrics published.
- **Datadog** posts AI summaries about every 10 minutes during bridge calls. **Rootly** has a `/rootly catchup` command [V].
- **Slack** recaps are gated to Business+ and Enterprise+, with an add-on at $10 per user per month on Pro. Slack claims 95 minutes saved per week [V, unverified by third parties]. Stanford IT warns Slack AI can misread tone and repeat errors [V, institution].
- **Claude Code Agent View** (2026-05-11, research preview) groups sessions as Needs input, Working, Completed [V]. This is our one-count-and-one-line idea, shipped by the platform vendor. Critics say a dashboard does not fix the trust gap [U, secondary sources].
- **Semantic zoom and one-line status**: I found no direct evidence or studies. [UNVERIFIED]

## What users say about AI summaries

- **Omission beats error.** Atlassian forum poster: a summary can be right sentence by sentence and still drop the blocker. Another: dashboard green, AI says on plan, real delay lived in an unlogged conversation [U, 2026, paraphrased from search extracts, thread body not retrievable].
- **Fix proposed by users:** link every summary to raw data, list what it does not cover, flag when a summary contradicts metrics [U].
- **Trust numbers.** A 2026 survey (cited second-hand by an essay, not verified): 96% of developers doubt AI code is fully correct, 48% always verify before commit.
- **Event-derived beats self-reported.** An essay, "The Standup Is Lying" (2026-06-26): standups capture "a human's intention," not "a system's state." It says to build status from commits, merged PRs, CI results and review queue depth [U, opinion, no data].
- **Linear removed issue discussion summaries** from its AI workflows in May 2026, per a pricing tracker [UNVERIFIED, third-party].
- No controlled study comparing event-derived and chat-summarised status was found.

## What we can do

1. Ship blocks as data: a query, a view type from a fixed set (list, timeline, card, chart), actions from a whitelist, and a scope. No code runs.
2. Render agent-written HTML only in a sandboxed iframe with CSP, no network, no storage, and host-drawn buttons for any action. MCP Apps is the template.
3. Show a trust label on each block (built-in, mine, shared, agent-written HTML), like Grafana's signature states.
4. Put a link to source events on every sentence of status. Add a "not covered" line.
5. Write timeline rows from events. Call the model only for a rollup when events changed, and show the event count behind it.
6. Start with 5 to 7 default blocks that work with zero setup. Offer customisation by prompt ("add a block for CI time by job") and show the resulting file.
7. Adopt Agent View's states (needs input, working, done) for the attention count.

## What we cannot or should not do

- Rely on users to build layouts. Plan for under 5% to change anything [Spool, old].
- Let a shared block run code with access to the log. Obsidian shows the cost.
- Let the model write the sentence status without event backing. That is the omission failure.
- Auto-publish summaries. Linear keeps a human gate on updates.
- Claim figures on semantic zoom or one-line status. We have none.

## Simplify

Two block kinds only for v1: declarative (query plus view) and sandboxed HTML. Three states for the count. One-line status = state word plus one sentence plus event count. Drop the marketplace until sharing by file works.

## Converge

Most sources point to the same shape: defaults carry the product, customisation is a layer for the few, status comes from events, and a model adds a thin readable layer with links back. Linear (human-gated, activity-derived drafts), incident.io (suggest, accept) and Agent View (state groups) all agree.

## Double down

- Event-derived status with visible provenance. It answers the top user complaint (omission, stale, unlogged problems).
- Customisation by prompt that writes a readable file. It sidesteps both the empty canvas and the settings page.
- A strict permission model for blocks, declared in the file, shown to the user before install.

## Unknowns

- Share of users who customise in Notion, Retool, Grafana, HA: no figure found.
- What drove Raycast and Obsidian plugin growth: no causal evidence found.
- How Claude artifacts and v0 sandbox HTML.
- Whether prompt-authored blocks are more used than settings pages.
- Any X or Reddit reaction text. Search returned none.
- Whether one-line statuses build trust better than longer ones.
- Whether a 5-minute timeline cadence is stale or noisy for users.

## Sources

- [Spool, Do users change their settings (2011)](https://archive.uie.com/brainsparks/2011/09/14/do-users-change-their-settings/)
- [Encrypted DNS defaults study](https://arxiv.org/pdf/2208.04991)
- [US DOL, opting out of plan defaults](https://www.dol.gov/agencies/ebsa/researchers/analysis/retirement/opting-out-of-retirement-plan-default-settings)
- [HN thread on Obsidian plugin security](https://hn.svelte.dev/item/48088576)
- [Obsidian plugin security help](https://obsidian.md/help/plugin-security)
- [MCP Apps announcement (2026-01-26)](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/)
- [MCP Apps spec SEP 1865](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp)
- [CSA note, ChatGPhish (2026-06)](https://labs.cloudsecurityalliance.org/research/csa-research-note-chatgphish-ai-ui-prompt-injection-20260601)
- [Linear Pulse (2025-04-16)](https://linear.app/changelog/2025-04-16-pulse)
- [Linear agent-assisted project updates (2026-06-18)](https://linear.app/changelog/2026-06-18-agent-assisted-project-updates)
- [incident.io, stale summaries (2024-01-30)](https://incident.io/thedebrief/episode-ten)
- [Rootly catchup](https://docs.rootly.com/ai/incident-catchup)
- [Claude Code Agent View](https://claude.com/blog/agent-view-in-claude-code)
- [The Standup Is Lying (2026-06-26)](https://tianpan.co/blog/2026-06-26-the-standup-is-lying-coordinating-work-when-agent-fleets-run-overnight)
- [Atlassian community, AI project updates](https://community.atlassian.com/forums/Program-Management-Professionals/Are-AI-generated-project-updates-improving-clarity-or-just/td-p/3235365)
- [Stanford IT on Slack AI](https://uit.stanford.edu/node/30306)
- [Grafana plugin signing](https://grafana.com/docs/grafana/latest/plugins/plugin-signature-verification/)
- [Raycast extension guidelines](https://manual.raycast.com/extensions-guidelines)
- [Mushroom cards](https://cdn.jsdelivr.net/gh/piitaya/lovelace-mushroom@main/README.md)
