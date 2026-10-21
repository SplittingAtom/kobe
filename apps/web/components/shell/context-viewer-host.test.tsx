// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextRead } from "../../lib/chat/context-viewer";
import { contextOf, section } from "../../lib/chat/testing/context-fixtures";
import { ContextViewerHost, useOpenContextViewer } from "./context-viewer";
import { IconActionProvider } from "./icon-action";

/** KOBE-471: the viewer belongs to the thread it was opened on. */
const screenThread = vi.hoisted(() => ({ id: "t1" as string | null }));
const read = vi.fn(async (): Promise<ContextRead> => ({
  kind: "ready",
  context: contextOf([section("other", 1)]),
}));

vi.mock("../chat/kobe-runtime", () => ({
  useKobeExtras: () => ({
    controller: { threadContext: read },
    state: { threadId: screenThread.id },
  }),
}));

afterEach(() => {
  cleanup();
  screenThread.id = "t1";
});

function Opener() {
  const open = useOpenContextViewer();
  return (
    <button type="button" onClick={() => open?.(null)}>
      open
    </button>
  );
}

const app = () => (
  <IconActionProvider>
    <div data-kobe-chat>
      <ContextViewerHost>
        <Opener />
      </ContextViewerHost>
    </div>
  </IconActionProvider>
);

describe("context viewer host", () => {
  it("closes when another thread comes on screen, and stays closed on the way back", async () => {
    const view = render(app());
    await userEvent.setup().click(screen.getByRole("button", { name: "open" }));
    await screen.findByRole("dialog", { name: "Context" });
    screenThread.id = "t2";
    act(() => view.rerender(app()));
    expect(screen.queryByRole("dialog", { name: "Context" })).toBeNull();
    screenThread.id = "t1";
    act(() => view.rerender(app()));
    expect(screen.queryByRole("dialog", { name: "Context" })).toBeNull();
  });
});
