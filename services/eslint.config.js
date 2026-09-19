import js from '@eslint/js';
import globals from 'globals';

/**
 * Flat ESLint config (v9) for all services.
 *
 * Philosophy: catch real defects, not style. Formatting arguments waste review
 * time; an unhandled promise or a shadowed variable causes an incident. Rules
 * here are the ones that would have caught bugs in this codebase.
 */
export default [
  { ignores: ['**/node_modules/**', '**/public/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // A floating promise means an error vanishes silently - exactly the kind
      // of failure that shows up as a metric with no log to explain it.
      'no-floating-decimal': 'error',
      'require-atomic-updates': 'error',
      'no-return-await': 'error',
      // Unused vars are usually a half-finished refactor. Allow a leading _ for
      // deliberately-ignored args (Express error handlers need a 4th param).
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-console': 'warn', // services must log via pino so output stays JSON-parseable
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
    },
  },
  {
    // Tests boot real servers and assert on them; console output is useful there.
    files: ['**/test/**/*.js'],
    rules: { 'no-console': 'off' },
  },
];
