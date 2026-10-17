// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useConfirm } from "./confirm-dialog";

/**
 * KOBE-294 (ac-2): the console's confirm dialog. A modal alert dialog named by its question,
 * focus starts on Cancel (the safe choice), Escape and Cancel decline, focus returns to the
 * trigger; it mounts in the console root, as the chat's dialogs mount in the chat root (KOBE-281).
 */
afterEach(cleanup);

function Revoke() {
  const [confirm, dialog] = useConfirm();
  const [answer, setAnswer] = useState("none");
  return (
    <div data-kobe-console="">
      <button
        type="button"
        onClick={async () => {
          const yes = await confirm({
            title: "Revoke the invitation to c@x.io?",
            description: "The link stops working.",
            confirmLabel: "Revoke",
          });
          setAnswer(String(yes));
        }}
      >
        Revoke c@x.io
      </button>
      <p data-testid="answer">{answer}</p>
      {dialog}
    </div>
  );
}

const answer = () => screen.getByTestId("answer").textContent;

async function open() {
  render(<Revoke />);
  await userEvent.click(screen.getByRole("button", { name: "Revoke c@x.io" }));
  return screen.findByRole("alertdialog", { name: "Revoke the invitation to c@x.io?" });
}

describe("useConfirm / ConfirmDialog", () => {
  it("asks in an alert dialog in the console root, described, with focus on Cancel", async () => {
    const dialog = await open();
    expect(dialog.closest("[data-kobe-console]")).not.toBeNull();
    const described = document.getElementById(dialog.getAttribute("aria-describedby") ?? "");
    expect(described?.textContent).toBe("The link stops working.");
    await waitFor(() =>
      expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" })),
    );
    expect(within(dialog).getByRole("button", { name: "Revoke" }).dataset["variant"]).toBe(
      "danger",
    );
  });

  it("resolves true when confirmed", async () => {
    const dialog = await open();
    await userEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(answer()).toBe("true"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("resolves false on Cancel and on Escape, and gives the trigger its focus back", async () => {
    let dialog = await open();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(answer()).toBe("false"));
    const trigger = screen.getByRole("button", { name: "Revoke c@x.io" });
    await waitFor(() => expect(document.activeElement).toBe(trigger));

    cleanup();
    dialog = await open();
    expect(dialog).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(answer()).toBe("false"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
