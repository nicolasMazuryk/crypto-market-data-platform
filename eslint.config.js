import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

const tsFiles = ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"];

const strictTypeChecked = tseslint.configs.strictTypeChecked.map((config) => ({
  ...config,
  files: config.files ?? tsFiles,
}));

const stylisticTypeChecked = tseslint.configs.stylisticTypeChecked.map(
  (config) => ({
    ...config,
    files: config.files ?? tsFiles,
  })
);

export default tseslint.config(
  eslint.configs.recommended,
  ...strictTypeChecked,
  ...stylisticTypeChecked,
  eslintConfigPrettier,
  {
    ignores: ["dist/", "node_modules/", ".sst/", "infra/", "sst.config.ts", "sst-env.d.ts"],
  },
  {
    files: tsFiles,
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["*.config.ts"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          prefer: "type-imports",
          fixStyle: "separate-type-imports",
        },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  }
);
