---
name: parallel-deep-research
description: >
  Heavyweight EXTERNAL research reports — market, industry, competitive, strategic — via
  Parallel AI's paid pro/ultra processors that crawl and synthesize dozens of sources into one
  long cited report. Use when the user wants a market analysis, competitive landscape,
  industry deep-dive, multi-vendor/technology comparison, strategic recommendations, or market
  sizing/growth outlook — any multi-source synthesis needing more than 3-4 web searches.
  Typical phrasings: "market analysis of X", "competitive landscape comparing A/B/C",
  "industry deep-dive on...", "deep research report on...", "strategic report with predictions
  for 2027". WRONG tool for quick facts, a single-page fetch, one-URL scraping, or small
  structured-field extraction — use built-in WebSearch/WebFetch. Also NOT the Forge RESEARCH
  or PLAN stage: "run the research stage", "do Phase 2", or codebase/OWASP/DRY investigation
  into a design doc route to `research` and `plan` (they may INVOKE this skill). Requires
  PARALLEL_API_KEY.
compatibility: Requires PARALLEL_API_KEY in .env.local. Uses curl. Takes 3-25 minutes.
metadata:
  author: harshanandak
  version: "1.0.0"
terminal: true
---

# Parallel Deep Research

Comprehensive research reports with multi-source synthesis. Use `pro` (3-9 min, $0.10) or `ultra` (5-25 min, $0.30) for deep analysis.

> **Safety:** The `input` is transmitted to Parallel AI's external service and may be logged or retained. Never include secrets, API keys/tokens, PII, or private/proprietary repo content — send only information safe to share with a third party.
>
> **CLI alternative (recommended)**: Install `parallel-cli` for official skill:
> `npx skills add parallel-web/parallel-agent-skills --skill parallel-deep-research`

## Setup

```bash
API_KEY=$(grep "^PARALLEL_API_KEY=" .env.local | cut -d= -f2)
```

## Create Research Task

```bash
curl -s -X POST "https://api.parallel.ai/v1/tasks/runs" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "input": "Analyze the AI chatbot market. Include: size, growth, key players, trends, competitive threats",
    "processor": "pro"
  }'
```

Response: `{"run_id": "trun_abc123...", "status": "queued"}`

## Get Result (polling)

The result endpoint returns both status and output in one call. Poll until `status` is `completed`.

```bash
RUN_ID="trun_abc123..."
MAX_POLLS=180  # 30 min max (180 × 10s)

for i in $(seq 1 $MAX_POLLS); do
  RESULT=$(curl -s "https://api.parallel.ai/v1/tasks/runs/$RUN_ID/result" \
    -H "x-api-key: $API_KEY")

  STATUS=$(echo "$RESULT" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)

  if [ "$STATUS" = "completed" ]; then
    echo "$RESULT"
    break
  elif [ "$STATUS" = "failed" ]; then
    echo "Task failed: $RESULT"
    break
  fi

  echo "Poll $i/$MAX_POLLS — Status: $STATUS"
  sleep 10
done

if [ "$i" = "$MAX_POLLS" ] && [ "$STATUS" != "completed" ] && [ "$STATUS" != "failed" ]; then
  echo "Timeout: task did not complete within 30 minutes"
fi
```

## Processors

| Processor | Speed | Cost | Use For |
|-----------|-------|------|---------|
| pro | 3-9 min | $0.10/task | Market analysis, strategic reports |
| ultra | 5-25 min | $0.30/task | Comprehensive deep research |

## Example: Market Analysis

```json
{
  "input": "Analyze the AI chip market in 2024. Include market size, growth rate, key players (NVIDIA, AMD, Intel), emerging competitors, and 2025 outlook.",
  "processor": "pro"
}
```

Result: Markdown report with citations.

## When to Use

- Market research and competitive analysis
- Strategic reports requiring multiple sources
- Research that needs synthesis across many documents
- Any task that would need more than 3-4 web searches to answer properly

For quick facts or single-source lookups, use built-in WebSearch instead.

## Timeout

Set polling timeout to 1800s (30 min) for ultra tasks. Pro tasks typically complete in 3-9 min.
