// Isolated ESLint flat config for `forge preflight`'s SonarCloud-parity gate.
//
// Run ONLY via `eslint --no-config-lookup --config scripts/preflight-sonar.eslint.config.mjs`
// on changed files, so these Sonar rules never merge with the repo's main
// eslint.config.js. The point is deterministic parity with the SonarCloud
// quality gate WITHOUT the full (slow) Sonar scanner, on the change blast radius.
//
// cognitive-complexity is pinned to 15 — the same threshold SonarCloud's default
// "Cognitive Complexity" (S3776) gate uses, and the most common gate failure.
//
// Rule name ↔ Sonar rule ID (eslint-plugin-sonarjs v4):
//   sonarjs/cognitive-complexity  S3776  (pinned to 15)
//   sonarjs/void-use              S3735  (void should not be used)
//   sonarjs/regex-complexity      S5843  (regex too complex)
//
// prefer-optional-chain (S6582) is intentionally omitted: sonarjs exposes it
// only through the TypeScript type-checker path, which this fast JS-only gate
// does not wire (it would require @typescript-eslint/parser + a project graph
// and defeats the speed goal). CI's full Sonar scan still enforces it.
import sonarjs from 'eslint-plugin-sonarjs';

const sonarRules = {
  'sonarjs/cognitive-complexity': ['error', 15],
  'sonarjs/void-use': 'error',
  'sonarjs/regex-complexity': 'error',
};

export default [
  {
    ignores: ['node_modules/', 'coverage/', 'dist/', 'build/', '**/*.min.js'],
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
    plugins: { sonarjs },
    rules: sonarRules,
  },
  {
    files: ['**/*.js', '**/*.cjs'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs' },
    plugins: { sonarjs },
    rules: sonarRules,
  },
];
