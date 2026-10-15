// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useModalLayer } from "./use-modal-layer";

/**
 * A modal drawer or sheet closes on a press outside it, but not on a press in content portalled
 * out of it: Radix popovers, and the chat's dialogs (`data-kobe-portal`, KOBE-281), which mount in
 * the chat root next to the layer.
 */
function Layer({ onClose }: { readonly onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useModalLayer(ref, true, onClose, { modal: true, escape: true });
  return (
    <div data-kobe-chat>
      <div ref={ref} tabIndex={-1} data-testid="layer" />
      <p data-testid="outside">outside</p>
      <div role="dialog" data-kobe-portal data-testid="dialog">
        <input data-testid="dialog-input" />
      </div>
    </div>
  );
}

afterEach(cleanup);

describe("useModalLayer and portalled dialogs", () => {
  it("a press or Escape in a chat dialog leaves the layer open", () => {
    const onClose = vi.fn();
    const { getByTestId } = render(<Layer onClose={onClose} />);
    fireEvent.pointerDown(getByTestId("dialog-input"));
    fireEvent.keyDown(getByTestId("dialog-input"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a press elsewhere outside closes it", () => {
    const onClose = vi.fn();
    const { getByTestId } = render(<Layer onClose={onClose} />);
    fireEvent.pointerDown(getByTestId("outside"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
