---
name: sonarcloud
description: >
  Query SonarCloud code-quality data via the `/sonarcloud` slash command — the fast in-context
  lookup for a project, branch, or PR. Handles `issues`, `metrics`, `gate` (pass/fail + failed
  conditions), `health`, `pr <number>`, `hotspots`, `history`, plus `--branch`, `--severity`,
  `--type`, `--new-code` filters. Use the moment the user types `/sonarcloud ...` or asks in
  plain language: "what does SonarCloud say about this PR", "check the SonarCloud quality gate
  before I ship", "SonarCloud blocker/critical bugs on develop", "new-code SonarCloud issues
  on PR 214". Only READS/reports — does NOT fix findings or reply-to/resolve PR threads (that
  is `review`); it is the lightweight command surface, NOT the deep-analysis session
  correlating findings with local source or history trends (that is `sonarcloud-analysis`).
  Not for local SAST scans of your own code, nor the Forge issue tracker (`forge issue ...`,
  "open/ready issues") — here those bare words always mean SonarCloud.
allowed-tools: Bash, Read, Grep, Glob, WebFetch
terminal: true
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
4. Execute the appropriate API call against the SonarCloud REST API (see the API Reference section below for endpoints)
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
