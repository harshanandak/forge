---
name: sonarcloud
description: >
  Query SonarCloud code-quality data through the `/sonarcloud` slash command — the fast,
  in-context lookup surface for a project, branch, or (above all) a pull request. Handles the
  named queries `issues`, `metrics`, `gate` (quality-gate pass/fail with failed conditions),
  `health` (full report), `pr <number>`, `hotspots` (security), and `history`, plus
  `--branch`, `--severity`, `--type`, and `--new-code` filters. Reach for this the moment the
  user types `/sonarcloud ...`, or asks in plain language: "what does SonarCloud say about
  this PR", "check the SonarCloud quality gate before I ship", "show SonarCloud
  blocker/critical bugs on the develop branch", "any new-code SonarCloud issues on PR 214",
  "SonarCloud coverage for my-project". Requires a `SONARCLOUD_TOKEN` (and organization key).
  This skill only READS and reports SonarCloud results — it does NOT fix findings or
  reply-to/resolve PR review threads (that is the `review` stage), and it is the lightweight
  command surface, NOT the isolated deep-analysis session that correlates findings with local
  source, walks analysis-history trends, or runs duplication deep-dives across many endpoints
  (that is `sonarcloud-analysis` — send heavyweight or correlation work there). Not for local
  SAST/security scans of your own code, and not for the Forge issue tracker ("open/ready
  issues", `forge issue ...`) — here those bare words always mean SonarCloud, not the tracker
  or validate stage.
allowed-tools: Bash, Read, Grep, Glob, WebFetch
---

# SonarCloud Query Command

Pull code quality data from SonarCloud. Requires `SONARCLOUD_TOKEN` environment variable.

## Arguments

- `$ARGUMENTS` - Query type and parameters

## Query Types

| Query | Description | Example |
|-------|-------------|---------|
| `issues <project>` | Get open issues | `/sonarcloud issues my-project` |
| `metrics <project>` | Get code metrics | `/sonarcloud metrics my-project` |
| `gate <project>` | Quality gate status | `/sonarcloud gate my-project` |
| `health <project>` | Full health report | `/sonarcloud health my-project` |
| `pr <project> <pr#>` | PR analysis | `/sonarcloud pr my-project 123` |
| `hotspots <project>` | Security hotspots | `/sonarcloud hotspots my-project` |
| `history <project>` | Analysis history | `/sonarcloud history my-project` |

## Filters (append to query)

| Filter | Description | Example |
|--------|-------------|---------|
| `--branch <name>` | Filter by branch | `--branch develop` |
| `--severity <levels>` | Filter severity | `--severity BLOCKER,CRITICAL` |
| `--type <types>` | Filter issue type | `--type BUG,VULNERABILITY` |
| `--new-code` | Only new code issues | `--new-code` |

## Instructions

1. Parse the query from `$ARGUMENTS` to determine:
   - Query type (issues, metrics, gate, health, pr, hotspots, history)
   - Project key
   - Optional filters (branch, severity, type, new-code, etc.)
2. Check for `SONARCLOUD_TOKEN` environment variable. If not set, inform user.
3. Check for `SONARCLOUD_ORG` environment variable or ask user for organization key.
4. Execute the appropriate API call using curl or the TypeScript client at `next-app/src/lib/integrations/sonarcloud.ts`
5. Format and present results clearly:
   - For issues: Group by severity/type, show file, line, message
   - For metrics: Show as table with metric name and value
   - For quality gate: Show pass/fail with failed conditions
   - For health: Comprehensive summary with all data
6. Offer follow-up actions:
   - "Show issues in specific file?"
   - "Get more details on a specific issue?"
   - "Compare with another branch?"

## Example Outputs

### Issues Query

```
📋 Open Issues for my-project (branch: main)

Total: 45 issues

By Severity:
  🔴 BLOCKER: 2
  🟠 CRITICAL: 5
  🟡 MAJOR: 18
  ⚪ MINOR: 15
  ⚫ INFO: 5

By Type:
  🐛 BUG: 8
  🔓 VULNERABILITY: 3
  💩 CODE_SMELL: 34

Top Issues:
1. [CRITICAL] src/auth/login.ts:42 - SQL injection vulnerability
2. [BLOCKER] src/api/users.ts:156 - Null pointer dereference
...
```

### Metrics Query

```
📊 Metrics for my-project

| Metric | Value |
|--------|-------|
| Lines of Code | 51,234 |
| Coverage | 78.5% |
| Duplications | 3.2% |
| Bugs | 8 |
| Vulnerabilities | 3 |
| Code Smells | 34 |
| Technical Debt | 4d 2h |
| Maintainability | A |
| Reliability | B |
| Security | A |
```

### Quality Gate Query

```
🚦 Quality Gate: ❌ FAILED

Failed Conditions:
| Metric | Threshold | Actual |
|--------|-----------|--------|
| Coverage on New Code | ≥ 80% | 65.3% |
| New Bugs | = 0 | 2 |

Passed Conditions:
| Metric | Threshold | Actual |
|--------|-----------|--------|
| New Vulnerabilities | = 0 | 0 |
| Duplicated Lines | ≤ 3% | 1.2% |
```

## API Reference

Base URL: `https://sonarcloud.io/api`

### Key Endpoints

```bash
# Issues
curl -H "Authorization: Bearer $TOKEN" \
  "https://sonarcloud.io/api/issues/search?organization=$ORG&componentKeys=$PROJECT&resolved=false"

# Metrics
curl -H "Authorization: Bearer $TOKEN" \
  "https://sonarcloud.io/api/measures/component?component=$PROJECT&metricKeys=bugs,vulnerabilities,coverage"

# Quality Gate
curl -H "Authorization: Bearer $TOKEN" \
  "https://sonarcloud.io/api/qualitygates/project_status?projectKey=$PROJECT"

# Hotspots
curl -H "Authorization: Bearer $TOKEN" \
  "https://sonarcloud.io/api/hotspots/search?projectKey=$PROJECT&status=TO_REVIEW"
```

## Full Skill Reference

See `skills/sonarcloud-analysis/SKILL.md` for complete API documentation including:

- All endpoints and parameters
- Response structures
- Pagination handling
- Advanced filtering
- Integration patterns
