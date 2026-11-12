// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Button } from "./button";
import { SidePanel } from "./side-panel";

/** KOBE-641: the console's side detail panel. */
afterEach(cleanup);

function Opener() {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  return (
    <div data-kobe-console="">
      <Button ref={opener} onClick={() => setOpen(true)}>
        Details
      </Button>
      <SidePanel
        open={open}
        onOpenChange={setOpen}
        title="Connector jira"
        returnFocus={() => opener.current}
      >
        <p>Inside</p>
      </SidePanel>
    </div>
  );
}

describe("SidePanel", () => {
  it("is a dialog named by its title that closes with Escape and returns focus", async () => {
    render(<Opener />);
    await userEvent.click(screen.getByRole("button", { name: "Details" }));
    const panel = await screen.findByRole("dialog", { name: "Connector jira" });
    expect(panel.textContent).toContain("Inside");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Details" }));
  });

  it("closes with its Close button", async () => {
    render(<Opener />);
    await userEvent.click(screen.getByRole("button", { name: "Details" }));
    await userEvent.click(await screen.findByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Details" }));
  });
});
