// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Button } from "./button";
import { Dialog, DialogClose } from "./dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs";

/** KOBE-321: the console's tabs and its form dialog (the Skills page, Save version). */
afterEach(cleanup);

function Shown({ start = "b" }: { readonly start?: string }) {
  const [value, setValue] = useState(start);
  return (
    <>
      <Tabs value={value} onValueChange={setValue}>
        <TabsList label="Skills">
          <TabsTrigger value="a">Alpha</TabsTrigger>
          <TabsTrigger value="b">Beta</TabsTrigger>
          <TabsTrigger value="c">Gamma</TabsTrigger>
        </TabsList>
        <TabsContent value="a">Alpha panel</TabsContent>
        <TabsContent value="b">Beta panel</TabsContent>
        <TabsContent value="c">Gamma panel</TabsContent>
      </Tabs>
      <p data-testid="value">{value}</p>
    </>
  );
}

describe("Tabs", () => {
  it("is a named tablist whose selected tab shows its own panel", () => {
    render(<Shown />);
    expect(screen.getByRole("tablist", { name: "Skills" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Beta" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel", { name: "Beta" }).textContent).toBe("Beta panel");
    expect(screen.queryByText("Alpha panel")).toBeNull();
  });

  it("moves and selects with the arrow keys, and selects on click", async () => {
    render(<Shown />);
    screen.getByRole("tab", { name: "Beta" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByTestId("value").textContent).toBe("c");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Gamma" }));
    await userEvent.click(screen.getByRole("tab", { name: "Alpha" }));
    expect(screen.getByRole("tabpanel", { name: "Alpha" }).textContent).toBe("Alpha panel");
  });
});

function Opener() {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  return (
    <div data-kobe-console="">
      <Button ref={opener} onClick={() => setOpen(true)}>
        Save version
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Save a version"
        description="Pick one."
        returnFocus={() => opener.current}
      >
        <label>
          Changelog <input />
        </label>
        <DialogClose asChild>
          <Button>Cancel</Button>
        </DialogClose>
      </Dialog>
    </div>
  );
}

describe("Dialog", () => {
  it("opens a named, described modal dialog in the console root; Cancel and Escape close it", async () => {
    render(<Opener />);
    const opener = screen.getByRole("button", { name: "Save version" });
    await userEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "Save a version" });
    expect(dialog.closest("[data-kobe-console]")).not.toBeNull();
    expect(dialog.getAttribute("aria-describedby")).not.toBeNull();
    expect(screen.getByLabelText("Changelog")).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
    await userEvent.click(opener);
    await screen.findByRole("dialog", { name: "Save a version" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
