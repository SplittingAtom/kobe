// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceFileChange } from "@kobe/protocol";
import type { FilesApi } from "../../lib/files/api";
import { EditDraftStore } from "../../lib/files/editor-state";
import type { ChangeHint } from "../chat/use-file-change-hint";
import { useOutsideChange } from "./use-outside-change";

/**
 * KOBE-496 review: only this thread's own agent reloads a clean tab silently, and only for a
 * version this tab's own check found on that agent's hint, never because of a time window. A
 * deletion heard after a reconnect (at revision 0) still reaches the tab.
 */
const PATH = "notes.md";

function setup() {
  let listed = "v1";
  const api = {
    list: vi.fn(async () => ({
      ok: true as const,
      data: { path: "", entries: [{ path: PATH, type: "file", sha256: listed }] },
    })),
  } as unknown as FilesApi;
  const reread = vi.fn();
  const drafts = new EditDraftStore();
  interface Props {
    hint: ChangeHint | null;
    remote: WorkspaceFileChange | undefined;
    known: string;
  }
  const initialProps: Props = { hint: null, remote: undefined, known: "v1" };
  const hook = renderHook(
    (props: Props) => useOutsideChange({ api, path: PATH, drafts, reread, ...props }),
    { initialProps },
  );
  return {
    hook,
    reread,
    list: (sha: string) => (listed = sha),
    rerender: (p: { hint?: ChangeHint | null; remote?: WorkspaceFileChange; known?: string }) =>
      hook.rerender({ hint: null, remote: undefined, known: "v1", ...p }),
  };
}

const agentChange = (sha: string, rev: number): WorkspaceFileChange => ({
  path: PATH,
  sha256: sha,
  rev,
  actor: { kind: "agent", name: null },
  at: "2026-10-23T10:00:00.000Z",
});
const tick = () => act(() => new Promise((r) => setTimeout(r, 0)));

describe("useOutsideChange: whose agent (KOBE-496 review)", () => {
  it("an agent change after this thread's check ended is offered, not read in", async () => {
    const t = setup();
    const hint = { seq: 1, delays: [0] };
    t.rerender({ hint });
    await tick(); // the write hint's check found nothing new, and the schedule ended
    // Then another thread's or a schedule's agent pushes.
    t.list("v2");
    t.rerender({ hint, remote: agentChange("v2", 2) });
    await waitFor(() => expect(t.hook.result.current.outside?.kind).toBe("remote"));
    expect(t.reread).not.toHaveBeenCalled();
  });

  it("an agent change this thread's running check then finds is read in silently", async () => {
    const t = setup();
    const hint = { seq: 1, delays: [0, 40] };
    t.rerender({ hint });
    await tick();
    t.list("v2");
    t.rerender({ hint, remote: agentChange("v2", 2) });
    await waitFor(() => expect(t.hook.result.current.outside?.kind).toBe("updated"));
    expect(t.reread).toHaveBeenCalledTimes(1);
  });

  it("an agent change the running check never finds is offered when the check ends", async () => {
    const t = setup();
    const hint = { seq: 1, delays: [0, 30, 30] };
    t.rerender({ hint });
    await tick();
    // The stream says v2, but this thread's check keeps seeing v1 (not its agent's version).
    t.rerender({ hint, remote: agentChange("v2", 2) });
    expect(t.hook.result.current.outside).toBeNull();
    await waitFor(() => expect(t.hook.result.current.outside?.kind).toBe("remote"));
    expect(t.reread).not.toHaveBeenCalled();
  });

  it("a deletion heard after a reconnect, at revision 0, still closes a clean tab", async () => {
    const t = setup();
    t.rerender({ remote: agentChange("v1", 7) });
    await tick();
    t.rerender({ remote: { path: PATH, sha256: null, rev: 0, actor: null, at: null } });
    await waitFor(() => expect(t.reread).toHaveBeenCalledTimes(1));
  });
});
