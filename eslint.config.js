import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default [
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
    },
  },
  {
    // Node scripts run under Node (hook commands / release tooling), not part of the TS build.
    files: ["plugin/scripts/**/*.mjs", "scripts/**/*.mjs"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly" },
    },
  },
];
