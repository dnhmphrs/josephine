/* Flat config. The project is vanilla ES modules for the browser plus two
   Node build scripts, and nothing else - the previous config was a leftover
   SvelteKit one that referenced a plugin this repo has never installed. */
import js from '@eslint/js';
import globals from 'globals';

export default [
  /* `.claude/` holds agent worktrees - whole copies of this repo, build output
     and archive included - and it is gitignored. Linting it lints the project
     several times over, in its built form. */
  { ignores: ['dist/**', 'node_modules/**', '_archive/**', 'public/**', '.claude/**'] },
  js.configs.recommended,
  {
    files: ['src/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.browser,
    },
    rules: {
      'no-unused-vars': ['error', { args: 'after-used', caughtErrors: 'none' }],
    },
  },
  {
    files: ['scripts/**/*.mjs', 'rollup.config.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      /* scripts/check.mjs is Node, but the bodies of its page.evaluate()
         callbacks are serialised and run in the browser, so both sets of
         globals are legitimately in scope in one file. */
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'no-unused-vars': ['error', { args: 'after-used', caughtErrors: 'none' }],
    },
  },
];
