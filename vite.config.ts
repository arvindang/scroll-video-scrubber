import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ mode }) => {
  const isTest = mode === "test";

  return {
    root: isTest ? projectRoot : "docs",
    base: isTest ? "/" : "/scroll-video-scrubber/",
    build: {
      outDir: isTest ? "site-dist" : "../site-dist",
      emptyOutDir: true,
      target: "es2022",
    },
    test: {
      environment: "jsdom",
      include: ["tests/**/*.test.ts"],
      restoreMocks: true,
      clearMocks: true,
    },
  };
});
