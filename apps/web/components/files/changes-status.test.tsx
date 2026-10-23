// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FilesApi } from "../../lib/files/api";
import { EditDraftStore, FileReviewStore } from "../../lib/files/editor-state";
import { FileEditor } from "./file-editor";
import { LIVE_OFF_NOTE } from "./outside-change-notice";

/** KOBE-496 review: the badge's live region is always there; tabs past the limit say so. */
afterEach(cleanup);

function editor(props: Partial<Parameters<typeof FileEditor>[0]> = {}) {
  return (
    <FileEditor
      path="notes.md"
      text="one\n"
      sha256={"a".repeat(64)}
      truncated={false}
      api={{} as FilesApi}
      drafts={new EditDraftStore()}
      reviews={new FileReviewStore()}
      onSaved={vi.fn()}
      onReload={vi.fn()}
      {...props}
    />
  );
}

describe("file editor change status (KOBE-496)", () => {
  it("keeps an empty live region mounted, then fills it with the badge", async () => {
    const view = render(editor());
    const region = document.querySelector("[data-kobe-changes-status]");
    expect(region?.getAttribute("role")).toBe("status");
    expect(region?.textContent).toBe("");
    const reload = vi.fn();
    await act(async () =>
      view.rerender(
        editor({
          outside: {
            kind: "remote",
            sha256: "b".repeat(64),
            by: { actor: { kind: "agent", name: null }, at: null },
          },
          onOutsideReload: reload,
        }),
      ),
    );
    // The same element, now with the text: announced as a change of a live region.
    expect(document.querySelector("[data-kobe-changes-status]")).toBe(region);
    expect(region?.textContent).toContain("The agent changed this file just now.");
    screen.getByRole("button", { name: "Reload notes.md" }).click();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("tells a tab past the stream's path limit that it gets no live updates", () => {
    render(editor({ liveOff: true }));
    expect(screen.getByText(LIVE_OFF_NOTE).getAttribute("role")).toBe("note");
  });
});
