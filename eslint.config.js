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
    // content (titles, names, markers, tables) stays text but is never a bare text link. Caught:
    // an <a> or next/link <Link> with a letter or digit anywhere inside it (nested elements too),
    // written as JSX text, a {"string"} or a {`template`}. Allowed: prose links through InlineLink
    // and menu items through MenuLink (components/shell/text-links.tsx), which render children.
    files: ["apps/web/components/chat/**/*.tsx", "apps/web/components/shell/**/*.tsx"],
    ignores: ["**/*.test.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "JSXElement:matches([openingElement.name.name='a'], [openingElement.name.name='Link']) " +
            ":matches(JSXText[value=/[\\p{L}\\p{N}]/u], " +
            "JSXElement > JSXExpressionContainer > Literal[value=/[\\p{L}\\p{N}]/u], " +
            "JSXElement > JSXExpressionContainer > TemplateLiteral)",
          message:
            "No bare text links in the chat shell (CE13): use IconAction from components/shell/icon-action.tsx.",
        },
      ],
    },
  },
  prettier,
);
