// @vitest-environment happy-dom
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { must } from "../../lib/testing/must";
import { MemorySwitchesSection } from "./install/memory-switches";
import { TeamMemoryPage } from "./team/memory-page";
import { renderInstall, renderTeam, stubApi } from "./testing";

afterEach(cleanup);

const TEAM = "/v1/memory/settings?level=team";
const INSTALL = "/v1/memory/settings?level=install";
const on = { memory_enabled: true, project_memory_enabled: true };

describe("Team memory switches (KOBE-158, ac-3)", () => {
  it("shows both switches and persists turning all memory off", async () => {
    const calls = stubApi({
      [`GET ${TEAM}`]: [
        [200, on],
        [200, { memory_enabled: false, project_memory_enabled: true }],
      ],
      [`PUT ${TEAM}`]: [200, { memory_enabled: false, project_memory_enabled: true }],
    });
    renderTeam(<TeamMemoryPage />);
    const all = await screen.findByRole("checkbox", { name: /Allow memory for this team/ });
    const project = screen.getByRole("checkbox", { name: /Allow project memory/ });
    expect((all as HTMLInputElement).checked).toBe(true);
    expect((project as HTMLInputElement).checked).toBe(true);
    await userEvent.click(all);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/Memory is off for this team/);
    expect(JSON.parse(String(must(calls.find((c) => c.method === "PUT")).body))).toEqual({
      memory_enabled: false,
      project_memory_enabled: true,
    });
    expect(must(calls.find((c) => c.method === "PUT")).headers.get("x-kobe-team")).toBe("t-1");
  });

  it("project memory can be turned off alone", async () => {
    const calls = stubApi({
      [`GET ${TEAM}`]: [200, on],
      [`PUT ${TEAM}`]: [200, { memory_enabled: true, project_memory_enabled: false }],
    });
    renderTeam(<TeamMemoryPage />);
    await userEvent.click(await screen.findByRole("checkbox", { name: /Allow project memory/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/Project memory is off for this team/);
    expect(JSON.parse(String(must(calls.find((c) => c.method === "PUT")).body))).toEqual({
      memory_enabled: true,
      project_memory_enabled: false,
    });
  });

  it("disables the project switch while all memory is off", async () => {
    stubApi({ [`GET ${TEAM}`]: [200, { memory_enabled: false, project_memory_enabled: true }] });
    renderTeam(<TeamMemoryPage />);
    const project = await screen.findByRole("checkbox", { name: /Allow project memory/ });
    expect((project as HTMLInputElement).disabled).toBe(true);
  });

  it("shows the server's refusal", async () => {
    stubApi({
      [`GET ${TEAM}`]: [200, on],
      [`PUT ${TEAM}`]: [403, { code: "forbidden", message: "Not allowed." }],
    });
    renderTeam(<TeamMemoryPage />);
    await userEvent.click(
      await screen.findByRole("checkbox", { name: /Allow memory for this team/ }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Not allowed.");
  });
});

describe("Install memory switches (KOBE-158, ac-3)", () => {
  it("persists the install-wide switch", async () => {
    const calls = stubApi({
      [`GET ${INSTALL}`]: [200, on],
      [`PUT ${INSTALL}`]: [200, { memory_enabled: false, project_memory_enabled: true }],
    });
    renderInstall(<MemorySwitchesSection />);
    await userEvent.click(
      await screen.findByRole("checkbox", { name: /Allow memory on this install/ }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Save memory settings" }));
    await screen.findByText(/Memory is off on this install/);
    expect(JSON.parse(String(must(calls.find((c) => c.method === "PUT")).body))).toEqual({
      memory_enabled: false,
      project_memory_enabled: true,
    });
  });
});
