import js from "@eslint/js";
import stylistic from "@stylistic/eslint-plugin";
import importPlugin from "eslint-plugin-import";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["build/**", "coverage/**", "dist/**", "node_modules/**", ".data/**", ".improvements/**"]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node
      }
    },
    plugins: {
      "@stylistic": stylistic,
      import: importPlugin,
      "react-hooks": reactHooks
    },
    settings: {
      "import/resolver": {
        typescript: {
          project: ["./tsconfig.json", "./tsconfig.server.json"],
          noWarnOnMultipleProjects: true
        }
      }
    },
    rules: {
      "@stylistic/array-bracket-spacing": ["error", "never"],
      "@stylistic/comma-dangle": ["error", "never"],
      "@stylistic/comma-spacing": "error",
      "@stylistic/eol-last": "error",
      "@stylistic/jsx-quotes": ["error", "prefer-double"],
      "@stylistic/key-spacing": "error",
      "@stylistic/no-trailing-spaces": "error",
      "@stylistic/object-curly-spacing": ["error", "always"],
      "@stylistic/quotes": ["error", "double", { "allowTemplateLiterals": "always", "avoidEscape": true }],
      "@stylistic/semi": ["error", "always"],
      "@typescript-eslint/no-unsafe-declaration-merging": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-expressions": ["error", { "allowShortCircuit": true, "allowTernary": true }],
      "import/first": "error",
      "import/newline-after-import": "error",
      "import/no-duplicates": "error",
      "import/no-unresolved": ["error", { "commonjs": true }],
      "import/order": ["error", {
        "alphabetize": { "order": "ignore" },
        "groups": ["builtin", "external", "internal", "parent", "sibling", "index", "object", "type"],
        "newlines-between": "never"
      }],
      "no-control-regex": "off",
      "prefer-const": ["error", { "ignoreReadBeforeAssign": true }],
      "react-hooks/exhaustive-deps": "error",
      "react-hooks/rules-of-hooks": "error"
    }
  },
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" }]
    }
  }
);
