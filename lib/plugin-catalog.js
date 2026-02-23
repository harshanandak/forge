/**
 * Plugin Catalog
 *
 * Static, frozen catalog of tools for the Forge workflow.
 * Read-only data — no installations, no side effects.
 */

const TIERS = Object.freeze({
  FREE: 'free',
  FREE_PUBLIC: 'free-public',
  FREE_LIMITED: 'free-limited',
  PAID: 'paid',
});

const TOOL_TYPES = Object.freeze({
  CLI: 'cli',
  SKILL: 'skill',
  MCP: 'mcp',
  CONFIG: 'config',
  LSP: 'lsp',
});

const STAGES = Object.freeze({
  RESEARCH: 'research',
  PLAN: 'plan',
  DEV: 'dev',
  CHECK: 'check',
  SHIP: 'ship',
  REVIEW: 'review',
  MERGE: 'merge',
});

const BUDGET_MODES = Object.freeze({
  free: { label: 'Free only', includes: ['free'] },
  'open-source': { label: 'Open source', includes: ['free', 'free-public'] },
  startup: { label: 'Startup', includes: ['free', 'free-public', 'free-limited'] },
  professional: { label: 'Professional', includes: ['free', 'free-public', 'free-limited', 'paid'] },
  custom: { label: 'Custom', includes: [] },
});

const PREREQUISITES = Object.freeze({
  node: { check: 'node --version', installUrl: 'https://nodejs.org' },
  git: { check: 'git --version', installUrl: 'https://git-scm.com' },
  gh: { check: 'gh --version', installUrl: 'https://cli.github.com' },
  bun: { check: 'bun --version', installUrl: 'https://bun.sh' },
  jq: { check: 'jq --version', installUrl: 'https://jqlang.github.io/jq/download/' },
  go: { check: 'go version', installUrl: 'https://go.dev/dl/' },
  curl: { check: 'curl --version', installUrl: null },
  'parallel-cli': {
    check: 'parallel-cli --version',
    installUrl: 'https://parallel.ai/install.sh',
  },
});

const CATALOG = Object.freeze({
  // ── Research ──
  'context7-mcp': {
    name: 'Context7',
    type: 'mcp',
    tier: 'free',
    stage: 'research',
    description: 'Up-to-date library documentation via MCP',
    detectWhen: [],
    install: { method: 'add-mcp', cmd: 'bunx add-mcp context7' },
    mcpJustified: true,
  },
  'parallel-web-search': {
    name: 'Parallel Web Search',
    type: 'skill',
    tier: 'free',
    stage: 'research',
    description: 'Web search via Parallel AI. CLI (recommended) or curl (no install needed).',
    detectWhen: [],
    install: {
      method: 'skills',
      cmd: 'bunx skills add parallel-web/parallel-agent-skills --skill parallel-web-search',
      cmdCurl: 'bunx skills add harshanandak/forge --skill parallel-web-search',
    },
    prerequisites: ['parallel-cli'],
  },
  'grep-app-mcp': {
    name: 'grep.app',
    type: 'mcp',
    tier: 'free',
    stage: 'research',
    description: 'Search 1M+ GitHub repos for real-world code examples',
    detectWhen: [],
    install: { method: 'add-mcp', cmd: 'bunx add-mcp grep-app' },
    mcpJustified: true,
  },

  // ── Plan ──
  beads: {
    name: 'Beads',
    type: 'cli',
    tier: 'free',
    stage: 'plan',
    description: 'Git-backed issue tracking',
    detectWhen: [],
    install: { method: 'npm', cmd: 'bun add -g @beads/bd' },
  },
  openspec: {
    name: 'OpenSpec',
    type: 'cli',
    tier: 'free',
    stage: 'plan',
    description: 'Spec-driven development proposals',
    detectWhen: [],
    install: { method: 'npm', cmd: 'bun add -g @fission-ai/openspec' },
  },

  // ── Dev ──
  'typescript-lsp': {
    name: 'TypeScript LSP',
    type: 'lsp',
    tier: 'free',
    stage: 'dev',
    description: 'TypeScript language server for IDE integration',
    detectWhen: ['dep:typescript', 'file:tsconfig.json'],
    install: { method: 'lsp', cmd: '.lsp.json config' },
  },
  'supabase-cli': {
    name: 'Supabase CLI',
    type: 'cli',
    tier: 'free-limited',
    stage: 'dev',
    description: 'Local Supabase development and migrations',
    detectWhen: ['dep:@supabase/supabase-js'],
    install: { method: 'npm', cmd: 'bun add -D supabase', dev: true },
    alternatives: [{ tool: 'postgresql-client', tier: 'free', tradeoff: 'No Supabase-specific features' }],
  },
  'stripe-cli': {
    name: 'Stripe CLI',
    type: 'cli',
    tier: 'free',
    stage: 'dev',
    description: 'Stripe webhook testing and API interaction',
    detectWhen: ['dep:stripe'],
    install: { method: 'binary', cmd: 'https://stripe.com/docs/stripe-cli' },
  },
  'vercel-agent-skills': {
    name: 'Vercel Agent Skills',
    type: 'skill',
    tier: 'free',
    stage: 'dev',
    description: 'Vercel deployment and preview management',
    detectWhen: ['dep:next'],
    install: { method: 'skills', cmd: 'bunx skills add vercel-labs/agent-skills' },
  },

  // ── Check ──
  eslint: {
    name: 'ESLint',
    type: 'cli',
    tier: 'free',
    stage: 'check',
    description: 'JavaScript/TypeScript linting',
    detectWhen: ['file:eslint.config.js', 'dep:eslint'],
    install: { method: 'npm', cmd: 'bun add -D eslint', dev: true },
  },
  biome: {
    name: 'Biome',
    type: 'cli',
    tier: 'free',
    stage: 'check',
    description: 'Fast formatter and linter',
    detectWhen: ['file:biome.json'],
    install: { method: 'npm', cmd: 'bun add -D @biomejs/biome', dev: true },
  },
  prettier: {
    name: 'Prettier',
    type: 'cli',
    tier: 'free',
    stage: 'check',
    description: 'Opinionated code formatter',
    detectWhen: ['file:.prettierrc'],
    install: { method: 'npm', cmd: 'bun add -D prettier', dev: true },
  },
  'eslint-plugin-security': {
    name: 'ESLint Security Plugin',
    type: 'config',
    tier: 'free',
    stage: 'check',
    description: 'Security-focused ESLint rules',
    detectWhen: ['dep:express', 'dep:fastify'],
    install: { method: 'npm', cmd: 'bun add -D eslint-plugin-security', dev: true },
  },
  'sonarcloud-analysis': {
    name: 'SonarCloud Analysis',
    type: 'skill',
    tier: 'free-public',
    stage: 'check',
    description: 'Code quality and security analysis via SonarCloud REST API',
    detectWhen: [],
    install: {
      method: 'skills',
      cmd: 'bunx skills add harshanandak/forge --skill sonarcloud-analysis',
    },
    alternatives: [{ tool: 'eslint', tier: 'free', tradeoff: 'Less comprehensive analysis' }],
  },
  'sonar-scanner': {
    name: 'Sonar Scanner',
    type: 'cli',
    tier: 'free-public',
    stage: 'check',
    description: 'SonarCloud/SonarQube CLI scanner',
    detectWhen: ['file:sonar-project.properties'],
    install: { method: 'npm', cmd: 'bun add -D sonarqube-scanner', dev: true },
    alternatives: [{ tool: 'eslint', tier: 'free', tradeoff: 'No centralized dashboard' }],
  },
  codeql: {
    name: 'CodeQL',
    type: 'cli',
    tier: 'free-public',
    stage: 'check',
    description: 'Semantic code analysis by GitHub',
    detectWhen: [],
    install: { method: 'binary', cmd: 'GitHub-provided (github.com/github/codeql-action)' },
    alternatives: [{ tool: 'eslint-plugin-security', tier: 'free', tradeoff: 'Less deep analysis' }],
  },
  'npm-audit': {
    name: 'npm audit',
    type: 'cli',
    tier: 'free',
    stage: 'check',
    description: 'Dependency vulnerability scanning',
    detectWhen: [],
    install: { method: 'npm', cmd: 'built-in (bun pm audit)' },
  },
  vitest: {
    name: 'Vitest',
    type: 'cli',
    tier: 'free',
    stage: 'check',
    description: 'Vite-native test runner',
    detectWhen: ['dep:vitest', 'file:vitest.config.ts'],
    install: { method: 'npm', cmd: 'bun add -D vitest', dev: true },
  },
  jest: {
    name: 'Jest',
    type: 'cli',
    tier: 'free',
    stage: 'check',
    description: 'Delightful JavaScript testing',
    detectWhen: ['dep:jest', 'file:jest.config.js'],
    install: { method: 'npm', cmd: 'bun add -D jest', dev: true },
  },
  playwright: {
    name: 'Playwright',
    type: 'cli',
    tier: 'free',
    stage: 'check',
    description: 'End-to-end browser testing',
    detectWhen: ['dep:@playwright/test'],
    install: { method: 'npm', cmd: 'bun add -D @playwright/test', dev: true },
  },
  c8: {
    name: 'c8',
    type: 'cli',
    tier: 'free',
    stage: 'check',
    description: 'Native V8 code coverage',
    detectWhen: [],
    install: { method: 'npm', cmd: 'bun add -D c8', dev: true },
  },
  stryker: {
    name: 'Stryker',
    type: 'cli',
    tier: 'free',
    stage: 'check',
    description: 'Mutation testing for JavaScript',
    detectWhen: [],
    install: { method: 'npm', cmd: 'bun add -D @stryker-mutator/core', dev: true },
  },
  oxlint: {
    name: 'Oxlint',
    type: 'cli',
    tier: 'free',
    stage: 'check',
    description: 'Blazing-fast Rust-based linter',
    detectWhen: [],
    install: { method: 'npm', cmd: 'bun add -D oxlint', dev: true },
  },

  // ── Ship ──
  'gh-cli': {
    name: 'GitHub CLI',
    type: 'cli',
    tier: 'free',
    stage: 'ship',
    description: 'GitHub PR and issue management',
    detectWhen: [],
    install: { method: 'binary', cmd: 'https://cli.github.com' },
    prerequisites: ['gh'],
  },
  lefthook: {
    name: 'Lefthook',
    type: 'cli',
    tier: 'free',
    stage: 'ship',
    description: 'Fast git hooks manager',
    detectWhen: [],
    install: { method: 'npm', cmd: 'bun add -D lefthook', dev: true },
  },

  // ── Review ──
  coderabbit: {
    name: 'CodeRabbit',
    type: 'config',
    tier: 'free-public',
    stage: 'review',
    description: 'AI-powered code review',
    detectWhen: [],
    install: { method: 'config', cmd: 'GitHub App (coderabbit.ai)' },
    alternatives: [{ tool: 'qodo-merge', tier: 'free', tradeoff: 'Self-hosted, more setup' }],
  },
  greptile: {
    name: 'Greptile',
    type: 'config',
    tier: 'paid',
    stage: 'review',
    description: 'AI code review with codebase context',
    detectWhen: [],
    install: { method: 'config', cmd: 'GitHub App (greptile.com)' },
    alternatives: [{ tool: 'coderabbit', tier: 'free-public', tradeoff: 'Less codebase awareness' }],
  },
  'qodo-merge': {
    name: 'Qodo Merge',
    type: 'cli',
    tier: 'free',
    stage: 'review',
    description: 'AI-assisted code review (self-hosted)',
    detectWhen: [],
    install: { method: 'config', cmd: 'Self-hosted (qodo.ai)' },
  },

  // ── Merge ──
  changesets: {
    name: 'Changesets',
    type: 'cli',
    tier: 'free',
    stage: 'merge',
    description: 'Versioning and changelog management',
    detectWhen: ['file:package.json'],
    install: { method: 'npm', cmd: 'bun add -D @changesets/cli', dev: true },
  },
  'release-please': {
    name: 'Release Please',
    type: 'config',
    tier: 'free',
    stage: 'merge',
    description: 'Automated release PRs by Google',
    detectWhen: [],
    install: { method: 'config', cmd: 'GitHub Action (google-github-actions/release-please-action)' },
  },
});

module.exports = { CATALOG, TIERS, TOOL_TYPES, STAGES, BUDGET_MODES, PREREQUISITES };
