# Research: PR5 — Advanced Testing Expansion

**Date**: 2026-02-20
**Beads Issue**: forge-01p
**Status**: Research complete, ready for `/plan`

---

## Objective

Expand Forge's testing infrastructure with mutation testing (Stryker), performance benchmarks, extended OWASP security tests (A02, A07), and a test quality dashboard. Build on the foundation from PR3 (808 tests, 80% coverage thresholds, 6-platform CI matrix).

---

## Codebase Analysis

### Current Test Infrastructure

| Category | Files | Tests | Location |
|----------|-------|-------|----------|
| Unit tests | 35+ | ~500 | `test/` |
| Edge cases | 12 | ~120 | `test-env/edge-cases/` |
| Validation helpers | 4+4 | ~52 | `test-env/validation/` |
| E2E tests | 5 | ~30 | `test/e2e/` |
| Integration | 1 | ~15 | `test/integration/` |
| Skills tests | 7 | ~50 | `packages/skills/test/` |
| CLI structure | 2 | ~10 | `test/cli/` |
| **Total** | **56** | **808** | — |

- **Framework**: Node.js built-in `node:test` + `node:assert/strict` (main), Bun test (skills)
- **Coverage**: c8 with 80% thresholds (lines, branches, functions, statements)
- **CI**: 6-platform matrix (ubuntu/macos/windows x Node 20/22) + coverage + E2E jobs
- **Skipped tests**: 36 instances of `test.skip()` — opportunity to fill gaps

### Critical Gap: `bin/forge.js`

The main CLI file (4,407 lines) is **explicitly excluded from c8 coverage**. Only structural tests exist in `test/cli/forge.test.js` (10 tests verifying function existence). No direct execution, prompt handling, or integration tests.

### Existing Security Tests

`test-env/edge-cases/security.test.js` covers:
- Shell injection prevention (`;`, `&&`, `|`, backticks)
- Path traversal attacks (`../`, `..\\`)
- Null byte injection
- Unicode smuggling attacks

**Not covered**: Cryptographic failures (OWASP A02), authentication failures (OWASP A07).

---

## Web Research

### 1. Mutation Testing — Stryker

**Key findings from [Stryker Mutator docs](https://stryker-mutator.io/docs/stryker-js/guides/nodejs/) and [Sentry's experience](https://sentry.engineering/blog/js-mutation-testing-our-sdks):**

#### Configuration for Node.js + node:test

Stryker supports a `command` test runner (default) that runs any CLI command and bases results on exit codes. Since there's no dedicated `node:test` runner plugin, we use:

```json
{
  "testRunner": "command",
  "commandRunner": { "command": "bun test" },
  "mutate": ["lib/**/*.js", "bin/forge.js"],
  "coverageAnalysis": "off",
  "thresholds": { "high": 80, "low": 60, "break": 60 },
  "reporters": ["clear-text", "html", "json"],
  "tempDirName": ".stryker-tmp",
  "cleanTempDir": true,
  "incremental": true,
  "incrementalFile": "stryker-report/stryker-incremental.json"
}
```

**Important**: `coverageAnalysis: "off"` is required for the command runner (no per-test optimization). This means ALL tests run for EVERY mutant — expect longer runtimes.

#### Performance Considerations

Per [Sentry's blog post](https://sentry.engineering/blog/js-mutation-testing-our-sdks):
- Full mutation testing on large codebases takes 25-60+ minutes
- **Incremental mode** (`--incremental`) only mutates changed files — critical for CI
- Switching from Jest to Vitest cut their runtime from 60min to 25min
- Recommendation: Run full mutation testing nightly/weekly, incremental on PRs

#### Recommended Thresholds

Per [Stryker docs](https://stryker-mutator.io/docs/stryker-js/configuration/) and [community standards](https://github.com/stryker-mutator/stryker-net/issues/1779):
- `high: 80` (green) — excellent test quality
- `low: 60` (yellow) — acceptable but needs improvement
- `break: 60` (fail build) — minimum acceptable score
- **Our target**: 70%+ per roadmap, start with `break: 50` and increase iteratively

#### Scope Decision

Mutating `bin/forge.js` (4,407 lines) would create thousands of mutants and take very long with the command runner. **Recommendation**: Start with `lib/**/*.js` only (smaller, testable modules), add `bin/forge.js` later when it has better test coverage.

### 2. Performance Benchmarking

**Key findings from [Medium - Node.js Benchmarks](https://medium.com/@Modexa/node-js-benchmarks-you-can-actually-trust-76dd35aa8ae1):**

#### Tools

| Tool | Use Case | Notes |
|------|----------|-------|
| `node:perf_hooks` | Built-in timing | `performance.now()`, `PerformanceObserver` |
| `tinybench` | Micro-benchmarks | Lightweight, modern, good for functions |
| `node --prof` | V8 profiling | CPU profiling, tick analysis |
| Custom harness | CLI benchmarks | Subprocess spawning + timing |

#### What to Benchmark

For a CLI tool like Forge:
1. **Startup time**: `node bin/forge.js --help` (target: <500ms)
2. **Agent detection**: `detectProjectType()` performance
3. **Config generation**: AGENTS.md, CLAUDE.md generation speed
4. **Package manager detection**: `detectPackageManager()` latency
5. **File I/O**: Large project scanning (monorepo fixtures)

#### CI Integration

- Store benchmark results as JSON artifacts
- Compare against baselines using custom script
- Flag regressions >20% as warnings, >50% as failures
- **GitHub Actions**: Use `actions/upload-artifact` for benchmark reports

### 3. OWASP Security Testing

**Key findings from [Node.js Security Best Practices](https://nodejs.org/en/learn/getting-started/security-best-practices):**

#### A02: Cryptographic Failures

Relevant to Forge:
- **API key handling**: `.env.local` files with `PARALLEL_API_KEY`, tokens
- **Token storage**: MCP server configurations with credentials
- **Path exposure**: Windows absolute paths leaking in generated files

Test scenarios:
1. Verify API keys are never logged to stdout/stderr
2. Verify `.env.local` is in `.gitignore`
3. Verify generated configs don't embed plaintext secrets
4. Verify token references use environment variables, not literals
5. Verify no hardcoded credentials in source code

#### A07: Identification & Authentication Failures

Relevant to Forge:
- **GitHub CLI auth**: `gh auth status` validation
- **Git operations**: Push to protected branches
- **External service configs**: MCP server authentication

Test scenarios:
1. Verify `gh auth status` is checked before operations requiring it
2. Verify branch protection blocks unauthenticated pushes
3. Verify MCP configs reference credential IDs, not inline secrets
4. Verify setup warns when auth tokens are missing
5. Verify no default/weak credentials in templates

### 4. Test Quality Dashboard

**Key metrics to track:**

| Metric | Tool | Current | Target |
|--------|------|---------|--------|
| Test count | `bun test` output | 808 | Track growth |
| Code coverage | c8 | 80% threshold | >=80% maintained |
| Mutation score | Stryker | N/A | >=70% |
| ESLint warnings | ESLint | 0 | 0 maintained |
| Skipped tests | grep `test.skip` | 36 | Reduce to <10 |
| Test runtime | CI timing | ~12s | Track regressions |
| Flaky rate | CI history | ~0% | 0% |

**Implementation approach** (lightweight, CI-integrated):
- GitHub Actions job that generates a JSON summary after tests
- Badge updates in README (test count, coverage, mutation score)
- Artifact upload for trend tracking
- No external dashboard service needed — keep it in CI

---

## Key Decisions & Reasoning

### D1: Use Stryker command runner (not Jest/Vitest runner)

**Decision**: Use `testRunner: "command"` with `bun test`
**Reasoning**: Project uses `node:test` framework, not Jest/Vitest. No Stryker plugin exists for `node:test`. Command runner works universally.
**Trade-off**: No per-test optimization (slower), but simpler setup and no framework migration needed.

### D2: Start mutation testing on lib/ only

**Decision**: Mutate `lib/**/*.js` first, add `bin/forge.js` in a future PR
**Reasoning**: `bin/forge.js` is 4,407 lines with limited direct tests. Mutating it would create thousands of slow-to-test mutants. `lib/` modules are smaller and have better test coverage.
**Evidence**: Sentry's experience shows starting with well-tested modules gives actionable results faster.

### D3: Use tinybench for performance benchmarks

**Decision**: `tinybench` for function-level benchmarks, subprocess spawning + `performance.now()` for CLI-level benchmarks
**Reasoning**: Zero dependencies for CLI timing, tinybench is lightweight (18KB) for micro-benchmarks. No need for heavy frameworks.

### D4: Lightweight dashboard via CI artifacts + badges

**Decision**: Generate test quality JSON in CI, update README badges
**Reasoning**: No external service dependency. GitHub Actions artifacts provide history. Badges give at-a-glance status.
**Alternative rejected**: External dashboard tools (Grafana, Datadog) — overkill for this project size.

### D5: Incremental mutation testing in CI

**Decision**: Run incremental Stryker on PRs, full run weekly
**Reasoning**: Full mutation testing takes 10-60+ minutes. Incremental mode only tests changed files, keeping PR checks fast.
**Evidence**: Standard practice per Stryker docs and Sentry's production experience.

---

## TDD Test Scenarios

### Mutation Testing Tests (`test/mutation-config.test.js`)

1. Stryker config file exists and is valid JSON
2. Mutate patterns include `lib/**/*.js`
3. Thresholds are set (high: 80, low: 60, break: 50)
4. Incremental mode is enabled
5. HTML reporter is configured for artifact upload
6. `test:mutation` script exists in package.json
7. Stryker report directory is in `.gitignore`

### Performance Benchmark Tests (`test/benchmarks.test.js`)

1. CLI startup completes in <2000ms
2. `detectPackageManager()` completes in <500ms
3. Agent detection for standard project completes in <1000ms
4. Benchmark results file is generated as valid JSON
5. `test:benchmark` script exists in package.json

### OWASP A02 Security Tests (`test-env/edge-cases/crypto-security.test.js`)

1. API keys are never in generated output files
2. `.env.local` pattern is in `.gitignore`
3. Generated AGENTS.md doesn't contain plaintext tokens
4. MCP config uses credential references, not inline secrets
5. Source code has no hardcoded API keys (regex scan)
6. Token environment variables use descriptive names

### OWASP A07 Auth Tests (`test-env/edge-cases/auth-security.test.js`)

1. Prerequisites check validates `gh auth status`
2. Branch protection script blocks unauthenticated scenarios
3. Setup flow warns on missing auth tokens
4. No default credentials in any template file
5. OAuth/token patterns reference env vars only

### Test Dashboard Tests (`test/test-dashboard.test.js`)

1. Dashboard generation script exists
2. Output JSON has required metrics fields
3. Badge URLs are valid shield.io format
4. CI workflow includes dashboard generation step

---

## Security Analysis (OWASP Top 10)

| Risk | Relevance | Current Coverage | PR5 Action |
|------|-----------|-----------------|------------|
| A01: Broken Access Control | Medium | Branch protection tests | Maintain |
| **A02: Cryptographic Failures** | **High** | **None** | **Add 6+ tests** |
| A03: Injection | High | Shell injection tests | Maintain |
| A04: Insecure Design | Low | Architecture tests | N/A |
| A05: Security Misconfiguration | Medium | Config validation | Maintain |
| A06: Vulnerable Components | Medium | `npm audit` in CI | Maintain |
| **A07: Identification/Auth** | **Medium** | **Partial (gh auth)** | **Add 5+ tests** |
| A08: Software/Data Integrity | Low | Commitlint, CODEOWNERS | Maintain |
| A09: Logging/Monitoring | Low | N/A for CLI | N/A |
| A10: SSRF | Low | N/A for CLI | N/A |

---

## Scope Assessment

- **Classification**: Tactical (concrete testing improvements, no architecture changes)
- **Complexity**: Medium (4 parallel workstreams, each independent)
- **Timeline**: 2-3 days per roadmap
- **Parallelization**: All 4 deliverables can be developed independently
- **Risk**: Low (additive only, no breaking changes)

---

## Sources

- [Stryker Node.js Guide](https://stryker-mutator.io/docs/stryker-js/guides/nodejs/)
- [Stryker Configuration Reference](https://stryker-mutator.io/docs/stryker-js/configuration/)
- [Stryker Getting Started](https://stryker-mutator.io/docs/stryker-js/getting-started/)
- [Sentry: Mutation-testing our JavaScript SDKs](https://sentry.engineering/blog/js-mutation-testing-our-sdks) (Aug 2024)
- [Mutation Testing with Stryker - DEV Community](https://dev.to/lucaspereiradesouzat/mutation-testing-with-stryker-1p4a) (Dec 2025)
- [Introducing Mutation Testing in Vue.js with StrykerJS](https://medium.com/accor-digital-and-tech/introducing-mutation-testing-in-vue-js-with-strykerjs-e1083afe7326) (Nov 2025)
- [Node.js Benchmarks You Can Actually Trust](https://medium.com/@Modexa/node-js-benchmarks-you-can-actually-trust-76dd35aa8ae1) (Jan 2026)
- [Node.js Security Best Practices](https://nodejs.org/en/learn/getting-started/security-best-practices) (Official)
- [Stryker Dashboard](https://dashboard.stryker-mutator.io) — community mutation score hosting
