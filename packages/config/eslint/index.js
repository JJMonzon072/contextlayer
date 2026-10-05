// @ts-check
/**
 * Shared ESLint flat-config factories for the ContextLayer monorepo.
 *
 * Every workspace package owns a tiny `eslint.config.js` that calls one of these
 * factories, so `pnpm --filter <pkg> lint` works in isolation and type-aware
 * rules resolve the package's own `tsconfig.json`.
 */
import js from '@eslint/js'
import { vueTsConfigs, withVueTs } from '@vue/eslint-config-typescript'
import { defineConfig, globalIgnores } from 'eslint/config'
import prettier from 'eslint-config-prettier/flat'
import pluginVue from 'eslint-plugin-vue'
import globals from 'globals'
import tseslint from 'typescript-eslint'

/** @typedef {'node' | 'browser' | 'webextensions'} Environment */

const ignores = globalIgnores([
  '**/dist/**',
  '**/dist-e2e/**',
  '**/coverage/**',
  '**/playwright-report/**',
  '**/test-results/**',
  '**/drizzle/meta/**',
])

/**
 * Rules we tighten or relax on top of the typescript-eslint presets.
 * @type {import('eslint').Linter.RulesRecord}
 */
const sharedRules = {
  eqeqeq: ['error', 'always'],
  'no-console': 'error',
  '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
  '@typescript-eslint/no-unused-vars': [
    'error',
    { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
  ],
  '@typescript-eslint/restrict-template-expressions': [
    'error',
    { allowNumber: true, allowBoolean: true },
  ],
}

/**
 * @param {Environment[]} environments
 * @returns {Record<string, boolean | 'readonly' | 'writable' | 'off'>}
 */
function globalsFor(environments) {
  return Object.assign({}, ...environments.map((env) => globals[env]))
}

/**
 * Config for TypeScript packages without Vue (API, shared contracts).
 *
 * @param {{ tsconfigRootDir: string, environments?: Environment[] }} options
 */
export function typescriptConfig({ tsconfigRootDir, environments = ['node'] }) {
  return defineConfig(
    ignores,
    js.configs.recommended,
    tseslint.configs.strictTypeChecked,
    tseslint.configs.stylisticTypeChecked,
    {
      languageOptions: {
        globals: globalsFor(environments),
        parserOptions: { projectService: true, tsconfigRootDir },
      },
      rules: sharedRules,
    },
    {
      files: ['**/*.js', '**/*.mjs'],
      extends: [tseslint.configs.disableTypeChecked],
    },
    prettier,
  )
}

/**
 * Config for Vue 3 + TypeScript packages (dashboard, extension, UI kit).
 * `withVueTs` wires vue-eslint-parser and type-aware linting inside `.vue` files.
 *
 * @param {{ tsconfigRootDir: string, environments?: Environment[] }} options
 */
export function vueConfig({ tsconfigRootDir, environments = ['browser'] }) {
  return withVueTs(
    { rootDir: tsconfigRootDir },
    ignores,
    js.configs.recommended,
    pluginVue.configs['flat/recommended'],
    vueTsConfigs.strictTypeChecked,
    vueTsConfigs.stylisticTypeChecked,
    {
      languageOptions: {
        globals: globalsFor(environments),
        parserOptions: { tsconfigRootDir },
      },
      rules: {
        ...sharedRules,
        // Guide content is untrusted and ends up inside customer applications:
        // it is rendered with text nodes, never as HTML (R-11).
        'vue/no-v-html': 'error',
      },
    },
    {
      files: ['**/*.js', '**/*.mjs'],
      extends: [vueTsConfigs.disableTypeChecked],
    },
    prettier,
  )
}
