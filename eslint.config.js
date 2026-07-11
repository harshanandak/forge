import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    ignores: [
      'node_modules/',
      'coverage/',
      'dist/',
      'build/',
      '*.min.js',
      '.worktrees/',
      '.claude/worktrees/',
      'test-env/fixtures/**',
      'packages/skills/test/fixtures/**',
      'test/e2e/fixtures/**',
      // Generated dashboard artifacts (baked kernel snapshot + work-folder docs)
      'web/dashboard/snapshot.js',
      'web/dashboard/docs.js',
    ],
  },
  // ES Modules — .mjs files (Node scripts using ESM)
  {
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-console': 'off',
      'no-undef': 'error',
    },
  },
  // ES Modules (packages/skills, migrated test-env tests, test/forge-uto, and eslint.config.js)
  {
    files: ['packages/skills/**/*.js', 'test-env/**/*.test.js', 'test/forge-uto/**/*.js', 'test/scripts/github-beads-sync/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-console': 'off',
      'no-prototype-builtins': 'off',
      'no-empty': 'off',
      'no-useless-escape': 'off',
      'preserve-caught-error': 'off',
      'no-undef': 'warn',
    },
  },
  // CommonJS (everything else)
  {
    files: ['**/*.js'],
    ignores: ['packages/skills/**/*.js', 'test-env/**/*.test.js', 'test/forge-uto/**/*.js', 'test/scripts/github-beads-sync/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-console': 'off',
      'no-prototype-builtins': 'off',
      'no-empty': 'off',
      'no-useless-escape': 'off',
      'preserve-caught-error': 'off',
      'no-undef': 'warn',
    },
  },
  // Browser — read-only dashboard app (baked-snapshot consumer; runs in the browser,
  // also require()-able under Node for its unit tests via module.exports).
  {
    files: ['web/dashboard/app.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-undef': 'warn',
    },
  },
  // Dashboard unit tests — ESM (bun test), Node env.
  {
    files: ['web/dashboard/**/*.test.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-undef': 'warn',
    },
  },
];
