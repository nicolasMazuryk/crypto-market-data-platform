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
    ignores: ["dist/", "node_modules/"],
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
    },
  }
);
