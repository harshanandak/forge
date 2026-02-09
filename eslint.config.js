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
      'test-env/fixtures/**',
      'packages/skills/test/fixtures/**',
    ],
  },
  // ES Modules (packages/skills and eslint.config.js)
  {
    files: ['packages/skills/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
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
    ignores: ['packages/skills/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-console': 'off',
      'no-prototype-builtins': 'off',
      'no-empty': 'off',
      'no-useless-escape': 'off',
      'preserve-caught-error': 'off',
      'no-undef': 'warn',
    },
  },
];
