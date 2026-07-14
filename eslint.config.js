import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'dist-ui/**',
      'node_modules/**',
      'playwright-report/**',
      'test-results/**',
      'vendor/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['scripts/**/*.{ts,mjs}', 'src/**/*.ts', 'test/**/*.ts', 'ui/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      'no-console': 'off',
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // The evaluator drives a browser page via Playwright's page.evaluate(),
    // whose callbacks run in a separate (untyped-here) DOM realm — casting
    // through `any` to reach the harness's custom window globals is the
    // standard way to cross that boundary.
    files: ['src/suites/ui/evaluator/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
