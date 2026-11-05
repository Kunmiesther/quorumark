import js from "@eslint/js";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", ".output", ".vinxi"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "server-only",
              message:
                "TanStack Start does not use the Next.js `server-only` package. Rename the module to `*.server.ts` or mark it with `@tanstack/react-start/server-only`.",
            },
          ],
        },
      ],
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    // Scout intelligence layer is READ-ONLY. Forbid any import that could
    // reach an execution / order / wallet mutation surface.
    files: [
      "src/lib/scout/**/*.{ts,tsx}",
      "src/components/scout/**/*.{ts,tsx}",
      "src/hooks/useScoutActivation.ts",
      "src/hooks/useScoutIntelligence.ts",
    ],
    ignores: ["**/__tests__/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            "@/lib/paper/engine",
            "@/lib/paper/engine/**",
            "@/lib/paper/operations",
            "@/lib/paper/repository",
            "@/lib/paper/ladder",
            "@/lib/paper/accumulator-dca",
            "@/lib/onyx/decide",
            "@/integrations/supabase/client.server",
          ],
        },
      ],
    },
  },
  eslintPluginPrettier,
);
