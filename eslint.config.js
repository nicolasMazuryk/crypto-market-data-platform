import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import eslintConfigPrettier from 'eslint-config-prettier'
import globals from 'globals'

const tsFiles = ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts']

const strictTypeChecked = tseslint.configs.strictTypeChecked.map(config => ({
  ...config,
  files: config.files ?? tsFiles,
}))

const stylisticTypeChecked = tseslint.configs.stylisticTypeChecked.map(config => ({
  ...config,
  files: config.files ?? tsFiles,
}))

export default tseslint.config(
  eslint.configs.recommended,
  ...strictTypeChecked,
  ...stylisticTypeChecked,
  eslintConfigPrettier,
  {
    ignores: ['dist/', 'node_modules/', '.sst/', 'infra/', 'sst.config.ts', 'sst-env.d.ts', '.claude/', 'scripts/'],
  },
  {
    files: tsFiles,
    languageOptions: {
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'separate-type-imports',
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  }
)
