// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IconActionProvider } from "../shell/icon-action";
import { ClosableNotice } from "./closable-notice";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

const notice = (id: string) => (
  <IconActionProvider>
    <ClosableNotice id={id} label="Close notice" className="n" role="note">
      <p>Steered</p>
    </ClosableNotice>
  </IconActionProvider>
);

describe("ClosableNotice (KOBE-468)", () => {
  it("hides on close and stays closed after a reload", async () => {
    render(notice("run-1:3"));
    await userEvent.setup().click(screen.getByRole("button", { name: "Close notice" }));
    expect(screen.queryByText("Steered")).toBeNull();
    cleanup();
    render(notice("run-1:3"));
    expect(screen.queryByText("Steered")).toBeNull();
    render(notice("run-1:4"));
    expect(screen.getByText("Steered")).toBeTruthy();
  });

  it("still closes when browser storage is blocked", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(notice("run-1:3"));
    await userEvent.setup().click(screen.getByRole("button", { name: "Close notice" }));
    expect(screen.queryByText("Steered")).toBeNull();
  });

  it("renders shown first, so server and first client render match, then hides a closed one", async () => {
    localStorage.setItem("kobe.chat.closedNotices", JSON.stringify(["run-1:3"]));
    expect(renderToString(notice("run-1:3"))).toContain("Steered");
    render(notice("run-1:3"));
    await waitFor(() => expect(screen.queryByText("Steered")).toBeNull());
  });

  it("moves focus to the composer when closed", async () => {
    render(
      <div data-kobe-thread-root>
        {notice("run-1:3")}
        <div data-kobe-composer>
          <textarea aria-label="Message" />
        </div>
      </div>,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Close notice" }));
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Message" }));
  });
});
