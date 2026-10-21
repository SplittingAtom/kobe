// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { Dialog } from "radix-ui";
import { afterEach, describe, expect, it } from "vitest";
import { StyleNonce } from "./style-nonce";

/**
 * KOBE-469: Radix's modal scroll lock (react-remove-scroll -> react-style-singleton) injects a
 * `<style>` nonced from `get-nonce`; StyleNonce hands it the document's CSP nonce.
 */
const NONCE = "style-nonce-469";

afterEach(() => {
  cleanup();
  document.head.querySelectorAll("script").forEach((s) => s.remove());
});

describe("StyleNonce", () => {
  it("nonces the <style> a modal Radix dialog injects", async () => {
    const script = document.createElement("script");
    script.setAttribute("nonce", NONCE);
    script.nonce = NONCE;
    document.head.append(script);
    render(
      <>
        <StyleNonce />
        <Dialog.Root open>
          <Dialog.Portal>
            <Dialog.Overlay />
            <Dialog.Content aria-describedby={undefined}>
              <Dialog.Title>Modal</Dialog.Title>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </>,
    );
    await screen.findByRole("dialog", { name: "Modal" });
    // The overlay holds the scroll lock (RemoveScroll).
    const lock = await waitFor(() => {
      const found = Array.from(document.head.querySelectorAll("style")).filter((s) =>
        /block-interactivity|data-scroll-locked/.test(s.textContent ?? ""),
      );
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    for (const style of lock) expect(style.getAttribute("nonce")).toBe(NONCE);
  });
});
