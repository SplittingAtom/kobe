// @vitest-environment happy-dom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useProjectMutation } from "./use-project-mutation";
import { WorkspaceProjectsProvider } from "./workspace-projects";
import { routedFetch, TEAM, wireProject } from "./workspace-testing";

afterEach(cleanup);

function setup(
  change: () => Promise<{ ok: true; status: number; data: null } | { ok: false; error: never }>,
) {
  const { fetchFn, calls } = routedFetch({
    "GET /v1/projects": [200, { projects: [wireProject("a")] }],
    "GET /v1/me/checkouts": [200, { checkouts: [] }],
  });
  let mutation!: ReturnType<typeof useProjectMutation>;
  function Probe() {
    mutation = useProjectMutation();
    return null;
  }
  render(
    <WorkspaceProjectsProvider teamId={TEAM} fetchFn={fetchFn}>
      <Probe />
    </WorkspaceProjectsProvider>,
  );
  return { run: () => act(() => mutation.run(change)), calls };
}

describe("useProjectMutation (FP6)", () => {
  it("reads the project list again after a saved change, not after a refused one", async () => {
    const ok = setup(async () => ({ ok: true, status: 200, data: null }));
    await ok.run();
    expect(ok.calls.filter((c) => c.url === "/v1/projects")).toHaveLength(1);
    cleanup();
    const refused = setup(async () => ({ ok: false, error: { status: 403 } as never }));
    await refused.run();
    expect(refused.calls.filter((c) => c.url === "/v1/projects")).toHaveLength(0);
    vi.restoreAllMocks();
  });
});
