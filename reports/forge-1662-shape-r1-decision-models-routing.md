# forge-1662 shape r1: decision models and one-box routing

Date: 2026-11-21. Tags: [V] vendor claim, [I] independent, [U] user report, [?] not verified.

## Jev and its class (facts table)

| Item | Finding |
|---|---|
| What | TypeSafe AI "System One" model. Returns a typed decision, not text. Launched Sept 2026. Current: jev-1.13.0, jev-1.14.0 announced Oct 14. [V] |
| Question types | Noul (yes/no, returns probability), Choice (up to 255 options, probabilities plus confidence), Score (2 to 10 levels, weighted mean plus distribution plus confidence). Box (images, experimental). [V via third-party deep dive] |
| Input | About 64k tokens shared by state and all questions; state plus one question about 32k. Long-context header: 262k, slower and less accurate. Text, JSON, arrays. Images experimental. Audio and video must be converted. [V] |
| Latency | 70 to 500 ms end to end, most near 100 ms, US West Coast. 13 questions over one 53k-char article took 0.27 s in one call vs 2.71 s as 13 calls (jev-1.12 cookbook). [V] |
| Price | $0.042 per 1M input tokens, output free. Resellers differ (one lists $0.0578). No free tier. [V] |
| Rate limits | 80 req/s, 100k tokens/s, early access. Signups paused late Sept. [V] |
| Calibration | Trained with RLCD. 84.6% MMLU-Pro with ECE 0.031 reported by one paper. [V, secondary] TypeSafe published no public benchmarks of its own. [?] |
| Privacy | Not trained on requests. Zero data retention only on enterprise (contact sales) or via Vercel Gateway Pro and Enterprise. Opt-in query sharing for debugging since October. [V] I found no full privacy policy text. [?] |
| Self-host | No. Hosted only, weights unpublished. SDKs are MIT. [V] |
| Thoughtworks Radar | Vol. 35 lists "Decision models" in Platforms, Assess ring, no description. Jev appears only as an example in the "Beyond frontier models" theme. [I] |

## Limits

From "What Can't Jev Decide?" (2610.24929) [I, preprint, 11 authors]:
- Selecting among records is fine up to 20k tokens and 64 options.
- Answers needing two or more state updates drop to 53 to 80% at sixteen updates.
- It follows a stale summary and inherits its errors. Confidence flags its own errors but not these inherited ones (AUROC about 0.53). A trained hand-off option did not help.
- Fails on items an LLM solves only through intermediate steps: Jev got 97.5% of items one LLM pass solves, 74% of the rest.

Other documented limits [V, via TypeSafe jaggedness page]: literal reading, weak at counting, dates, arithmetic. Score levels weakly calibrated, so use for thresholds and ranking, not magnitudes. Degrades with contradictory criteria, deep indirection, large irrelevant state. Steering text inside inputs can move answers. No text, code or explanation output.

Independent practitioner data:
- Amplitude, 791 labeled decisions [I, product company]: Jev agreed with the frontier model 6 to 8 points more than with ground truth. Confident errors clustered on similar intents. A cascade gated at 0.80 matched frontier accuracy at about 1/4 cost and 1/2 latency.
- BANKING77 pilot, 77 cases: mean confidence 87.4% vs 75.3% accuracy, about 12 points overconfident.
- Support routing test on HN [U]: Jev 92.2%, Haiku 93.6%. Near parity.
- "Evaluating and Benchmarking Jev" (2609.37647, 37 datasets vs two open-weight LLMs): I could not read the body. [?]
- The Hitchhiker's Guide (2610.33775): a survey with no benchmark results. Useful for the cascade idea (fast model first, slow model on low confidence). [I]
- Typed Decision Models audit (2609.32160): could not read the body. [?]

## Alternatives including local ones

| Option | Size and terms | Note |
|---|---|---|
| Cloudflare Clef / Clef-flash | 27B and 9B, Apache 2.0, Qwen fine-tunes, Oct 1 | Same request format. Cloudflare reports median 209 ms (Clef), 38.8 ms (flash) vs Jev 524 ms. Clef costs $0.24/M on Workers AI. Datasets not public. [V] |
| Laya | 322M to 421M, ModernBERT-large, 100+ languages | Non-autoregressive, pip install, CPU-feasible. License not stated. [?] |
| Kev | 0.8B, 4B, 9B on Qwen3.5 | Implements the Jev API contract locally. License not stated. [?] |
| Von | about 395M | pip install. [?] |
| NanoJev | 0.6B | CUDA example. [?] |
| Nimble (Bespoke) | 9B plus LoRA | Research leaning, needs GPU. [?] |
| Embedding routers | 25 to 50 ms | Fast but confuse similar targets (LatentGate, ACL 2026 industry). Prompt-based LLM routers: 70 to 77% at 100 agents, 1.5 to 2 s. [I] |
| Switchcraft | DistilBERT, 66M | 82.9% accuracy on function-calling routing (Microsoft Research). [I] |
| Constrained-output small LLM | any local 1B to 9B with JSON schema or logprobs | Generic fallback. No source tested it for our questions. [?] |

DataCamp's guide says these projects are very new and not all examples were tested end to end. No independent head-to-head accuracy table was found.

## Which of our questions fit

Fit a one-pass model (short input, bounded options, facts supplied in the prompt):
- Does the human need this now (yes/no, thresholded).
- How important is this event for the timeline (score, used for ranking only).
- Which kind and scope should a statement get (choice, few options).
- Ambiguous route among 6 destinations (choice over the 6, with candidate thread names as options).

Fit with care:
- Moving, waiting or stuck: fits only if we compute the facts (last event age, pending approval flag) and pass them. Do not hand it a long raw log. The multi-update result says a long event history it must track itself degrades to 53 to 80%.
- Is this correction worth a rule: judgment over intent and generality. Use as a cheap first filter, with a stronger model or the human confirming.

Do not fit:
- Anything that depends on a stale summary being right. The model inherits it and its confidence will not warn you.
- Rule text, thread summaries, explanations. No generation.
- Counting or date logic. Compute in code.

## Routing UX prior art

- Raycast: Quick AI via Tab from root search, optional fallback of unmatched text to AI, explicit @-mentions for extensions, Screen Awareness context (Aug 2026). Routing is user-chosen, not inferred. [V, manual]
- Cursor: Auto model routing. Mentions and a command pop-up exist. [U forum]
- Claude Code and Cursor: queue vs steer for a running agent is a live design problem. Cursor docs split queued messages from an immediate steer channel. [V + U]
- Omnibox pattern: short query to search, long input to chat. Local classification is private and fast but weaker on edge cases. [secondary article]
- Google guidance: intent classification into categories such as info, feature, settings, to keep downstream prompts focused. [V]
- Agentic UX guidance (Smashing, Feb 2026): intent preview with proceed, edit or handle-myself, then an activity log with undo. [I, essay]
- Not found: documented auto-routing behavior for Slack, Notion, Linear, Copilot participants or Wispr Flow. [?]

## User reactions

- Delight: nothing 2026-specific found for self-routing prompts. [?]
- Anger, Cursor Auto: users ask which model answered, report silent switches (even when a model was pinned), and quality drift. A "show the model" request ran April 2025 to June 2026 and closed without clear restoration. [U]
- Anger, steering: corrections sit unread for minutes, interrupts kill running processes and subagents, and CLI and Desktop behave differently. Users ask for a visible queue with a per-item "steer now" button. [U, GitHub issues]
- Cursor command pop-up stole Enter from normal chat input and caused unintended commands. [U]
- Wispr Flow: complaints are about reliability, CPU use and privacy, not routing. [U]
- Pattern: people forgive a wrong route they can see and undo. They resent hidden or unannounced routing.

## What we can do

1. Facts-first routing in code (object has owner thread) before any model. Most prompts end here.
2. One-pass choice over a closed option list for the remaining ambiguity, with the confidence threshold tuned on our own labeled log.
3. Show the chip before send, with one-tap change and a short undo. Log every override as a label.
4. Batch several cheap questions about one event in one call. The 13-in-1 example cut time 10x. [V]
5. Run a local model (Laya, Kev, or Clef-flash class) so no thread content leaves the machine. Keep Jev-compatible request shape so backends can swap.

## What we cannot or should not do

- Trust confidence as proof of freshness. Stale input gives confident wrong answers.
- Auto-send low-confidence or destructive routes (config change, steer of a running agent) without the chip.
- Use Jev hosted for private thread content unless zero data retention is bought. ZDR is enterprise only and signups were paused.
- Depend on one vendor: weights closed, early-access limits, versions change under `jev-latest`.
- Use Score magnitudes as numbers.

## Simplify

Two stages only: code rules, then one choice call with a fallback to "ask the user via chip". Do not build a model per question. Start with the router and the "need now" yes/no.

## Converge

Everything points the same way: fast model first, thresholded, with a slower check or human on low confidence (Amplitude cascade, Hitchhiker's Guide, agentic UX intent preview). The chip is the human check. Overrides become the calibration data.

## Double down

Visible destination plus undo. Every cited anger case is hidden routing or silent switching. The chip is also the feedback loop that fixes the weak calibration.

## Unknowns

- Body of 2609.37647 and 2609.32160 (PDFs unreadable here).
- Licenses of Laya, Kev, Von, NanoJev.
- Accuracy of any local model on our six destinations and five per-event questions. Needs our own labeled set (suggest 200 to 300 logged prompts).
- Real-world latency on this machine, local CPU vs GPU.
- Jev privacy policy text and retention period without ZDR.
- Docs from typesafe.ai were not fetched directly. Facts come from a third-party deep dive, LiteLLM and a pricing review.
- Whether Slack, Notion, Linear, Copilot or Wispr auto-route. No evidence found.

## Sources

- [What Can't Jev Decide? (2610.24929)](https://arxiv.org/abs/2610.24929)
- [Hitchhiker's Guide to System 1 Models (2610.33775)](https://arxiv.org/abs/2610.33775)
- [Evaluating and Benchmarking Jev (2609.37647)](https://arxiv.org/pdf/2609.37647)
- [Typed Decision Models audit (2609.32160)](https://arxiv.org/pdf/2609.32160)
- [Thoughtworks Technology Radar](https://www.thoughtworks.com/radar)
- [Deep dive into Jev (flaviocopes)](https://flaviocopes.com/jev.md)
- [Jev pricing (flaviocopes)](https://flaviocopes.com/jev-pricing/)
- [LiteLLM Jev page](https://docs.litellm.ai/blog/typesafe_jev)
- [Amplitude analysis of Jev](https://amplitude.com/blog/jev-analysis)
- [DataCamp open-source Jev alternatives](https://www.datacamp.com/blog/top-open-source-jev-alternatives)
- [Cloudflare Clef](https://blog.cloudflare.com/clef-decision-models/)
- [The Register on Clef](https://theregister.com/ai-and-ml/2026/10/01/cloudflare-tries-to-outplay-jev-with-open-weight-clef-models/5300649)
- [LatentGate (ACL 2026 industry)](https://aclanthology.org/2026.acl-industry.153.pdf)
- [Switchcraft (2605.07112)](https://arxiv.org/html/2605.07112)
- [Raycast Quick AI](https://manual.raycast.com/ai/quick-ai)
- [Cursor forum: Auto mode should display model](https://forum.cursor.com/t/auto-mode-should-display-which-model-is-being-used/73744)
- [Smashing: agentic AI UX patterns](https://smashingmagazine.com/2026/02/designing-agentic-ai-practical-ux-patterns/)
- [Claude Code issue: steering ignored during tool execution](https://claudeissues.com/issue/91809-claude-ignores-user-steering-messages-sent-during-active-tool-execution)
- [Cursor forum: command pop-up steals input](https://forum.cursor.com/t/agent-pop-up-conflicts-with-chat-window-input-ux-agonizing-pain/132533)
