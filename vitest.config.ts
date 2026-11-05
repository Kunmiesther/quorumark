/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: false,
    // Browser components need a DOM; the Fastify broker needs Node's native
    // request/response and timer implementations, not jsdom's substitutes.
    projects: [
      {
        extends: true,
        test: {
          name: "app",
          environment: "jsdom",
          include: ["src/**/*.{test,spec}.ts", "src/**/*.{test,spec}.tsx"],
        },
      },
      {
        extends: true,
        test: {
          name: "broker",
          environment: "node",
          include: ["broker/src/**/*.{test,spec}.ts"],
        },
      },
    ],
  },
});
