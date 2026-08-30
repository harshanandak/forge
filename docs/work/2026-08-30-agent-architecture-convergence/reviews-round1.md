# Round 1 review record

Plan reviewed: `plan-v1.md`

| Requested reviewer | Exact result | Score | Verdict |
| --- | --- | ---: | --- |
| Muse Spark 1.2 Contributor via OpenCode Go | `opencode-go/muse-spark-1.2-contributor`, completed after direct-CLI retry | 74.4 | REVISE |
| GLM 5.3 via OpenCode Go | `opencode-go/glm-5.3`, direct-CLI retry pending | pending | pending |
| DeepSeek V4 Pro via OpenCode | exact model absent from live catalog; no substitution | INCOMPLETE | unavailable |
| HY 4 Preview via OpenCode Go | `opencode-go/hy4-preview`, completed | 79.7 | REVISE |

## Shared corrections accepted

- Reuse current WorkPacket, RunReceipt, LeaseReceipt, MonitorReceipt, process lifecycle, Kernel events, and benchmark/evidence machinery. Do not add parallel contract families.
- Freeze exact SHA/runtime/platform baselines before changing runtime behavior.
- Quantify memory query, retrieval, privacy, deletion, latency, determinism, and admission gates.
- Split the over-bundled harness phase into authority binding, skill integrity, capability/adapter policy, and Agent Companion bridge.
- Put route rationale, policy/capability digests, permissions, timings, tokens, and cost in operator-visible receipts.
- State rollback for every phase and never auto-retry an ambiguous mutation.

## Local evidence added before v2

- Skill `invocation:user` is parsed but not retained by automatic routing; user-only `ship`, `review`, and `rollback` remain selectable.
- Skill sync silently shadows, overwrites, mixes, or deletes same-name directories without ownership-aware collision proof.
- Existing run and receipt contracts are mostly disconnected from production dispatch; the bridge, not another schema family, is missing.
- `forge status` builds the complete Kernel board four times. On the refreshed tracked remote, five `status --json` samples had a 1,199.4 ms median and emitted 571,541 characters; one snapshot spent 169.5 ms across four Kernel reads.
- All new redesign children currently have empty dependency lists despite prerequisites in their acceptance text.

## Dissent retained

The external reviews prefer measurement-only as the first slice. The local audit also found an immediate user-only invocation correctness bug. Plan v2 keeps measurement first, then makes invocation enforcement the first behavior change. The one-pass status snapshot follows as the first performance change.
