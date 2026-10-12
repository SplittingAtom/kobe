import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/next-env.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Tests poke at loosely typed HTTP/JSON payloads; production code stays strict.
    files: ["**/*.test.ts", "**/testing/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  {
    // CE13 (KOBE-203): navigation and actions in the chat shell are IconActions with tooltips;
    // content (titles, names, markers, tables) stays text but is never a bare text link.
    files: ["apps/web/components/chat/**/*.tsx", "apps/web/components/shell/**/*.tsx"],
    ignores: ["**/*.test.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXElement[openingElement.name.name='a'] > JSXText[value=/\\w/]",
          message:
            "No bare text links in the chat shell (CE13): use IconAction from components/shell/icon-action.tsx.",
        },
      ],
    },
  },
  prettier,
);
