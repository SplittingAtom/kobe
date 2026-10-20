// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useRef, useState } from "react";
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

/** KOBE-452 review: content that mounts after the layer opened (the chat loading under a panel). */
function LateLayer() {
  const ref = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  useModalLayer(ref, true, () => {}, { modal: true, escape: true });
  return (
    <div data-kobe-chat>
      <button type="button" data-testid="ready" onClick={() => setReady(true)}>
        ready
      </button>
      {ready ? <main data-testid="late">chat</main> : <p data-testid="loading">Loading</p>}
      <div ref={ref} tabIndex={-1} data-testid="layer" />
      {ready && <div data-kobe-portal data-testid="portal" />}
    </div>
  );
}

describe("useModalLayer keeps the background inert", () => {
  it("also what mounts beside the layer after it opened; portals stay reachable", async () => {
    const { getByTestId, unmount } = render(<LateLayer />);
    expect(getByTestId("loading").hasAttribute("inert")).toBe(true);
    act(() => getByTestId("ready").click());
    await vi.waitFor(() => expect(getByTestId("late").hasAttribute("inert")).toBe(true));
    expect(getByTestId("portal").hasAttribute("inert")).toBe(false);
    expect(getByTestId("layer").hasAttribute("inert")).toBe(false);
    const late = getByTestId("late");
    unmount();
    expect(late.hasAttribute("inert")).toBe(false);
  });
});
