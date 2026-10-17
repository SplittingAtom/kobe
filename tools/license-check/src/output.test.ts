import { afterEach, describe, expect, it, vi } from "vitest";
import { warnPending } from "./output.js";

describe("warnPending", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("prints a GitHub warning annotation in Actions", () => {
    vi.stubEnv("GITHUB_ACTIONS", "true");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    warnPending(["busybox 1.37 (GPL-2.0-only): test-only"]);
    expect(log).toHaveBeenCalledWith(
      "::warning title=License pending gate review::pending gate review: busybox 1.37 (GPL-2.0-only): test-only",
    );
  });

  it("prints a plain warning elsewhere", () => {
    vi.stubEnv("GITHUB_ACTIONS", "");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    warnPending(["x"]);
    expect(log).toHaveBeenCalledWith("warning: pending gate review: x");
  });
});
