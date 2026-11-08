// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Logo } from "./logo";

/** KOBE-562: the reusable themed logo (inline SVG in currentColor, class .logo). */
afterEach(cleanup);

const MARKUP =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10" fill="currentColor">' +
  '<path id="kobe-logo-p" d="M0 0h20v10z"/></svg>';

describe("<Logo />", () => {
  it("inlines the variant with the .logo class, its size and the caller's class", () => {
    render(<Logo svg={MARKUP} className="extra" width={48} height={24} />);
    const host = document.querySelector('[data-logo="inline"]') as HTMLElement;
    expect(host.classList.contains("logo")).toBe(true);
    expect(host.classList.contains("extra")).toBe(true);
    const svg = host.querySelector("svg");
    expect(svg?.getAttribute("width")).toBe("48");
    expect(svg?.getAttribute("height")).toBe("24");
    expect(svg?.getAttribute("fill")).toBe("currentColor");
    expect(svg?.getAttribute("focusable")).toBe("false");
  });

  it("is decorative without a label and an image named by it with one", () => {
    const { rerender } = render(<Logo svg={MARKUP} />);
    const host = document.querySelector('[data-logo="inline"]') as HTMLElement;
    expect(host.getAttribute("aria-hidden")).toBe("true");
    expect(screen.queryByRole("img")).toBeNull();
    rerender(<Logo svg={MARKUP} label="Acme" />);
    expect(screen.getByRole("img", { name: "Acme" })).toBeTruthy();
  });

  it("renders nothing for markup that is not the server's inline-safe variant", () => {
    const { container } = render(
      <Logo svg={'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'} />,
    );
    expect(container.innerHTML).toBe("");
  });
});
