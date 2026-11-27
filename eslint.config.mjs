import panatesEslint from '@panates/eslint-config-ts';
import globals from 'globals';

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    ignores: [
      'node_modules/**/*',
      'build/**/*',
      'test-*/**/*',
      // A generated Prisma client, for the benchmark's own schema.
      'benchmark/generated/**/*',
    ],
  },
  ...panatesEslint.configs.node,
  {
    languageOptions: {
      globals: {
        ...globals.mocha,
      },
    },
  },
];
