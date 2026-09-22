import panatesEslint from '@panates/eslint-config-ts';
import globals from 'globals';

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    ignores: ['build/**/*', 'node_modules/**/*', 'test-*/**/*'],
  },
  ...panatesEslint.configs.node,
  {
    languageOptions: {
      globals: {
        ...globals.jest,
      },
    },
  },
];
