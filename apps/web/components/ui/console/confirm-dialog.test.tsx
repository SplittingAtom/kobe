// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { eventTrigger, useConfirm } from "./confirm-dialog";

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

describe("focus and lifecycle (review S3, nits)", () => {
  function Remove({ onAnswer }: { readonly onAnswer: (yes: boolean) => void }) {
    const [confirm, dialog] = useConfirm();
    const [gone, setGone] = useState(false);
    return (
      <div data-kobe-console="">
        <main id="console-main" tabIndex={-1}>
          {!gone && (
            <button
              type="button"
              onClick={async () => {
                const yes = await confirm({ title: "Remove Ada?", confirmLabel: "Remove" });
                if (yes) setGone(true);
                onAnswer(yes);
              }}
            >
              Remove Ada
            </button>
          )}
        </main>
        {dialog}
      </div>
    );
  }

  it("when the asking control is gone, focus lands on the page's main", async () => {
    const answers: boolean[] = [];
    render(<Remove onAnswer={(yes) => answers.push(yes)} />);
    await userEvent.click(screen.getByRole("button", { name: "Remove Ada" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Remove Ada?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(answers).toEqual([true]));
    expect(screen.queryByRole("button", { name: "Remove Ada" })).toBeNull();
    await waitFor(() => expect(document.activeElement?.id).toBe("console-main"));
  });

  it("returns focus to the control passed as the trigger, though a mouse click left it unfocused", async () => {
    // Safari and macOS Firefox: clicking a button doesn't focus it (fireEvent moves no focus).
    function Ask() {
      const [confirm, dialog] = useConfirm();
      return (
        <div data-kobe-console="">
          <button
            type="button"
            onClick={(e) =>
              void confirm({ title: "Disable jira?", confirmLabel: "Disable" }, eventTrigger(e))
            }
          >
            Disable jira
          </button>
          {dialog}
        </div>
      );
    }
    render(<Ask />);
    const trigger = screen.getByRole("button", { name: "Disable jira" });
    expect(document.activeElement).toBe(document.body);
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("alertdialog", { name: "Disable jira?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("after a confirmed action, focus returns to its control once it is enabled again", async () => {
    // The page disables the control while the action runs (mutation pending), as console pages do.
    let finish: () => void = () => undefined;
    function Deactivate() {
      const [confirm, dialog] = useConfirm();
      const [pending, setPending] = useState(false);
      return (
        <div data-kobe-console="">
          <main id="console-main" tabIndex={-1}>
            <button
              type="button"
              disabled={pending}
              onClick={async (e) => {
                const trigger = eventTrigger(e);
                if (
                  !(await confirm(
                    { title: "Deactivate Bob?", confirmLabel: "Deactivate" },
                    trigger,
                  ))
                )
                  return;
                setPending(true);
                await new Promise<void>((resolve) => {
                  finish = resolve;
                });
                setPending(false);
              }}
            >
              Deactivate Bob
            </button>
          </main>
          {dialog}
        </div>
      );
    }
    render(<Deactivate />);
    const trigger = screen.getByRole("button", { name: "Deactivate Bob" });
    await userEvent.click(trigger);
    const dialog = await screen.findByRole("alertdialog", { name: "Deactivate Bob?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Deactivate" }));
    await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(true));
    await waitFor(() => expect(document.activeElement?.id).toBe("console-main"));
    act(() => finish());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("a press outside the dialog doesn't answer it", async () => {
    const dialog = await (async () => {
      render(<Remove onAnswer={() => {}} />);
      await userEvent.click(screen.getByRole("button", { name: "Remove Ada" }));
      return screen.findByRole("alertdialog", { name: "Remove Ada?" });
    })();
    fireEvent.pointerDown(document.body);
    fireEvent.click(document.body);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByRole("alertdialog")).toBe(dialog);
  });

  it("an unanswered question resolves false when the component unmounts", async () => {
    const answers: boolean[] = [];
    const { unmount } = render(<Remove onAnswer={(yes) => answers.push(yes)} />);
    await userEvent.click(screen.getByRole("button", { name: "Remove Ada" }));
    await screen.findByRole("alertdialog");
    act(() => unmount());
    await waitFor(() => expect(answers).toEqual([false]));
  });
});
