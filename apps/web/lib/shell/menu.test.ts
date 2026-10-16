import { describe, expect, it } from "vitest";
import { menuItems } from "./menu";

/** KOBE-292: the row menus are the registry's `thread-menu` / `file-menu` commands a row binds. */
describe("menuItems", () => {
  const noop = () => {};

  it("lists the bound commands of a menu in registry order, with the registry's names", () => {
    const items = menuItems("thread-menu", {
      "trash-thread": { onSelect: noop },
      "copy-thread": { onSelect: noop },
      "regenerate-thread": { onSelect: noop, blocker: "Wait for the current run to finish." },
      "regenerate-thread-with": { choices: [] },
    });
    expect(items.map((i) => [i.command.id, i.label])).toEqual([
      ["copy-thread", "Copy"],
      ["regenerate-thread", "Regenerate"],
      ["regenerate-thread-with", "Regenerate with"],
      ["trash-thread", "Delete"],
    ]);
    expect(items[1]?.blocker).toBe("Wait for the current run to finish.");
  });

  it("leaves out what the row does not bind, and commands of other scopes", () => {
    const items = menuItems("file-menu", {
      "download-file": { onSelect: noop },
      "delete-file": { onSelect: noop, label: "Delete folder" },
      "copy-thread": { onSelect: noop },
    });
    expect(items.map((i) => [i.command.id, i.label])).toEqual([
      ["download-file", "Download"],
      ["delete-file", "Delete folder"],
    ]);
  });

  it("orders the file menu Open, Download, Copy path, Delete", () => {
    const all = { onSelect: noop };
    const items = menuItems("file-menu", {
      "delete-file": all,
      "copy-file-path": all,
      "open-file": all,
      "download-file": all,
    });
    expect(items.map((i) => i.label)).toEqual(["Open", "Download", "Copy path", "Delete"]);
  });
});
