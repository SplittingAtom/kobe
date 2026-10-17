import { defineConfig } from "vitest/config";

// happy-dom's window is 1024 px wide by default, which is the 820–1100 band of the shell's
// breakpoints (CE7, KOBE-201). Tests run at a desktop width unless they set one themselves.
export default defineConfig({
  test: {
    environmentOptions: { happyDOM: { width: 1280, height: 800 } },
    // Longer waits for findBy*/waitFor under CI load (vitest.setup.ts); the test timeout must
    // stay above them.
    setupFiles: ["./vitest.setup.ts"],
    testTimeout: 20_000,
  },
});
