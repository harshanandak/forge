# FORGE-1662 shape r1: rules, memory, config for coding agents (2026-11-21)

Method: about 17 web searches and 6 page fetches. Most sources are blogs, issue trackers and vendor pages. No X posts were reachable through search, so X reaction is unverified. Reddit evidence is second-hand (via blogs and issue trackers). Items marked (unverified) were not opened.

## What exists

| Area | Examples | Scope model | Enforced? | Provenance / test |
|---|---|---|---|---|
| Rules files | AGENTS.md, CLAUDE.md, .cursor/rules (4 modes: always, auto-attached by glob, agent-requested, manual) | Path, glob, nested dir | No. Advisory context | None |
| Rule sync | agentsync, rulesync, agentscribe, agentcontext | Copies one source to many files | CI check for drift only | None |
| Claude Code settings | Layers: managed > CLI flags > local > project > user. Permission rules merge across layers | 5 layers | Yes for permissions and hooks | No "effective value and source" view found |
| Hooks | PreToolUse exit 2 blocks. Managed-only hooks switch | Per layer | Yes, but bugs reported for subagents | None |
| Memory | ChatGPT memory, Claude memory, Claude Code auto memory (per working dir, MEMORY.md, /memory), Cursor memories (UI removed in 2.1.x) | Per project dir or global | No | Manual edit only |
| Transcript miners | CodeYam Memory, Afterpaths, sheal, mine-transcripts skill, Ditto | Path-scoped rules (CodeYam) | Rules still advisory | Afterpaths cites session ID per rule |
| Runtime policy | Cupcake (OPA/Rego), Rampart, Prempti (Falco), CodePiper, Cerbos Synapse, Endor Labs | Per tool call | Yes, with monitor mode in Rampart and Prempti | Audit logs |
| Policy-as-code prior art | GitHub rulesets (Evaluate), IAM Access Analyzer custom checks, OPA decision logs | Org/repo/account | Mixed | Evaluate mode and decision replay |

## What users praise

- Hooks as the fix. Many posts say hard rules belong in hooks, and CLAUDE.md should hold intent. Source quality: blogs.
- Review before write. CodeYam launched on Product Hunt (142 upvotes, rank 13). Maker: "You review and approve everything." Commenter: stale context is "probably our #1 source of wasted time."
- Path scoping. CodeYam loads a rule only when matching files are touched. A commenter said cloud sync only helps if scoping is "airtight."
- One canonical file plus generated copies. Several guides recommend AGENTS.md as source with a one-line CLAUDE.md pointer.
- Mechanical blocks. The Demotion Ladder author found that a hard block "usually hands off to him", while soft rules were "often worked around."

## What users complain about

- Ignored rules. GitHub issues #6120 (claude-code), a Definition of Done checklist skipped (opened Mar 2026), and 33603 (hard rules ignored). One HN commenter (DiskoHexyl): "CC barely manages to follow all of the instructions within a single session in a single well-defined repo."
- Compliance decays. The Demotion Ladder cites (preprints, unrefereed): violations rose from 0 to 30% after compaction; "never do X" compliance fell from 73% at turn 5 to 33% at turn 16; file size and position did not matter in a 1,650-session study.
- AGENTS.md may not help. ICLR 2026 workshop paper (Gloaguen et al.): no gain in task success, over 20% more inference cost.
- Cursor rules silently downgraded. A 3.0.16 report says alwaysApply rules became "requestable." Cursor 2.x and Auto-mode threads say rules are skipped. Cursor hooks are called "unstable" (Cursor forum).
- Hooks fail too. Reports that PreToolUse exit 2 or JSON deny does not block, or does not fire, for subagent/Task calls (issues 40580, 26923, 34692, 42385). Many are closed. Current status unverified.
- Declared but not enforced, in the wild. One audit (The Infinity, 2026-08-14): 7 guardrails declared, 5 enforced nothing. Causes: `set -e` in guard scripts, plugin-scoped variables going inert after uninstall, JSON field name mismatch, archived agents still loaded. The fix was a 71-check test suite that feeds each guard a bad input.
- Memory:
  - ChatGPT: "Memory updated" with nothing saved, silent failure when full, resurrected deletions, over-saving (OpenAI community forum).
  - HN on Claude memory: "just another unwanted 'memory' feature that I now need to turn off" (CamperBob2); "ChatGPT put all kinds of nonsense into its memory" (cruffle_duffle).
  - Claude Code: stale MEMORY.md served mid-task (reported May 2026, r/ClaudeAI via aiweekly); auto memory scoped per working directory so unrelated projects share it (issue 91738, Sep 2026); request for user-scoped entries (issue 48416, Apr 2026); agent falsely claims memory is project-agnostic (issue 81040).
  - Cursor: memories UI removed in 2.1.x. Users wanted them back and some lost large sets.
- Cost moves, it does not vanish. Demotion Ladder: 5,000 lines of rules became 13 hooks (about 1,300 lines) plus config, 6,600 lines total. Review and test time rose from about 1 week to 3-4 days per slice.

## Closest prior art for scope, provenance, enforcement status and dry run

- Dry run: GitHub rulesets have three statuses: Disabled, Active, Evaluate. Evaluate does not enforce, and "Rule Insights" shows what would have passed or failed. Caveat: insights are not logged until a PR is merged or a merge is attempted. This is forward-looking, not a replay of history.
- Replay on history: OPA decision logs hold the input, the policy queried and bundle metadata, and the docs say they support "decision replay." There is no built-in candidate-vs-recorded diff; you build it. You also need the old policy version. Styra DAS has a replay mode (vendor).
- Monitor mode for agents: Rampart and Prempti ship log-only and enforce modes (vendor descriptions).
- Static checks: IAM Access Analyzer custom checks return PASS/FAIL, flag a new policy version as more permissive than the old one, and fail closed when unsure. No history replay.
- Provenance: Afterpaths (2 GitHub stars) stamps each rule with a source session ID. Settings docs give an order of layers, but no view of "this value came from here" was found.
- Promotion and demotion: the Demotion Ladder is the only found product-like model of moving a rule from prose to a hook after it fails. It is a manual blog practice, not a tool.
- Declared vs enforced: found only as a personal audit (The Infinity). No product reports it. (Conftest and Cedar analysis searches returned nothing relevant; unverified.)

## What we can do

- Label every item with kind and scope, and show the proposal on a card. Nothing found does both. Rule sync tools copy text; they do not classify.
- Show "in force here" with source by reading the settings layers, rules files, hooks and memory directories. Sources are documented and local.
- Mark a law's status by testing it. The audit's method (feed each guard a bad input, expect a block) is cheap and finds real failures (5 of 7).
- Dry run by replaying recorded tool calls and PR events against a candidate rule. Tool-call transcripts exist locally. Start with hook-style rules, which are matchable on a tool name plus arguments.
- Promote note to rule after a second break, following the Demotion Ladder pattern, with the human accepting.
- Overseer proposals with approval, following CodeYam and mine-transcripts (diffs for human review).

## What we cannot or should not do

- Do not claim a rule is enforced because a hook exists. Subagent and Task hook bugs mean "enforced" needs a live probe, and a status can go stale.
- Do not dry-run prose rules. A rule like "extract duplicate logic" needs judgment; the Demotion Ladder author left these as prose on purpose. Replay needs a mechanical predicate.
- Do not auto-write rules. Users already distrust silent memory writes.
- Do not promise a dry run is accurate. Without the old policy version and full inputs, replay is partial (OPA caveat), and reviewers (9 blinded) missed all 15 non-compliant sessions in one preprint, so transcript-reading is not a reliable check either.
- Do not add more rule text by default. The evidence says more text may not help (ICLR paper) and compliance decays within a session.

## Simplify

Three kinds are enough at first: note, rule, law. Decision can be a note with an expiry. Show one status on a law: enforced, broken, unenforced. Start with project and all-projects scope; add the rest as users ask.

## Converge

Everything converges on the same shape: one canonical source (AGENTS.md), hooks for hard rules, monitor-then-enforce, and human-approved rule proposals from transcripts. Our placement card, config map and overseer fit that shape rather than fight it.

## Double down

- Enforcement status with proof (probe results). Only found as a one-off personal audit.
- Dry run on history. Evaluate mode is mature, but forward-only, and nothing found replays agent history.
- Provenance plus effective value in one map. Settings docs give order but not a per-value view.
- Demotion/promotion as a first-class action.

## Unknowns

- Whether Claude Code or Cursor shipped any "effective config" view in 2026. Not found, not proven absent.
- Current status of the subagent hook bugs.
- Real X reaction. Nothing reached.
- Whether the 2026 preprints hold up. All unrefereed.
- How many users want scope labels versus fewer rules. No demand data.
- Anthropic's memory docs were not read first-hand.

## Sources

- [Demotion Ladder (HackerNoon)](https://hackernoon.com/the-demotion-ladder-a-year-of-governing-claude-code)
- [I audited my agent's guardrails (daily.dev excerpt)](https://daily.dev/posts/i-audited-my-ai-agent-s-guardrails-most-of-them-weren-t-running--iejklp8mp)
- [CodeYam Memory (Product Hunt)](https://www.producthunt.com/products/codeyam-cli-memory)
- [Afterpaths](https://github.com/burnssa/afterpaths)
- [HN thread on Claude memory](https://hn.svelte.dev/item/45684134)
- [Evaluating AGENTS.md (arXiv)](https://arxiv.org/abs/2602.11988)
- [Claude Code settings docs](https://code.claude.com/docs/en/settings)
- [GitHub rulesets docs](https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)
- [OPA decision logs](https://www.openpolicyagent.org/docs/management-decision-logs)
- [IAM Access Analyzer custom policy checks](https://docs.aws.amazon.com/IAM/latest/UserGuide/access-analyzer-custom-policy-checks.html)
- [Hook exit code ignored for subagents (issue 40580)](https://claudeissues.com/issue/40580-pretooluse-hook-exit-code-ignored-for-subagent-tool-calls)
- [Auto memory per-directory scoping (issue 91738)](https://claudeissues.com/issue/91738-auto-memory-is-on-by-default-ignores-claude-ai-memory-settings-and-is-scoped-per)
- [Stale MEMORY.md mid-task](https://aiweekly.co/alerts/claude-code-serves-stale-memorymd-data-mid-task)
- [Cursor alwaysApply downgrade](https://forum.cursor.com/t/alwaysapply-true-rules-and-cursorrules-both-silently-treated-as-requestable-instead-of-auto-injected-cursor-3-0-16-macos/157431)
- [Cursor memories removed](https://forum.cursor.com/t/memory-tool-dissapeared/148405)
- [Prempti (CNCF blog)](https://www.cncf.io/blog/2026/05/20/introducing-prempti-policy-and-visibility-for-ai-coding-agents/)
- [Cupcake](https://github.com/leynos/cupcake)
- [Cerbos Synapse](https://cerbos.dev/blog/governing-ai-coding-agents-with-cerbos-synapse)
- [Unblocked: keeping rules files in sync](https://getunblocked.com/blog/keeping-claude-md-agents-md-cursorrules-in-sync/)
- [Anthropic CLAUDE.md rules are requests (fourweekmba)](https://fourweekmba.com/ai-anthropic-claude-md-rules-are-requests-hooks-are-enforced/)
- [ChatGPT memory failures (OpenAI forum)](https://community.openai.com/t/memory-issues-missing-saves-duplicates-and-no-carryover-to-new-chats/1113426)
