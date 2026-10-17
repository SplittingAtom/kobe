// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Field, FormRow } from "./field";
import { Checkbox, ChoiceGroup, Radio, Select, Switch, Textarea, TextInput } from "./inputs";

/** KOBE-294 (ac-2): form fields and controls, labelled and described for assistive tech. */
afterEach(cleanup);

/** The text of the elements `el`'s aria-describedby points at. */
function description(el: HTMLElement): string {
  return (el.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? `<missing ${id}>`)
    .join(" | ");
}

describe("Field", () => {
  it("labels its control and describes it with the hint and the error", () => {
    render(
      <FormRow>
        <Field label="Email address" hint="Their work address." error="Enter an email address.">
          <TextInput type="email" />
        </Field>
      </FormRow>,
    );
    const input = screen.getByLabelText("Email address");
    expect(input.tagName).toBe("INPUT");
    expect(description(input)).toBe("Their work address. | Enter an email address.");
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  it("without an error the control is not invalid and only the hint describes it", () => {
    render(
      <Field label="Notes" hint="Shown to members.">
        <Textarea />
      </Field>,
    );
    const area = screen.getByLabelText("Notes");
    expect(area.tagName).toBe("TEXTAREA");
    expect(area.hasAttribute("aria-invalid")).toBe(false);
    expect(description(area)).toBe("Shown to members.");
  });

  it("takes the Field's id, and keeps the control's own description", () => {
    render(
      <>
        <p id="extra">Extra.</p>
        <Field id="role" label="Role" hint="What they may do.">
          <Select aria-describedby="extra">
            <option value="member">Member</option>
          </Select>
        </Field>
      </>,
    );
    const select = screen.getByLabelText("Role");
    expect(select.id).toBe("role");
    expect(select.tagName).toBe("SELECT");
    expect(description(select)).toBe("Extra. | What they may do.");
  });

  it("controls outside a Field take no field props", () => {
    render(<TextInput aria-label="Search" />);
    const input = screen.getByRole("textbox", { name: "Search" });
    expect(input.hasAttribute("aria-describedby")).toBe(false);
    expect(input.hasAttribute("aria-invalid")).toBe(false);
  });
});

describe("choices (KOBE-283: inline before their text)", () => {
  it("a checkbox sits in its label before the text, described by its hint", async () => {
    const onChange = vi.fn();
    render(<Checkbox label="Read only" hint="Members can't change it." onChange={onChange} />);
    const box = screen.getByRole("checkbox", { name: "Read only" });
    const label = box.closest("label");
    expect(label?.firstElementChild).toBe(box);
    expect(label?.className).toContain("inline-flex");
    expect(label?.className).not.toMatch(/flex-col|block/);
    expect(description(box)).toBe("Members can't change it.");
    await userEvent.click(screen.getByText("Read only"));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("radios in a group are named by its legend and pick one", async () => {
    function Period() {
      const [days, setDays] = useState("30");
      return (
        <ChoiceGroup legend="Keep threads for" hint="Older threads are deleted.">
          {["30", "90"].map((d) => (
            <Radio
              key={d}
              name="days"
              value={d}
              label={`${d} days`}
              checked={days === d}
              onChange={() => setDays(d)}
            />
          ))}
        </ChoiceGroup>
      );
    }
    render(<Period />);
    const group = screen.getByRole("group", { name: "Keep threads for" });
    expect(description(group)).toBe("Older threads are deleted.");
    const [thirty, ninety] = within(group).getAllByRole("radio") as HTMLInputElement[];
    expect(thirty?.checked).toBe(true);
    await userEvent.click(within(group).getByLabelText("90 days"));
    expect(ninety?.checked).toBe(true);
    expect(thirty?.checked).toBe(false);
  });
});

describe("Switch", () => {
  it("is a switch named by its label, described by its hint, and toggles", async () => {
    const onCheckedChange = vi.fn();
    render(
      <Switch
        label="Memory"
        hint="Agents may remember facts."
        defaultChecked={false}
        onCheckedChange={onCheckedChange}
      />,
    );
    const sw = screen.getByRole("switch", { name: "Memory" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(description(sw)).toBe("Agents may remember facts.");
    await userEvent.click(sw);
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    // The label toggles it too.
    await userEvent.click(screen.getByText("Memory"));
    expect(sw.getAttribute("aria-checked")).toBe("false");
  });
});
