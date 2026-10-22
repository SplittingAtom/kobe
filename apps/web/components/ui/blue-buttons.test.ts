import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buttonVariants as chatButton } from "./button";
import { buttonVariants as consoleButton } from "./console/button";

/**
 * KOBE-479: wherever a button is blue its text and icons are white, in every state and both
 * themes. The blue fill is the accent token (`bg-status-accent`, app/theme.css), whose `-fg` is
 * white in both themes (app/theme-css.test.ts checks the values and the contrast); here: every
 * variant that paints the fill sets that text colour, and no state swaps one without the other.
 */
const BLUE_FILL = /(^|:)bg-(status-accent|console-accent)(\/\d+)?$/;
const TEXT_COLOUR = /(^|:)text-(?!(xs|sm|base|lg|xl|\d?xl|left|right|center)$)[a-z-]+(\/\d+)?$/;

/** The class list as `state:utility` pairs, the state empty for the resting look. */
function utilities(classes: string): { state: string; utility: string }[] {
  return classes
    .split(/\s+/)
    .filter(Boolean)
    .map((c) => {
      const i = c.lastIndexOf(":");
      return { state: i < 0 ? "" : c.slice(0, i), utility: i < 0 ? c : c.slice(i + 1) };
    });
}

function textColours(classes: string): string[] {
  return utilities(classes)
    .filter(({ utility }) => TEXT_COLOUR.test(utility))
    .map(({ state, utility }) => (state ? `${state}:${utility}` : utility));
}

const CONSOLE_VARIANTS = ["primary", "secondary", "danger", "ghost"] as const;
const CHAT_VARIANTS = ["default", "destructive", "outline", "secondary", "ghost", "link"] as const;

describe("blue buttons have white text (KOBE-479)", () => {
  it("the console primary button paints the accent with its white foreground, in every state", () => {
    const classes = consoleButton({ variant: "primary" });
    expect(classes).toMatch(/(^|\s)bg-status-accent(\s|$)/);
    // One text colour, unconditional: hover, focus, active, disabled and aria-pressed keep it.
    expect(textColours(classes)).toEqual(["text-status-accent-fg"]);
    for (const { state, utility } of utilities(classes)) {
      if (BLUE_FILL.test(utility)) expect(utility, state).toMatch(/^bg-status-accent(\/\d+)?$/);
    }
  });

  it("no other console variant turns blue in any state", () => {
    for (const variant of CONSOLE_VARIANTS.filter((v) => v !== "primary")) {
      const classes = consoleButton({ variant });
      for (const { utility } of utilities(classes)) expect(utility, variant).not.toMatch(BLUE_FILL);
    }
  });

  it("the chat's buttons pair every fill with its own foreground and never paint blue", () => {
    for (const variant of CHAT_VARIANTS) {
      const classes = chatButton({ variant });
      for (const { utility } of utilities(classes)) expect(utility, variant).not.toMatch(BLUE_FILL);
    }
    const primary = chatButton({ variant: "default" });
    expect(primary).toContain("bg-primary");
    expect(textColours(primary)).toEqual(["text-primary-foreground"]);
  });

  it("the chat's link colour leaves links styled as buttons alone", () => {
    // `.app a` is unlayered, so it beats every Tailwind utility: a `<Button asChild><a>` in the
    // chat would get blue text on its fill unless the rule skips button slots.
    const css = readFileSync(
      fileURLToPath(new URL("../chat/chat.module.css", import.meta.url)),
      "utf8",
    );
    expect(css).toMatch(
      /\.app a:not\(\[data-slot="button"\], \[data-slot="console-button"\]\) \{\s*color: var\(--admin-accent\);/,
    );
    expect(css).not.toMatch(/\.app a \{/);
  });
});
