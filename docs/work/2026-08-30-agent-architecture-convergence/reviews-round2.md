# Round 2 review record

Plan reviewed: `plan-v2.md`

| Requested reviewer | Exact result | Score | Verdict |
| --- | --- | ---: | --- |
| Muse Spark 1.2 Contributor via OpenCode Go | `opencode-go/muse-spark-1.2-contributor`, completed | 83.5 | REVISE |
| GLM 5.3 via OpenCode Go | exact model ran once but exhausted its length budget before a scorecard; concise retry pending | INCOMPLETE | pending |
| DeepSeek V4 Pro via OpenCode | `opencode/deepseek-v4-pro` resolved, invocation failed with provider 401 insufficient balance; no substitution | INCOMPLETE | unavailable |
| HY 4 Preview via OpenCode Go | `opencode-go/hy4-preview`, completed | 81.8 | REVISE |

## Resolved from round 1

- Authority/run identity and terminal transitions are explicit.
- Observer evidence cannot directly grant authority.
- Memory safety and admission have numeric gates.
- Operator receipts expose route, policy/capability digests, timings, tokens, cost, and terminal reason.
- Every delivery slice has a rollback path.
- Existing run/receipt and MonitorRuntime machinery is reused.

## Remaining blockers for v3

- Freeze a small permission taxonomy, grant-authority intersection, default-deny mutation mapping, and conformance rows.
- Make the existing-contract gap audit test-driven and prohibit `AuthorityBundle` as a new type unless a failing contract test proves no current envelope can carry the invariant.
- Clarify that OpenCode, Pi, and DeepSeek Harness are dispatch targets inside the one Agent Companion execution adapter, not three new adapters in the first release.
- Freeze and hash the recall corpus, sample size, paired statistical method, and terminal transition fixtures.
- Define completion as fresh verification of every requested sub-object, not a provider's `completed` string.

No reviewer found a new architecture-level critical flaw. Round 3 should judge only the complete v2 plan plus the v3 amendments.
