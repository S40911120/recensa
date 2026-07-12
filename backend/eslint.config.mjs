import js from '@eslint/js';
import globals from 'globals';

// Backend lint (CommonJS Node; the frontend lint config lives in frontend/eslint.config.mjs)
export default [
  { ignores: ['node_modules/**', 'data/**'] },
  {
    files: ['src/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
];
