import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}", "lib/**/*.{ts,tsx}", "utils/**/*.{ts,tsx}"],
      exclude: ["test/**", "app/layout.tsx", "services/**"],
      thresholds: {
        statements: 30,
      },
    },
  },
  resolve: {
    alias: {
      "~~": path.resolve(__dirname, "."),
    },
  },
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
});
