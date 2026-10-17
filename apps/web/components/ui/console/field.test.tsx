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
    expect(label?.className).toMatch(/\bitems-center\b/);
    // The box keeps its size: never stretched or squeezed by the row (KOBE-283).
    expect(box.className).toMatch(/\bsize-4\b/);
    expect(box.className).toMatch(/\bshrink-0\b/);
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

describe("required and errors (review S4)", () => {
  it("a required Field marks its label and makes its control required", () => {
    render(
      <Field label="Email address" required>
        <TextInput type="email" />
      </Field>,
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.required).toBe(true);
    // The visible marker is hidden from screen readers: they hear the control's own "required".
    const mark = screen.getByText("(required)");
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    expect(mark.closest("label")?.getAttribute("for")).toBe(input.id);
  });

  it("an error is announced when it appears", () => {
    const { rerender } = render(
      <Field label="Email address">
        <TextInput />
      </Field>,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    rerender(
      <Field label="Email address" error="Enter an email address.">
        <TextInput />
      </Field>,
    );
    expect(screen.getByRole("alert").textContent).toBe("Enter an email address.");
  });

  it("a ChoiceGroup takes required (its radios) and an error (described, invalid, announced)", () => {
    render(
      <ChoiceGroup legend="Scope" required error="Pick a scope.">
        <Radio name="scope" value="team" label="Team" />
        <Radio name="scope" value="site" label="Site" />
      </ChoiceGroup>,
    );
    const group = screen.getByRole("group", { name: /Scope/ });
    expect(group.getAttribute("aria-invalid")).toBe("true");
    expect(description(group)).toBe("Pick a scope.");
    expect(screen.getByRole("alert").textContent).toBe("Pick a scope.");
    for (const radio of within(group).getAllByRole("radio") as HTMLInputElement[]) {
      expect(radio.required).toBe(true);
    }
  });

  it("checkboxes in a required group are not each required (that would demand all of them)", () => {
    render(
      <ChoiceGroup legend="Weekdays" required>
        <Checkbox label="Mon" />
        <Checkbox label="Tue" />
      </ChoiceGroup>,
    );
    for (const box of screen.getAllByRole("checkbox") as HTMLInputElement[]) {
      expect(box.required).toBe(false);
    }
  });

  it("primitive choices opt out of the legacy fieldset spacing (review S2)", () => {
    render(
      <ChoiceGroup legend="Period">
        <Radio name="p" label="30 days" />
      </ChoiceGroup>,
    );
    // The legacy rule in app/admin/admin-global.css skips labels with a data-slot.
    expect(screen.getByText("30 days").closest("label")?.dataset["slot"]).toBe(
      "console-choice-label",
    );
  });
});

describe("focus rings (review S1)", () => {
  it("every focusable primitive carries its own ring", () => {
    render(
      <>
        <TextInput aria-label="Name" />
        <Select aria-label="Role">
          <option>Member</option>
        </Select>
        <Textarea aria-label="Notes" />
        <Checkbox label="Read only" />
        <Switch label="Memory" />
      </>,
    );
    for (const el of [
      screen.getByRole("textbox", { name: "Name" }),
      screen.getByRole("combobox", { name: "Role" }),
      screen.getByRole("textbox", { name: "Notes" }),
      screen.getByRole("checkbox"),
      screen.getByRole("switch"),
    ]) {
      expect(el.className, el.tagName).toContain("focus-visible:outline-console-accent");
    }
    // Form-control boundaries use the 3:1 token (review M1), not the divider colour.
    expect(screen.getByRole("textbox", { name: "Name" }).className).toContain(
      "border-console-control",
    );
  });
});
