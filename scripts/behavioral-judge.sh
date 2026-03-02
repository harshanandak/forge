#!/usr/bin/env bash
# behavioral-judge.sh — Score /plan output using OpenRouter LLM judges
#
# Usage:
#   echo '{"plan_output": "..."}' | bash scripts/behavioral-judge.sh
#   bash scripts/behavioral-judge.sh '{"plan_output": "..."}'
#
# Environment:
#   OPENROUTER_API_KEY              — Required (unless test mode)
#   BEHAVIORAL_JUDGE_TEST_MODE      — Set to 1 to skip real HTTP calls
#   BEHAVIORAL_JUDGE_MOCK_SCORES    — JSON scores for test mode, e.g. '{"security":4,"tdd":5,"design":4,"structural":3}'
#   BEHAVIORAL_JUDGE_MOCK_PRIMARY_FAIL   — Set to 1 to simulate GLM-5 failure
#   BEHAVIORAL_JUDGE_MOCK_SECONDARY_FAIL — Set to 1 to simulate MiniMax failure
#   BEHAVIORAL_JUDGE_MOCK_TERTIARY_FAIL  — Set to 1 to simulate Kimi failure
#
# Output (stdout): JSON scoring result
# Scores are NOT written to stderr — only diagnostic messages go there

set -e

OPENROUTER_BASE_URL="https://openrouter.ai/api/v1/chat/completions"
MODEL_PRIMARY="z-ai/glm-5"
MODEL_SECONDARY="minimax/minimax-m2.5"
MODEL_TERTIARY="moonshotai/kimi-k2.5"

# Weighted scoring: security×3, tdd×3, design×2, structural×1 — max 45
WEIGHT_SECURITY=3
WEIGHT_TDD=3
WEIGHT_DESIGN=2
WEIGHT_STRUCTURAL=1

# Classification thresholds
THRESHOLD_PASS=36
THRESHOLD_WEAK=27

# Read input from stdin or $1
if [ -n "$1" ]; then
  INPUT="$1"
else
  INPUT="$(cat)"
fi

# Extract plan_output text if input is JSON, otherwise use raw input
PLAN_TEXT="$INPUT"
if command -v python3 >/dev/null 2>&1; then
  EXTRACTED=$(echo "$INPUT" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('plan_output', sys.stdin.read() if hasattr(sys.stdin,'read') else ''))
except:
    pass
" 2>/dev/null) || true
  if [ -n "$EXTRACTED" ]; then
    PLAN_TEXT="$EXTRACTED"
  fi
fi

# ─── Judge prompt ────────────────────────────────────────────────────────────
build_prompt() {
  local plan_output="$1"
  cat <<PROMPT
You are a strict quality judge for an AI development workflow. Score the following /plan execution output.

Context: The forge /plan command has 3 phases:
- Phase 1: Design Intent (Q&A → design doc with success criteria, edge cases, ambiguity policy)
- Phase 2: Technical Research (OWASP analysis, TDD scenarios, library docs)
- Phase 3: Setup (branch, worktree, Beads issue, task list with TDD steps)

Scoring criteria (score each 0-5, where 5=excellent, 0=absent/unacceptable):

SECURITY (weight ×3): Does Phase 2 include OWASP Top 10 analysis? Are security test scenarios identified? Is injection risk addressed for external API calls?

TDD (weight ×3): Does Phase 3 task list have RED-GREEN-REFACTOR steps? Do >50% of tasks have explicit failing test step? Are test file paths specified?

DESIGN (weight ×2): Does Phase 1 produce a design doc with: success criteria, edge cases, out-of-scope, ambiguity policy? Is it specific (not generic)?

STRUCTURAL (weight ×1): Does Phase 3 include branch creation, worktree setup, Beads issue creation? Is a baseline test run included?

Output ONLY valid JSON with no explanation:
{"security": N, "tdd": N, "design": N, "structural": N}

Plan output to score:
${plan_output}
PROMPT
}

# ─── Compute weighted scores and classification ───────────────────────────────
compute_result() {
  local security="$1"
  local tdd="$2"
  local design="$3"
  local structural="$4"
  local judge_model="$5"
  local judge_calls="$6"

  local sec_weighted=$(( security * WEIGHT_SECURITY ))
  local tdd_weighted=$(( tdd * WEIGHT_TDD ))
  local des_weighted=$(( design * WEIGHT_DESIGN ))
  local str_weighted=$(( structural * WEIGHT_STRUCTURAL ))
  local total=$(( sec_weighted + tdd_weighted + des_weighted + str_weighted ))

  local result
  if [ "$total" -ge "$THRESHOLD_PASS" ]; then
    result="PASS"
  elif [ "$total" -ge "$THRESHOLD_WEAK" ]; then
    result="WEAK"
  else
    result="FAIL"
  fi

  cat <<JSON
{
  "result": "${result}",
  "total": ${total},
  "dimensions": {
    "security": {"raw": ${security}, "weighted": ${sec_weighted}},
    "tdd": {"raw": ${tdd}, "weighted": ${tdd_weighted}},
    "design": {"raw": ${design}, "weighted": ${des_weighted}},
    "structural": {"raw": ${structural}, "weighted": ${str_weighted}}
  },
  "judge_model": "${judge_model}",
  "judge_calls": ${judge_calls}
}
JSON
}

# ─── Parse scores from LLM JSON response ─────────────────────────────────────
parse_scores() {
  local response="$1"
  # Extract the JSON object from the LLM response content
  local content
  content=$(echo "$response" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    choices = data.get('choices', [])
    if choices:
        msg = choices[0].get('message', {})
        content = msg.get('content', '')
        print(content)
except Exception as e:
    pass
" 2>/dev/null) || true

  if [ -z "$content" ]; then
    echo ""
    return 1
  fi

  # Parse scores from content JSON
  local scores
  scores=$(echo "$content" | python3 -c "
import sys, json, re
text = sys.stdin.read().strip()
# Try direct JSON parse first
try:
    d = json.loads(text)
    s = int(d.get('security', -1))
    t = int(d.get('tdd', -1))
    de = int(d.get('design', -1))
    st = int(d.get('structural', -1))
    if all(0 <= x <= 5 for x in [s, t, de, st]):
        print(f'{s} {t} {de} {st}')
        sys.exit(0)
except:
    pass
# Try extracting JSON from surrounding text
m = re.search(r'\{[^}]+\}', text, re.DOTALL)
if m:
    try:
        d = json.loads(m.group(0))
        s = int(d.get('security', -1))
        t = int(d.get('tdd', -1))
        de = int(d.get('design', -1))
        st = int(d.get('structural', -1))
        if all(0 <= x <= 5 for x in [s, t, de, st]):
            print(f'{s} {t} {de} {st}')
            sys.exit(0)
    except:
        pass
sys.exit(1)
" 2>/dev/null) || { echo ""; return 1; }

  echo "$scores"
}

# ─── Call OpenRouter with given model ────────────────────────────────────────
call_openrouter() {
  local model="$1"
  local prompt="$2"
  local extra_params="$3"

  # Escape prompt for JSON
  local escaped_prompt
  escaped_prompt=$(echo "$prompt" | python3 -c "
import sys, json
print(json.dumps(sys.stdin.read()))
" 2>/dev/null) || escaped_prompt='""'

  local body
  body=$(cat <<JSON
{
  "model": "${model}",
  "messages": [{"role": "user", "content": ${escaped_prompt}}],
  "response_format": {"type": "json_object"},
  "temperature": 0${extra_params}
}
JSON
)

  local http_code
  local response
  response=$(curl -s -w "\n%{http_code}" \
    -X POST "$OPENROUTER_BASE_URL" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${OPENROUTER_API_KEY}" \
    -H "HTTP-Referer: https://github.com/forge-cli/forge" \
    -d "$body" \
    --max-time 60 2>/dev/null) || { echo "CURL_FAILED"; return 1; }

  http_code=$(echo "$response" | tail -n1)
  local body_only
  body_only=$(echo "$response" | sed '$d')

  # Check for HTTP error codes indicating we should fall back
  if [ "$http_code" = "429" ] || [[ "$http_code" =~ ^5 ]]; then
    echo "HTTP_ERROR_${http_code}"
    return 1
  fi

  echo "$body_only"
}

# ─── Test mode: bypass real HTTP calls ───────────────────────────────────────
if [ "${BEHAVIORAL_JUDGE_TEST_MODE}" = "1" ]; then
  # Determine which judge would succeed based on failure flags
  judge_calls=0
  judge_model=""
  _default_scores='{"security":4,"tdd":4,"design":4,"structural":3}'
  mock_scores="${BEHAVIORAL_JUDGE_MOCK_SCORES:-${_default_scores}}"
  all_failed=false

  # Attempt primary (GLM-5)
  judge_calls=$(( judge_calls + 1 ))
  if [ "${BEHAVIORAL_JUDGE_MOCK_PRIMARY_FAIL}" != "1" ]; then
    judge_model="$MODEL_PRIMARY"
  else
    # Attempt secondary (MiniMax)
    judge_calls=$(( judge_calls + 1 ))
    if [ "${BEHAVIORAL_JUDGE_MOCK_SECONDARY_FAIL}" != "1" ]; then
      judge_model="$MODEL_SECONDARY"
    else
      # Attempt tertiary (Kimi)
      judge_calls=$(( judge_calls + 1 ))
      if [ "${BEHAVIORAL_JUDGE_MOCK_TERTIARY_FAIL}" != "1" ]; then
        judge_model="$MODEL_TERTIARY"
      else
        all_failed=true
      fi
    fi
  fi

  if [ "$all_failed" = "true" ]; then
    echo '{"result": "INCONCLUSIVE", "reason": "all_judges_failed"}'
    exit 0
  fi

  # Parse mock scores
  scores=$(echo "$mock_scores" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
s = int(d.get('security', 3))
t = int(d.get('tdd', 3))
de = int(d.get('design', 3))
st = int(d.get('structural', 3))
print(f'{s} {t} {de} {st}')
" 2>/dev/null) || scores="3 3 3 3"

  read -r sec tdd_s des str <<< "$scores"
  compute_result "$sec" "$tdd_s" "$des" "$str" "$judge_model" "$judge_calls"
  exit 0
fi

# ─── Live mode: real API calls ───────────────────────────────────────────────
if [ -z "$OPENROUTER_API_KEY" ]; then
  >&2 echo "ERROR: OPENROUTER_API_KEY is not set"
  echo '{"result": "INCONCLUSIVE", "reason": "missing_api_key"}'
  exit 0
fi

PROMPT=$(build_prompt "$PLAN_TEXT")
judge_calls=0

# Primary: GLM-5 with reasoning disabled
judge_calls=$(( judge_calls + 1 ))
>&2 echo "Calling primary judge: $MODEL_PRIMARY"
GLM5_EXTRA=', "reasoning": {"enabled": false}'
response=$(call_openrouter "$MODEL_PRIMARY" "$PROMPT" "$GLM5_EXTRA" 2>/dev/null) || response="CALL_FAILED"

if [ "$response" != "CALL_FAILED" ] && [[ "$response" != HTTP_ERROR* ]] && [ -n "$response" ]; then
  scores=$(parse_scores "$response") || scores=""
  if [ -n "$scores" ]; then
    read -r sec tdd_s des str <<< "$scores"
    compute_result "$sec" "$tdd_s" "$des" "$str" "$MODEL_PRIMARY" "$judge_calls"
    exit 0
  fi
  >&2 echo "Primary judge returned unparseable response, falling back"
else
  >&2 echo "Primary judge failed (${response}), falling back to secondary"
fi

# Secondary: MiniMax M2.5 (no reasoning field)
judge_calls=$(( judge_calls + 1 ))
>&2 echo "Calling secondary judge: $MODEL_SECONDARY"
response=$(call_openrouter "$MODEL_SECONDARY" "$PROMPT" "" 2>/dev/null) || response="CALL_FAILED"

if [ "$response" != "CALL_FAILED" ] && [[ "$response" != HTTP_ERROR* ]] && [ -n "$response" ]; then
  scores=$(parse_scores "$response") || scores=""
  if [ -n "$scores" ]; then
    read -r sec tdd_s des str <<< "$scores"
    compute_result "$sec" "$tdd_s" "$des" "$str" "$MODEL_SECONDARY" "$judge_calls"
    exit 0
  fi
  >&2 echo "Secondary judge returned unparseable response, falling back"
else
  >&2 echo "Secondary judge failed (${response}), falling back to tertiary"
fi

# Tertiary: Kimi K2.5 (chat_template_kwargs thinking:false, no tool calling)
judge_calls=$(( judge_calls + 1 ))
>&2 echo "Calling tertiary judge: $MODEL_TERTIARY"
KIMI_EXTRA=', "chat_template_kwargs": {"thinking": false}'
response=$(call_openrouter "$MODEL_TERTIARY" "$PROMPT" "$KIMI_EXTRA" 2>/dev/null) || response="CALL_FAILED"

if [ "$response" != "CALL_FAILED" ] && [[ "$response" != HTTP_ERROR* ]] && [ -n "$response" ]; then
  scores=$(parse_scores "$response") || scores=""
  if [ -n "$scores" ]; then
    read -r sec tdd_s des str <<< "$scores"
    compute_result "$sec" "$tdd_s" "$des" "$str" "$MODEL_TERTIARY" "$judge_calls"
    exit 0
  fi
  >&2 echo "Tertiary judge returned unparseable response"
else
  >&2 echo "Tertiary judge failed (${response})"
fi

# All judges failed
>&2 echo "All judges failed — returning INCONCLUSIVE"
echo '{"result": "INCONCLUSIVE", "reason": "all_judges_failed"}'
