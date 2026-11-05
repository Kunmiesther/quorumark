// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro (build-only using cloudflare as a default target),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { mcpPlugin } from "@lovable.dev/mcp-js/stacks/tanstack/vite";

// The installed Lovable MCP plugin compares slash-normalized Vite roots with
// Windows backslash paths and aborts before the app can start. The generated
// MCP route files already exist in this checkout, so keep the plugin active on
// POSIX builds and skip only its redundant local generation on Windows.
const localPlugins = process.platform === "win32" ? [] : [mcpPlugin()];

const publicBackendDefine = Object.fromEntries(
  [
    [
      "VITE_SUPABASE_URL",
      process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "https://sthdmulczzebfcmihhca.supabase.co",
    ],
    [
      "VITE_SUPABASE_PUBLISHABLE_KEY",
      process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
        process.env.SUPABASE_PUBLISHABLE_KEY ??
        "sb_publishable_duAF8NclyRsIOgwEUgyWfw_UFvAxIvd",
    ],
    [
      "VITE_SUPABASE_PROJECT_ID",
      process.env.VITE_SUPABASE_PROJECT_ID ?? process.env.SUPABASE_PROJECT_ID ?? "sthdmulczzebfcmihhca",
    ],
  ]
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([name, value]) => [`import.meta.env.${name}`, JSON.stringify(value)]),
);

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
    router: { routeFileIgnorePattern: "__tests__" },
  },
  vite: {
    define: publicBackendDefine,
    plugins: localPlugins,
  },
});
