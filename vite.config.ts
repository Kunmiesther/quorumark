import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";

export default defineConfig({
  // Meteor's browser bundle still references the Node global alias. Keep the
  // selector usable in browsers without exposing any server globals.
  define: { global: "globalThis" },
  plugins: [
    tsconfigPaths(),
    tailwindcss(),
    ...tanstackStart({
      server: { entry: "server" },
      router: { routeFileIgnorePattern: "__tests__" },
    }),
    react(),
  ],
});
