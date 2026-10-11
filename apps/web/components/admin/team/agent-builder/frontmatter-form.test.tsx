// @vitest-environment happy-dom
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_FORM, type FormState } from "../../../../lib/admin/agent-builder/form-model";
import { renderTeam, stubApi } from "../../testing";
import { FrontmatterForm } from "./frontmatter-form";

beforeEach(() => {
  stubApi({});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ALL_LABEL = /Use every connector the team enables/;

describe("FrontmatterForm connectors (KOBE-254)", () => {
  it("shows `connectors: all` as a ticked box with the list locked", () => {
    const form: FormState = { ...EMPTY_FORM, name: "Kobe", connectorsAll: true };
    renderTeam(<FrontmatterForm form={form} errors={{}} readOnly={false} onChange={() => {}} />);
    expect((screen.getByRole("checkbox", { name: ALL_LABEL }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect(screen.getByRole("textbox", { name: "Connectors" }).hasAttribute("readonly")).toBe(true);
  });

  it("ticking the box asks for every team connector", async () => {
    const onChange = vi.fn();
    renderTeam(
      <FrontmatterForm
        form={{ ...EMPTY_FORM, name: "A" }}
        errors={{}}
        readOnly={false}
        onChange={onChange}
      />,
    );
    expect(screen.getByRole("textbox", { name: "Connectors" }).hasAttribute("readonly")).toBe(
      false,
    );
    await userEvent.setup().click(screen.getByRole("checkbox", { name: ALL_LABEL }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ connectorsAll: true }));
  });

  it("says typed names are replaced and not saved when the box is ticked", () => {
    const form: FormState = { ...EMPTY_FORM, name: "A", connectors: "jira", connectorsAll: true };
    renderTeam(<FrontmatterForm form={form} errors={{}} readOnly={false} onChange={() => {}} />);
    expect(screen.getByRole("note").textContent).toMatch(
      /replaces the connector names listed above \(jira\); they are not saved/,
    );
  });

  it("shows no note while the box is clear", () => {
    const form: FormState = { ...EMPTY_FORM, name: "A", connectors: "jira" };
    renderTeam(<FrontmatterForm form={form} errors={{}} readOnly={false} onChange={() => {}} />);
    expect(screen.queryByRole("note")).toBeNull();
  });
});
