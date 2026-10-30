// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

type Callback = (metric: { name: string; value: number; rating?: string }) => void;
const hook = vi.hoisted(() => ({ callback: undefined as Callback | undefined }));
vi.mock("next/web-vitals", () => ({
  useReportWebVitals: (cb: Callback) => {
    hook.callback = cb;
  },
}));

import { WebVitalsReporter } from "./web-vitals-reporter";

/** KOBE-525 ac-1: every page (root layout) reports its Web Vitals when it is hidden. */
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

function hide() {
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
}

describe("WebVitalsReporter", () => {
  it("sends the page's metrics with its route template once the page is hidden", () => {
    const send = vi.fn();
    window.history.replaceState(null, "", "/me/agents/0b6f1c2e-6d1a-4c56-9a43-1f0e2d3c4b5a");
    render(<WebVitalsReporter send={send} />);
    hook.callback?.({ name: "LCP", value: 900, rating: "good" });
    hook.callback?.({ name: "Custom", value: 1 });
    expect(send).not.toHaveBeenCalled();
    hide();
    expect(send).toHaveBeenCalledWith([
      { name: "LCP", value: 900, route: "/me/agents/[id]", rating: "good" },
    ]);
  });

  it("reports nothing on signed-out pages", () => {
    const send = vi.fn();
    window.history.replaceState(null, "", "/sign-in");
    render(<WebVitalsReporter send={send} />);
    hook.callback?.({ name: "LCP", value: 900 });
    hide();
    expect(send).not.toHaveBeenCalled();
  });
});
